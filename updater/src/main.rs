#![windows_subsystem = "windows"]

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
struct UpdateInstructions {
    gui_exe_src: String,
    install_dir: String,
    #[serde(default)]
    files: Vec<FileCopyInstruction>,
    #[serde(default)]
    env_ops: Vec<EnvOp>,
}

#[derive(Deserialize)]
struct FileCopyInstruction {
    src: String,
    dst: String,
}

/// 环境变量系统级(HKLM)修复指令 — 与 GUI diagnostics.rs 的 env_ops serde 对齐。
/// Set:      reg add HKLM\SYSTEM\...\Environment (REG_EXPAND_SZ 若 expand)
/// Delete:   reg delete HKLM (服务自有的值清理)
/// DeleteUser: reg delete HKCU\Environment — 清理用户级残留(不写用户级)
/// SetUserPath: reg add HKCU\Environment PATH 移除安装条目后的值
/// DeleteUserPath: reg delete HKCU\Environment PATH
#[derive(Debug, Deserialize)]
#[serde(tag = "op")]
enum EnvOp {
    Set { name: String, value: String, expand: bool },
    Delete { name: String },
    DeleteUser { name: String },
    SetUserPath { value: String },
    DeleteUserPath,
}

fn main() {
    let instructions_path = std::env::temp_dir().join("claude-update.json");

    let instructions: UpdateInstructions = match std::fs::read_to_string(&instructions_path) {
        Ok(json) => match serde_json::from_str(&json) {
            Ok(i) => i,
            Err(e) => {
                log_error(&format!("Failed to parse update instructions: {}", e));
                return;
            }
        },
        Err(e) => {
            log_error(&format!("No update instructions found: {}", e));
            return;
        }
    };

    // ── Environment variable fix (HKLM, elevated) — runs alone or before GUI —─
    // These run WITHOUT touching GUI processes: the caller leaves gui_exe_src
    // empty for env-only ops, so Update.exe neither taskkills nor relaunches.
    if !instructions.env_ops.is_empty() {
        let mut any_failed = false;
        for op in &instructions.env_ops {
            match execute_env_op(op) {
                Ok(()) => {}
                Err(e) => {
                    any_failed = true;
                    log_error(&format!("env op failed: {:?} — {}", op, e));
                }
            }
        }
        if any_failed {
            log_error("Some env ops failed — see errors above");
        } else {
            // Success — broadcast so new processes pick up the machine env.
            broadcast_env_change();
        }
        // env-only: instructions have gui_exe_src empty → skip GUI work below.
        if instructions.gui_exe_src.is_empty() {
            let _ = std::fs::remove_file(&instructions_path);
            return;
        }
    }

    let has_gui = !instructions.gui_exe_src.is_empty();

    if has_gui {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            // Kill ALL GUI instances — the launcher already exits itself, but any
            // other open instances would hold the exe lock (rename fails) and keep
            // running stale code after the update.
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/IM", "claude-code-gui.exe"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
            // Force-killing the GUIs orphans their IDE backends. Kill only
            // --ide-mode claude.exe (GUI backends) — the user's terminal TUI
            // runs claude.exe without --ide-mode and must survive.
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command",
                    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.CommandLine -match '--ide-mode' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        // Wait for processes to fully exit + release file locks
        std::thread::sleep(std::time::Duration::from_secs(3));

        let gui_src = PathBuf::from(&instructions.gui_exe_src);
        let gui_dst = PathBuf::from(&instructions.install_dir).join("claude-code-gui.exe");

        if gui_src.exists() {
            let mut replaced = false;
            for attempt in 0..10 {
                if attempt > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                let old = gui_dst.with_extension("exe.old");
                let _ = std::fs::remove_file(&old);
                if std::fs::rename(&gui_dst, &old).is_ok() {
                    if std::fs::copy(&gui_src, &gui_dst).is_ok() {
                        let _ = std::fs::remove_file(&old);
                        replaced = true;
                        break;
                    } else {
                        let _ = std::fs::rename(&old, &gui_dst);
                    }
                }
            }
            if !replaced {
                log_error("Failed to replace GUI exe after 10 attempts");
            }
            let _ = std::fs::remove_file(&gui_src);
        } else {
            log_error(&format!("New GUI exe not found: {}", gui_src.display()));
        }
    }

    // Copy additional files (always runs — also for non-GUI updates)
    for fc in &instructions.files {
        let src = PathBuf::from(&fc.src);
        let dst = PathBuf::from(&fc.dst);
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if src.is_dir() {
            if dst.exists() {
                let backup = dst.with_extension("dir.old");
                let _ = std::fs::remove_dir_all(&backup);
                let _ = std::fs::rename(&dst, &backup);
            }
            copy_dir_recursive(&src, &dst);
            // Clean up backup and temp
            let _ = std::fs::remove_dir_all(&dst.with_extension("dir.old"));
            let _ = std::fs::remove_dir_all(&src);
        } else if src.is_file() {
            if dst.exists() {
                let backup = dst.with_extension("old");
                let _ = std::fs::remove_file(&backup);
                let _ = std::fs::rename(&dst, &backup);
            }
            let _ = std::fs::copy(&src, &dst);
            let _ = std::fs::remove_file(&dst.with_extension("old"));
            let _ = std::fs::remove_file(&src);
        }
    }

    // Launch the new GUI only if we replaced it
    if has_gui {
        let new_gui = PathBuf::from(&instructions.install_dir).join("claude-code-gui.exe");
        if new_gui.exists() {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                let _ = std::process::Command::new(&new_gui)
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new(&new_gui).spawn();
            }
        }
    }

    // Clean up instructions file
    let _ = std::fs::remove_file(&instructions_path);
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) {
    let _ = std::fs::create_dir_all(dst);
    if let Ok(entries) = std::fs::read_dir(src) {
        for entry in entries.flatten() {
            let path = entry.path();
            let dest = dst.join(path.file_name().unwrap());
            if path.is_dir() {
                copy_dir_recursive(&path, &dest);
            } else {
                let _ = std::fs::copy(&path, &dest);
            }
        }
    }
}

