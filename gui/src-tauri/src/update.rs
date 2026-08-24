/// Update system — manifest management, hash/timestamp comparison, download & install.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ── Types ──

#[derive(Debug, Deserialize)]
pub struct RemoteManifest {
    pub version: String,
    #[serde(default)]
    pub release_notes: String,
    #[serde(default)]
    pub published_at: String,
    pub components: HashMap<String, ComponentInfo>,
}

/// Info for a single component from the remote manifest.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ComponentInfo {
    Exe {
        sha256: String,
        size: u64,
        #[serde(default)]
        post_install: Option<PostInstallHook>,
    },
    /// Directory component — sha256 is a metadata hash (relative_path:size pairs).
    /// Compare locally with the same algorithm; ignore if file content-only changes.
    Dir {
        sha256: String,
        size: u64,
        #[serde(default)]
        post_install: Option<PostInstallHook>,
    },
}

/// Optional hook executed after a component is installed.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum PostInstallHook {
    /// Run a script shipped inside the component zip.
    #[serde(rename = "script")]
    Script {
        path: String,
        #[serde(default)]
        description: String,
    },
    /// Run a shell command directly (for env vars, registry, etc.).
    #[serde(rename = "command")]
    Command {
        run: String,
        #[serde(default)]
        description: String,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalManifest {
    pub version: String,
    pub components: HashMap<String, LocalComponentInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalComponentInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ComponentUpdateStatus {
    pub name: String,
    pub installed: bool,
    pub needs_update: bool,
    pub remote_sha256: Option<String>,
    pub local_sha256: Option<String>,
    pub remote_updated_at: Option<String>,
    pub local_updated_at: Option<String>,
    pub size: Option<u64>,
    /// If set, this component has a post-install hook that will run after download+install.
    pub post_install_description: Option<String>,
    /// Full hook JSON — pass back to download_and_install_component.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_install_json: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UpdateCheckResult {
    pub version: String,
    pub release_notes: String,
    pub published_at: String,
    pub components: Vec<ComponentUpdateStatus>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateInstructions {
    pub gui_exe_src: String,
    pub install_dir: String,
    pub files: Vec<FileCopyInstruction>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileCopyInstruction {
    pub src: String,
    pub dst: String,
}

// ── Paths ──

pub fn get_install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn local_manifest_path() -> PathBuf {
    get_install_dir().join("manifest.json")
}

/// Build an updated manifest.json string with the new component hash.
/// Returns None if local manifest doesn't exist or is unreadable.
fn build_updated_manifest(component_name: &str, new_sha256: &str, new_size: u64) -> Option<String> {
    let path = local_manifest_path();
    let Ok(json) = std::fs::read_to_string(&path) else { return None };
    let mut manifest: serde_json::Value = serde_json::from_str(&json).ok()?;
    if let Some(comps) = manifest["components"].as_object_mut() {
        // Upsert — a newly-published component (e.g. updater) isn't in the local
        // manifest yet; only updating existing keys would never record it, so
        // check_for_updates keeps reporting "update available" forever.
        let comp = comps
            .entry(component_name.to_string())
            .or_insert_with(|| serde_json::json!({}));
        comp["sha256"] = serde_json::Value::String(new_sha256.to_string());
        comp["size"] = serde_json::Value::Number(serde_json::Number::from(new_size));
    }
    serde_json::to_string_pretty(&manifest).ok()
}

/// Write updated manifest directly (for user-directory installs where we have write access).
fn write_local_manifest(component_name: &str, new_sha256: &str, new_size: u64) {
    if let Some(json) = build_updated_manifest(component_name, new_sha256, new_size) {
        let _ = std::fs::write(local_manifest_path(), &json);
    }
}

/// Try to install directly (no admin). Returns Ok(()) or Err with detail.
/// 目录组件（python/tools/git/extensions）：合并覆盖——新文件覆盖旧同名，用户额外文件
/// （如 python site-packages 里 pip 装的库）保留。旧实现 remove_dir_all 清空再复制，
/// python 更新会把用户后来装的库全删。与 stager(Update.exe 逐文件合并)行为对齐。
fn try_install(temp_dir: &std::path::Path, dst: &std::path::Path, _install_dir: &std::path::Path) -> Result<(), String> {
    if dst.exists() && dst.is_dir() {
        crate::copy_dir_recursive(temp_dir, dst)
            .map_err(|e| format!("Cannot copy to {}: PermissionDenied={}", dst.display(), e.kind() == std::io::ErrorKind::PermissionDenied))?;
    } else {
        // Single file
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create parent: PermissionDenied={}", e.kind() == std::io::ErrorKind::PermissionDenied))?;
        }
        // Find the single file in temp_dir
        let src = walkdir_find_first_file(temp_dir)
            .ok_or_else(|| format!("No file found in {}", temp_dir.display()))?;
        std::fs::copy(&src, dst)
            .map_err(|e| format!("Cannot copy to {}: PermissionDenied={}", dst.display(), e.kind() == std::io::ErrorKind::PermissionDenied))?;
    }
    Ok(())
}

/// Find the first regular file walking a directory tree.
fn walkdir_find_first_file(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walkdir_find_first_file(&path) {
                    return Some(found);
                }
            } else if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// Collect all files from temp_dir into a flat Vec for Update.exe instructions.
fn collect_update_files(temp_dir: &std::path::Path) -> Vec<FileCopyInstruction> {
    let mut files = Vec::new();
    collect_files_recursive(temp_dir, temp_dir, &mut files);
    files
}

fn collect_files_recursive(
    base: &std::path::Path,
    dir: &std::path::Path,
    files: &mut Vec<FileCopyInstruction>,
) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(base).unwrap_or(&path);
            if path.is_dir() {
                collect_files_recursive(base, &path, files);
            } else {
                files.push(FileCopyInstruction {
                    src: path.to_string_lossy().to_string(),
                    dst: rel.to_string_lossy().to_string(),
                });
            }
        }
    }
}

/// Write update instructions and launch Update.exe (admin via RunAs).
/// new_sha256/new_size: if provided, also update the local manifest via Update.exe.
fn install_via_stager(
    temp_dir: &std::path::Path,
    dst: &std::path::Path,
    install_dir: &std::path::Path,
    component_name: &str,
    new_sha256: Option<&str>,
    new_size: Option<u64>,
) -> Result<(), String> {
    use serde::Serialize;
    #[derive(Serialize)]
    struct StagerInstructions {
        #[serde(rename = "gui_exe_src")]
        gui_exe_src: String,
        #[serde(rename = "install_dir")]
        install_dir: String,
        files: Vec<StagerFile>,
    }
    #[derive(Serialize)]
    struct StagerFile {
        src: String,
        dst: String,
    }

    let dst_str = dst.to_string_lossy().to_string();
    let install_dir_str = install_dir.to_string_lossy().to_string();

    let mut stager_files: Vec<StagerFile> = if dst_str.ends_with(".exe") {
        // Single exe component
        let src = walkdir_find_first_file(temp_dir)
            .ok_or_else(|| format!("No exe found in {}", temp_dir.display()))?;
        vec![StagerFile {
            src: src.to_string_lossy().to_string(),
            dst: dst_str,
        }]
    } else {
        // Directory component — each file gets its own instruction
        let raw = collect_update_files(temp_dir);
        raw.into_iter().map(|f| StagerFile {
            src: f.src,
            dst: format!("{}/{}", dst_str, f.dst),
        }).collect()
    };

    // If we have new hash info, write updated manifest to temp and let Update.exe copy it in.
    // (Direct write to Program Files would fail with PermissionDenied.)
    if let (Some(sha), Some(size)) = (new_sha256, new_size) {
        if let Some(manifest_json) = build_updated_manifest(component_name, sha, size) {
            let tmp_manifest = std::env::temp_dir().join("claude-manifest-update.json");
            if std::fs::write(&tmp_manifest, &manifest_json).is_ok() {
                stager_files.push(StagerFile {
                    src: tmp_manifest.to_string_lossy().to_string(),
                    dst: local_manifest_path().to_string_lossy().to_string(),
                });
            }
        }
    }

    let instructions = StagerInstructions {
        gui_exe_src: String::new(), // empty = no GUI replacement
        install_dir: install_dir_str,
        files: stager_files,
    };

    let json = serde_json::to_string_pretty(&instructions)
        .map_err(|e| format!("Cannot serialize update instructions: {}", e))?;
    let instructions_path = std::env::temp_dir().join("claude-update.json");
    std::fs::write(&instructions_path, &json)
        .map_err(|e| format!("Cannot write update instructions: {}", e))?;

    // Launch Update.exe — its embedded manifest triggers UAC elevation
    let updater_path = install_dir.join("Update.exe");
    if !updater_path.exists() {
        return Err(format!(
            "Update.exe not found at {}. Reinstall required.",
            updater_path.display()
        ));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // ShellExecute("runas") triggers UAC. -Wait blocks PS until Update.exe exits.
        // CREATE_NO_WINDOW stops the launcher PowerShell from flashing a console.
        let status = std::process::Command::new("powershell")
            .args(&[
                "-NoProfile",
                "-Command",
                &format!(
                    "Start-Process -FilePath '{}' -Verb RunAs -WindowStyle Hidden -Wait",
                    updater_path.display()
                ),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("Cannot launch updater: {}", e))?;
        if !status.success() {
            return Err(format!("Update.exe exited with code {:?}", status.code()));
        }
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(&updater_path)
            .spawn()
            .map_err(|e| format!("Cannot launch updater: {}", e))?;
    }

    // Note: PS -Wait will block this thread until Update.exe completes.
    // After it returns, files are installed. The temp dir cleanup below
    // will remove the already-copied temp files.

    log::info!("{} stager completed (admin)", component_name);
    Ok(())
}

/// macOS 提权安装：无 Update.exe stager，用 osascript `do shell script … with
/// administrator privileges` 弹系统授权框，以 ditto 复制组件到位。
/// claude 是单文件二进制（temp 里第一个文件）；extensions 是目录（temp 整体复制）。
#[cfg(not(windows))]
fn install_via_elevated_mac(
    temp_dir: &std::path::Path,
    dst: &std::path::Path,
    component_name: &str,
    new_sha256: Option<&str>,
    new_size: Option<u64>,
) -> Result<(), String> {
    // AppleScript 字符串字面量转义：`"` → `\"`、`\` → `\\`（路径里单引号罕见，用 ' 包裹）。
    fn esc(s: &str) -> String {
        s.replace('\\', "\\\\").replace('"', "\\\"")
    }
    let src: std::path::PathBuf = match component_name {
        "claude" => walkdir_find_first_file(temp_dir)
            .ok_or_else(|| format!("No file found in {}", temp_dir.display()))?,
        _ => temp_dir.to_path_buf(),
    };
    let sh = format!(
        "ditto '{}' '{}'",
        esc(&src.to_string_lossy()),
        esc(&dst.to_string_lossy())
    );
    let script = format!("do shell script \"{}\" with administrator privileges", sh);
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .status()
        .map_err(|e| format!("Cannot elevate install: {}", e))?;
    if !status.success() {
        return Err(format!("Elevated install failed (code {:?})", status.code()));
    }
    if let (Some(sha), Some(size)) = (new_sha256, new_size) {
        if let Some(m) = build_updated_manifest(component_name, sha, size) {
            let _ = std::fs::write(local_manifest_path(), &m);
        }
    }
    log::info!("{} updated (elevated via osascript)", component_name);
    Ok(())
}

/// 提权执行环境变量修复（更新改 HKLM + 清理 HKCU）。
/// 复用 claude-update.json + Update.exe RunAs（其环境变量 ops 在 updater 内单独执行，
/// 不触碰 GUI 进程）。gui_exe_src 留空 → Update.exe 不 taskkill / 不重启 GUI。
/// UAC 被拒/取消 → PowerShell Start-Process -Verb RunAs 返回非 0 → 报错。
pub fn run_env_ops_elevated(ops: Vec<crate::diagnostics::EnvOp>) -> Result<(), String> {
    use serde_json::json;

    let install_dir = get_install_dir();
    let updater_path = install_dir.join("Update.exe");
    if !updater_path.exists() {
        return Err("Update.exe not found — 无法提权执行环境变量修复".to_string());
    }

    let instructions = json!({
        "gui_exe_src": "",
        "install_dir": updater_path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "files": [],
        "env_ops": ops,
    });
    let json_str = serde_json::to_string_pretty(&instructions)
        .map_err(|e| format!("Cannot serialize env ops: {}", e))?;
    let instructions_path = std::env::temp_dir().join("claude-update.json");
    std::fs::write(&instructions_path, &json_str)
        .map_err(|e| format!("Cannot write update instructions: {}", e))?;

    // Launch Update.exe — its embedded manifest triggers UAC elevation
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let status = std::process::Command::new("powershell")
            .args(&[
                "-NoProfile",
                "-Command",
                &format!(
                    "Start-Process -FilePath '{}' -Verb RunAs -WindowStyle Hidden -Wait",
                    updater_path.display()
                ),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("Cannot launch updater: {}", e))?;
        if !status.success() {
            return Err("环境变量修复需系统级权限，但授权被取消或失败(UAC 拒绝)".to_string());
        }
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(&updater_path)
            .spawn()
            .map_err(|e| format!("Cannot launch updater: {}", e))?;
    }

    Ok(())
}

// ── Local manifest I/O ──

pub fn read_local_manifest() -> Option<LocalManifest> {
    let path = local_manifest_path();
    if !path.exists() {
        return None;
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

// ── Component path resolution ──

/// 当前平台标识（"windows" / "macos"）。macOS 移植：组件产物路径按平台分叉。
fn platform_str() -> &'static str {
    if cfg!(target_os = "windows") { "windows" } else { "macos" }
}

/// 组件产物相对安装目录的路径（纯函数，不查文件存在）——平台参数化以便单测锁定
/// mac 分支。决策表与 scripts/componentPlan.ts 一致：
///   mac 上 bun/tools/python 自包含（可安装）、git 用系统自带(无安装产物)、
///   updater 专属 Windows。
fn component_artifact_path(install: &Path, name: &str, platform: &str) -> Option<PathBuf> {
    let is_win = platform == "windows";
    let rel = match name {
        "gui" => if is_win { "claude-code-gui.exe" } else { "Claude Code.app" },
        "claude" => if is_win { "claude.exe" } else { "claude" },
        "bun" => if is_win { "bun.exe" } else { "bun" },
        "tools" => "bin",
        "python" => "python",
        "git" => if is_win { "git" } else { return None },
        "extensions" => "extensions",
        "updater" => if is_win { "Update.exe" } else { return None },
        _ => return None,
    };
    Some(install.join(rel))
}

fn get_component_path(name: &str) -> Option<PathBuf> {
    let install = get_install_dir();
    let path = component_artifact_path(&install, name, platform_str())?;
    if path.exists() { Some(path) } else { None }
}

/// Find a file by name walking a directory tree.
fn walkdir_find(dir: &std::path::Path, filename: &str) -> Option<PathBuf> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walkdir_find(&path, filename) {
                    return Some(found);
                }
            } else if path.file_name().map(|n| n == filename).unwrap_or(false) {
                return Some(path);
            }
        }
    }
    None
}