fn execute_env_op(op: &EnvOp) -> Result<(), String> {
    const HKLM_ENV: &str = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
    const HKCU_ENV: &str = "HKCU\\Environment";
    match op {
        EnvOp::Set { name, value, expand } => {
            let ty = if *expand { "REG_EXPAND_SZ" } else { "REG_SZ" };
            run_reg(&["add", HKLM_ENV, "/v", name, "/t", ty, "/d", value, "/f"])
        }
        EnvOp::Delete { name } => run_reg(&["delete", HKLM_ENV, "/v", name, "/f"]),
        EnvOp::DeleteUser { name } => run_reg(&["delete", HKCU_ENV, "/v", name, "/f"]),
        EnvOp::SetUserPath { value } => {
            run_reg(&["add", HKCU_ENV, "/v", "PATH", "/t", "REG_EXPAND_SZ", "/d", value, "/f"])
        }
        EnvOp::DeleteUserPath => run_reg(&["delete", HKCU_ENV, "/v", "PATH", "/f"]),
    }
}

fn run_reg(args: &[&str]) -> Result<(), String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = std::process::Command::new("reg");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .args(args)
        .output()
        .map_err(|e| format!("reg launch failed: {}", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Broadcast WM_SETTINGCHANGE("Environment") so already-running processes pick
/// up the new machine environment without a full reboot.
fn broadcast_env_change() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // PowerShell Add-Type with DllImport must not be inlined with -Command
        // (nested quotes / "# parsing pain) — write a temp .ps1 instead.
        let script = [
            "Add-Type -TypeDefinition 'using System;",
            "using System.Runtime.InteropServices;",
            "public class EnvBroadcast {",
            r#"  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]"#,
            r#"  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);"#,
            "}';",
            "$r = [UIntPtr]::Zero",
            "[EnvBroadcast]::SendMessageTimeout([IntPtr] 0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$r) | Out-Null",
        ]
        .join("\n");
        let ps = std::env::temp_dir().join("claude-env-broadcast.ps1");
        let _ = std::fs::write(&ps, &script);
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&ps)
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        let _ = std::fs::remove_file(&ps);
    }
}

fn log_error(msg: &str) {
    let log_path = std::env::temp_dir().join("claude-update-error.log");
    let existing = std::fs::read_to_string(&log_path).unwrap_or_default();
    let _ = std::fs::write(&log_path, format!("{}{}\n", existing, msg));
}