// ── Post-install hooks ──

fn hook_description(hook: &PostInstallHook) -> String {
    match hook {
        PostInstallHook::Script { description, path, .. } => {
            if description.is_empty() { format!("Run script: {}", path) }
            else { description.clone() }
        }
        PostInstallHook::Command { description, run, .. } => {
            if description.is_empty() { format!("Run: {}", run) }
            else { description.clone() }
        }
    }
}

/// Execute a post-install hook. The component's zip has already been extracted
/// to `install_dir` (or temp_dir for exe components).
fn execute_post_install(hook: &PostInstallHook, work_dir: &std::path::Path) -> Result<(), String> {
    match hook {
        PostInstallHook::Script { path, .. } => {
            let script_path = work_dir.join(path);
            if !script_path.exists() {
                return Err(format!("Post-install script not found: {}", script_path.display()));
            }
            log::info!("Running post-install script: {}", script_path.display());
            #[cfg(windows)]
            use std::os::windows::process::CommandExt;
            #[cfg(windows)]
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let mut cmd = std::process::Command::new("cmd");
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let output = cmd
                .args(["/c", &script_path.to_string_lossy()])
                .current_dir(work_dir)
                .output()
                .map_err(|e| format!("Failed to run post-install script: {}", e))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log::warn!("Post-install script exited with {}: {}", output.status, stderr);
                return Err(format!("Post-install script failed: {}", stderr));
            }
            log::info!("Post-install script completed successfully");
            Ok(())
        }
        PostInstallHook::Command { run, .. } => {
            log::info!("Running post-install command: {}", run);
            #[cfg(windows)]
            use std::os::windows::process::CommandExt;
            #[cfg(windows)]
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let mut cmd = std::process::Command::new("cmd");
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let output = cmd
                .args(["/c", run])
                .output()
                .map_err(|e| format!("Failed to run post-install command: {}", e))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log::warn!("Post-install command exited with {}: {}", output.status, stderr);
                return Err(format!("Post-install command failed: {}", stderr));
            }
            log::info!("Post-install command completed successfully");
            Ok(())
        }
    }
}

// ── Tauri Commands ──

#[tauri::command]
pub async fn check_for_updates(base_url: String) -> Result<UpdateCheckResult, String> {
    let url = format!(
        "{}/api/updates/latest",
        base_url.trim_end_matches('/')
    );
    // Run blocking HTTP on a separate thread — Tauri sync commands block the main thread
    let (tx, rx) = std::sync::mpsc::channel();
    let url_clone = url.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
            let response = client.get(&url_clone).send()
                .map_err(|e| format!("Failed to connect to {}: {}. Try setting --proxy off or check firewall.", &url_clone, e))?;
            if !response.status().is_success() {
                return Err(format!("Server returned {}", response.status()));
            }
            response.text().map_err(|e| format!("Failed to read response: {}", e))
        })();
        let _ = tx.send(result);
    });
    let body_text = rx.recv().map_err(|e| format!("Update check panicked: {}", e))??;
    let body: serde_json::Value =
        serde_json::from_str(&body_text).map_err(|e| format!("Invalid JSON: {}", e))?;
    let manifest: RemoteManifest = serde_json::from_value(
        body.get("data").cloned().unwrap_or_default(),
    )
    .map_err(|e| format!("Invalid manifest: {}", e))?;

    // Read local manifest for comparison (installed at build time by setup)
    let local: Option<LocalManifest> = std::fs::read_to_string(local_manifest_path())
        .ok()
        .and_then(|j| serde_json::from_str(&j).ok());

    let mut components = Vec::new();

    // Iterate the REMOTE manifest directly — no hardcoded component list, so a
    // newly-published component (e.g. updater) shows up without a client rebuild.
    for (name, info) in &manifest.components {
        let (remote_sha, remote_size, desc, hook_json) = match info {
            ComponentInfo::Exe { sha256, size, post_install } => {
                let d = post_install.as_ref().map(hook_description);
                let h = post_install.as_ref().and_then(|h| serde_json::to_string(h).ok());
                (sha256.clone(), *size, d, h)
            }
            ComponentInfo::Dir { sha256, size, post_install } => {
                let d = post_install.as_ref().map(hook_description);
                let h = post_install.as_ref().and_then(|h| serde_json::to_string(h).ok());
                (sha256.clone(), *size, d, h)
            }
        };

        let installed = get_component_path(name).is_some();
        // Compare against local manifest JSON — no filesystem hash computation.
        // After installation, update_local_manifest writes the server hash locally.
        let local_sha = local.as_ref()
            .and_then(|m| m.components.get(name))
            .and_then(|c| c.sha256.clone());
        let needs_update = !installed || local_sha.as_ref() != Some(&remote_sha);

        components.push(ComponentUpdateStatus {
            name: name.to_string(),
            installed,
            needs_update,
            remote_sha256: Some(remote_sha),
            local_sha256: local_sha,
            remote_updated_at: None,
            local_updated_at: None,
            size: Some(remote_size),
            post_install_description: desc,
            post_install_json: hook_json,
        });
    }

    Ok(UpdateCheckResult {
        version: manifest.version,
        release_notes: manifest.release_notes,
        published_at: manifest.published_at,
        components,
    })
}

#[tauri::command]
pub async fn download_and_install_component(
    component_name: String,
    download_url: String,
    post_install_json: Option<String>,
    new_sha256: Option<String>,
    new_size: Option<u64>,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
    let result = (|| -> Result<(), String> {
    let install_dir = get_install_dir();
    let temp_dir = std::env::temp_dir().join(format!("claude-update-{}", component_name));

    let hook: Option<PostInstallHook> = post_install_json
        .filter(|s| !s.is_empty())
        .map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(|e| format!("Invalid post_install JSON: {}", e))?;

    crate::download_and_extract(&download_url, &temp_dir)?;

    let result = match component_name.as_str() {
        "gui" => {
            // GUI update is handled by prepare_gui_update + launch_updater_and_exit.
            // download_and_install_component for "gui" only downloads the zip
            // for inspection; the actual install uses the stager.
            let _ = std::fs::remove_dir_all(&temp_dir);
            Ok(())
        }
        _ => {
            // 平台化目标路径：mac 上 claude 无 .exe 后缀；bun/tools/python/git/updater
            // 用系统自带（无安装产物，plan=system/skip）→ 不可安装直接报错。
            let dst = component_artifact_path(&install_dir, &component_name, platform_str())
                .ok_or_else(|| {
                    format!(
                        "Component {} is not installable on {}",
                        component_name,
                        platform_str()
                    )
                })?;

            // Try direct write first (works for user-directory installs).
            // On PermissionDenied, delegate to Update.exe which runs elevated.
            match try_install(&temp_dir, &dst, &install_dir) {
                Ok(()) => {
                    if let (Some(ref sha), Some(size)) = (&new_sha256, new_size) {
                        write_local_manifest(&component_name, sha, size);
                    }
                    log::info!("{} updated (direct)", component_name);
                    Ok(())
                }
                Err(e) if e.contains("PermissionDenied") => {
                    #[cfg(windows)]
                    {
                        // Delegate to Update.exe — it handles file copy + manifest update.
                        install_via_stager(
                            &temp_dir, &dst, &install_dir, &component_name,
                            new_sha256.as_deref(), new_size,
                        )?;
                        log::info!("{} updated (via stager)", component_name);
                        Ok(())
                    }
                    #[cfg(not(windows))]
                    {
                        // macOS 无 Update.exe：osascript 弹授权 + ditto 提权复制。
                        install_via_elevated_mac(
                            &temp_dir, &dst, &component_name,
                            new_sha256.as_deref(), new_size,
                        )?;
                        Ok(())
                    }
                }
                Err(e) => Err(e),
            }
        }
    };

    // Execute post-install hook (if any)
    if result.is_ok() {
        if let Some(ref h) = hook {
            let work_dir = match component_name.as_str() {
                "gui" | "claude" | "bun" | "updater" => get_install_dir(),
                "tools" => get_install_dir().join("bin"),
                _ => get_install_dir().join(&component_name),
            };
            if let Err(e) = execute_post_install(h, &work_dir) {
                log::error!("Post-install hook failed for {}: {}", component_name, e);
                // Don't fail the install — hook errors are non-fatal
            }
        }
    }

    result
    })();
    let _ = tx.send(result);
    });
    rx.recv().map_err(|e| format!("Install panicked: {}", e))?
}

#[tauri::command]
pub async fn prepare_gui_update(
    download_url: String,
    new_sha256: Option<String>,
    new_size: Option<u64>,
) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        // macOS：无 Update.exe stager，直接下载并替换 .app，返回空串（launch 阶段跳过退出重启）。
        return prepare_gui_update_mac(&download_url, new_sha256, new_size);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
    let result = (|| -> Result<String, String> {
    let install_dir = get_install_dir();
    let temp_dir = std::env::temp_dir().join("claude-update-gui");

    crate::download_and_extract(&download_url, &temp_dir)?;

    let new_exe = temp_dir.join("claude-code-gui.exe");
    if !new_exe.exists() {
        let found = walkdir_find(&temp_dir, "claude-code-gui.exe")
            .ok_or("New GUI exe not found in downloaded zip")?;
        let dest = std::env::temp_dir().join("claude-new-gui.exe");
        std::fs::copy(&found, &dest)
            .map_err(|e| format!("Cannot copy GUI exe: {}", e))?;
    } else {
        let dest = std::env::temp_dir().join("claude-new-gui.exe");
        std::fs::copy(&new_exe, &dest)
            .map_err(|e| format!("Cannot copy GUI exe: {}", e))?;
    }

    let _ = std::fs::remove_dir_all(&temp_dir);

    let gui_exe_src = std::env::temp_dir()
        .join("claude-new-gui.exe")
        .to_string_lossy()
        .to_string();

    // Build file list — include manifest update if we have the new hash
    let mut files: Vec<FileCopyInstruction> = vec![];
    if let (Some(ref sha), Some(size)) = (&new_sha256, new_size) {
        if let Some(manifest_json) = build_updated_manifest("gui", sha, size) {
            let tmp_manifest = std::env::temp_dir().join("claude-manifest-update.json");
            if std::fs::write(&tmp_manifest, &manifest_json).is_ok() {
                files.push(FileCopyInstruction {
                    src: tmp_manifest.to_string_lossy().to_string(),
                    dst: local_manifest_path().to_string_lossy().to_string(),
                });
            }
        }
    }

    let instructions = UpdateInstructions {
        gui_exe_src: gui_exe_src.clone(),
        install_dir: install_dir.to_string_lossy().to_string(),
        files,
    };
    let instructions_json =
        serde_json::to_string_pretty(&instructions).map_err(|e| e.to_string())?;
    let instructions_path = std::env::temp_dir().join("claude-update.json");
    std::fs::write(&instructions_path, instructions_json)
        .map_err(|e| format!("Cannot write update instructions: {}", e))?;

    let updater_path = install_dir.join("Update.exe");
    if !updater_path.exists() {
        return Err(
            "Update.exe not found in install directory. Please reinstall the application."
                .to_string(),
        );
    }
    Ok(updater_path.to_string_lossy().to_string())
    })();
    let _ = tx.send(result);
    });
    rx.recv().map_err(|e| format!("GUI update panicked: {}", e))?
}

/// macOS GUI 更新：无 Update.exe。下载 .app zip → 解压 → osascript 提权 ditto 替换
/// install_dir/Claude Code.app → 返回空串（launch_updater 收到空路径即跳过、退出重启）。
#[cfg(not(windows))]
fn prepare_gui_update_mac(
    download_url: &str,
    new_sha256: Option<String>,
    new_size: Option<u64>,
) -> Result<String, String> {
    use std::process::Command;
    let install_dir = get_install_dir();
    let temp_dir = std::env::temp_dir().join("claude-update-gui");

    crate::download_and_extract(download_url, &temp_dir)?;

    let app_bundle = walkdir_find(&temp_dir, "Claude Code.app")
        .ok_or("New Claude Code.app not found in downloaded zip")?;
    let dst = install_dir.join("Claude Code.app");

    fn esc(s: &str) -> String {
        s.replace('\\', "\\\\").replace('"', "\\\"")
    }
    let script = format!(
        "do shell script \"rm -rf '{}'; ditto '{}' '{}'\" with administrator privileges",
        esc(&dst.to_string_lossy()),
        esc(&app_bundle.to_string_lossy()),
        esc(&dst.to_string_lossy())
    );
    let status = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .status()
        .map_err(|e| format!("Cannot replace GUI .app: {}", e))?;
    if !status.success() {
        return Err(format!("GUI .app replace failed (code {:?})", status.code()));
    }
    let _ = std::fs::remove_dir_all(&temp_dir);

    if let (Some(sha), Some(size)) = (new_sha256, new_size) {
        if let Some(m) = build_updated_manifest("gui", &sha, size) {
            let _ = std::fs::write(local_manifest_path(), &m);
        }
    }
    Ok(String::new())
}

#[tauri::command]
pub fn launch_updater_and_exit(updater_path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Kill all OTHER GUI instances before the update replaces the exe —
        // otherwise they hold the file lock (rename fails) and keep running
        // stale code. This instance exits itself below.
        let self_pid = std::process::id();
        let kill_others = format!(
            "Get-CimInstance Win32_Process -Filter \"Name='claude-code-gui.exe'\" | Where-Object {{ $_.ProcessId -ne {} }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}",
            self_pid
        );
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &kill_others])
            .status();
        // Force-killed GUIs orphan their IDE backends. Kill --ide-mode claude.exe
        // only (GUI backends) — the user's terminal TUI must survive.
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.CommandLine -match '--ide-mode' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"])
            .status();

        // Start-Process -Verb RunAs triggers UAC.
        // Use .status() to ensure PowerShell has launched Update.exe before we exit.
        // CREATE_NO_WINDOW stops the launcher PowerShell from flashing a console.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("powershell")
            .args(&[
                "-NoProfile",
                "-Command",
                &format!(
                    "Start-Process -FilePath '{}' -Verb RunAs -WindowStyle Hidden",
                    updater_path
                ),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        if updater_path.is_empty() {
            // macOS：.app 已由 prepare_gui_update 替换，直接退出让用户重启新版本。
            log::info!("macOS GUI replaced — exiting for restart");
        } else {
            let _ = std::process::Command::new(&updater_path).status();
        }
    }
    log::info!("Update.exe launched, exiting GUI...");
    // Brief sleep to ensure Update.exe has started before we release our file locks
    std::thread::sleep(std::time::Duration::from_millis(500));
    std::process::exit(0);
}

#[tauri::command]
pub fn get_local_manifest() -> Result<Option<LocalManifest>, String> {
    Ok(read_local_manifest())
}

#[tauri::command]
pub fn get_install_dir_path() -> Result<String, String> {
    Ok(get_install_dir().to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(platform: &str, name: &str) -> Option<PathBuf> {
        component_artifact_path(Path::new("/opt/claude"), name, platform)
    }

    #[test]
    fn windows_paths_match_legacy() {
        assert_eq!(artifact("windows", "gui").unwrap(), PathBuf::from("/opt/claude/claude-code-gui.exe"));
        assert_eq!(artifact("windows", "claude").unwrap(), PathBuf::from("/opt/claude/claude.exe"));
        assert_eq!(artifact("windows", "bun").unwrap(), PathBuf::from("/opt/claude/bun.exe"));
        assert_eq!(artifact("windows", "tools").unwrap(), PathBuf::from("/opt/claude/bin"));
        assert_eq!(artifact("windows", "python").unwrap(), PathBuf::from("/opt/claude/python"));
        assert_eq!(artifact("windows", "git").unwrap(), PathBuf::from("/opt/claude/git"));
        assert_eq!(artifact("windows", "extensions").unwrap(), PathBuf::from("/opt/claude/extensions"));
        assert_eq!(artifact("windows", "updater").unwrap(), PathBuf::from("/opt/claude/Update.exe"));
    }

    #[test]
    fn macos_uses_app_bundle_binary_and_system_components() {
        assert_eq!(artifact("macos", "gui").unwrap(), PathBuf::from("/opt/claude/Claude Code.app"));
        assert_eq!(artifact("macos", "claude").unwrap(), PathBuf::from("/opt/claude/claude"));
        assert_eq!(artifact("macos", "extensions").unwrap(), PathBuf::from("/opt/claude/extensions"));
        // bun/tools/python 自包含 → 可安装
        assert_eq!(artifact("macos", "bun").unwrap(), PathBuf::from("/opt/claude/bun"));
        assert_eq!(artifact("macos", "tools").unwrap(), PathBuf::from("/opt/claude/bin"));
        assert_eq!(artifact("macos", "python").unwrap(), PathBuf::from("/opt/claude/python"));
        // 系统自带 / Windows 专属 → 无安装产物
        for name in ["git", "updater"] {
            assert!(artifact("macos", name).is_none(), "{} should be None on macos", name);
        }
    }

    #[test]
    fn unknown_component_returns_none() {
        assert!(artifact("windows", "nope").is_none());
        assert!(artifact("macos", "nope").is_none());
    }

    // ── try_install 目录组件合并覆盖（python 更新保留用户 pip 库）──

    #[test]
    fn try_install_merges_preserving_user_files() {
        let dir = std::env::temp_dir().join(format!("try_install_merge_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dst = dir.join("python");
        let src = dir.join("new_py");
        std::fs::create_dir_all(dst.join("Lib").join("site-packages")).unwrap();
        std::fs::create_dir_all(src.join("Lib").join("site-packages")).unwrap();
        // 旧 python：用户 pip 装的库 + 构建自带的 pywin32.pth
        std::fs::write(dst.join("Lib").join("site-packages").join("user_lib.py"), "user").unwrap();
        std::fs::write(dst.join("Lib").join("site-packages").join("pywin32.pth"), "old").unwrap();
        std::fs::write(dst.join("python312.dll"), "old_dll").unwrap();
        // 新 python：pywin32 新版本（同名覆盖）
        std::fs::write(src.join("Lib").join("site-packages").join("pywin32.pth"), "new").unwrap();
        std::fs::write(src.join("python312.dll"), "new_dll").unwrap();

        try_install(&src, &dst, &dir).unwrap();

        // 用户库保留
        assert_eq!(
            std::fs::read_to_string(dst.join("Lib").join("site-packages").join("user_lib.py")).unwrap(),
            "user",
            "用户 pip 装的库不能被清掉"
        );
        // 新版本覆盖同名文件
        assert_eq!(
            std::fs::read_to_string(dst.join("Lib").join("site-packages").join("pywin32.pth")).unwrap(),
            "new"
        );
        assert_eq!(std::fs::read_to_string(dst.join("python312.dll")).unwrap(), "new_dll");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
