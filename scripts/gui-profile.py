#!/usr/bin/env python3
"""
Claude Code Haha — API Profile Configuration GUI
Saves profile to ~/.claude/.env.profiles/ (user-writable).
Usage: python gui-profile.py [AppDir]
"""

import sys
import os
import json
import tkinter as tk
from tkinter import ttk, messagebox

HOME = os.path.expanduser("~")
CLAUDE_DIR = os.path.join(HOME, ".claude")
PROFILES_DIR = os.path.join(CLAUDE_DIR, ".env.profiles")

# ── Presets (mirrors scripts/claude-profile.ts templates) ──────────────

PRESETS = {
    "deepseek-v4-pro": {
        "label": "DeepSeek v4 Pro",
        "description": "DeepSeek v4 Pro (Claude-compatible)",
        "vars": {
            "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
            "ANTHROPIC_MODEL": "deepseek-v4-pro",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-pro",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro",
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
        },
        "requires_token": True,
    },
    "deepseek-v4-flash": {
        "label": "DeepSeek v4 Flash",
        "description": "DeepSeek v4 Flash (faster, weaker)",
        "vars": {
            "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
            "ANTHROPIC_MODEL": "deepseek-v4-flash",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-flash",
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
        },
        "requires_token": True,
    },
}

# ── Common defaults (mirrors claude-profile.ts COMMON_DEFAULTS) ────────

COMMON_DEFAULTS = [
    ("API_TIMEOUT_MS", "1200000"),
    ("MAX_TOKENS", "384000"),
    ("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "384000"),
    ("DISABLE_TELEMETRY", "1"),
    ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
    ("CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK", "1"),
    ("CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD", "999999"),
]


def save_profile(name: str, preset: dict, key: str) -> None:
    os.makedirs(PROFILES_DIR, exist_ok=True)

    env_file = os.path.join(PROFILES_DIR, f"{name}.env")
    lines = [f"# {preset['description']}"]

    for k, v in preset["vars"].items():
        if k == "ANTHROPIC_AUTH_TOKEN":
            lines.append(f"{k}={key}")
        else:
            lines.append(f"{k}={v}")

    if preset["requires_token"] and "ANTHROPIC_AUTH_TOKEN" not in preset["vars"]:
        lines.append(f"ANTHROPIC_AUTH_TOKEN={key}")

    lines.append("")
    for k, v in COMMON_DEFAULTS:
        lines.append(f"{k}={v}")

    with open(env_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def save_all(key: str) -> None:
    os.makedirs(PROFILES_DIR, exist_ok=True)
    # Generate both Pro and Flash profiles
    for name, preset in PRESETS.items():
        save_profile(name, preset, key)

    # Set Pro as default active
    active_file = os.path.join(CLAUDE_DIR, ".env.active")
    with open(active_file, "w", encoding="utf-8") as f:
        f.write("deepseek-v4-pro")

    # Update settings.json (Pro as default env)
    pro_preset = PRESETS["deepseek-v4-pro"]
    settings_file = os.path.join(CLAUDE_DIR, "settings.json")
    settings = {}
    if os.path.exists(settings_file):
        try:
            with open(settings_file, "r", encoding="utf-8") as f:
                settings = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    settings["env"] = {"ANTHROPIC_AUTH_TOKEN": key, **pro_preset["vars"]}
    with open(settings_file, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)


def main():
    app_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()

    root = tk.Tk()
    root.title("Claude Code Haha — API 配置")
    root.geometry("520x560")
    root.resizable(False, False)

    root.update_idletasks()
    sw = root.winfo_screenwidth()
    sh = root.winfo_screenheight()
    root.geometry(f"+{(sw - 520) // 2}+{(sh - 560) // 2}")

    root.configure(bg="#1e1e2e")
    style = ttk.Style()
    style.theme_use("clam")

    # ── Header ──────────────────────────────────────────────────────
    tk.Label(
        root,
        text="Claude Code Haha — API 配置",
        font=("Segoe UI", 14, "bold"),
        fg="#cdd6f4",
        bg="#1e1e2e",
    ).pack(pady=(20, 4))

    tk.Label(
        root,
        text="选择一个预设模板并输入 API Key",
        font=("Segoe UI", 10),
        fg="#a6adc8",
        bg="#1e1e2e",
    ).pack(pady=(0, 16))

    # ── Preset info ─────────────────────────────────────────────────
    info_frame = tk.Frame(root, bg="#1e1e2e")
    info_frame.pack(pady=(0, 12))

    tk.Label(
        info_frame,
        text="将同时生成以下两个配置:",
        font=("Segoe UI", 11),
        fg="#cdd6f4",
        bg="#1e1e2e",
    ).pack(anchor="w")

    presets_info = (
        f"  • DeepSeek v4 Pro   — deepseek-v4-pro  (默认激活)\n"
        f"  • DeepSeek v4 Flash — deepseek-v4-flash\n\n"
        f"Base URL: https://api.deepseek.com/anthropic\n"
        f"Context:  1,000,000 tokens\n"
        f"共用一个 API Key，输入一次即可。"
    )
    tk.Label(
        info_frame,
        text=presets_info,
        font=("Segoe UI", 9),
        fg="#6c7086",
        bg="#1e1e2e",
        justify="left",
    ).pack(pady=(4, 0))

    # ── API Key input ───────────────────────────────────────────────
    key_frame = tk.Frame(root, bg="#1e1e2e")
    key_frame.pack(pady=(0, 8), padx=40, fill="x")

    tk.Label(
        key_frame,
        text="API Key:",
        font=("Segoe UI", 11),
        fg="#cdd6f4",
        bg="#1e1e2e",
    ).pack(anchor="w")

    key_var = tk.StringVar()
    key_entry = tk.Entry(
        key_frame,
        textvariable=key_var,
        show="*",
        font=("Consolas", 11),
        bg="#313244",
        fg="#cdd6f4",
        insertbackground="#cdd6f4",
        relief="flat",
    )
    key_entry.pack(pady=(4, 0), fill="x")

    toggle_var = tk.BooleanVar(value=True)

    def toggle_show():
        key_entry.configure(show="" if toggle_var.get() else "*")

    tk.Checkbutton(
        key_frame,
        text="显示密钥",
        variable=toggle_var,
        command=toggle_show,
        font=("Segoe UI", 9),
        fg="#a6adc8",
        bg="#1e1e2e",
        selectcolor="#313244",
        activebackground="#1e1e2e",
        activeforeground="#cdd6f4",
    ).pack(anchor="w", pady=(4, 0))

    # ── Options info ────────────────────────────────────────────────
    opt_frame = tk.Frame(root, bg="#1e1e2e")
    opt_frame.pack(pady=(16, 0), padx=40, fill="x")

    tk.Label(
        opt_frame,
        text="即将写入的环境变量（含通用默认值）:",
        font=("Segoe UI", 9, "bold"),
        fg="#cdd6f4",
        bg="#1e1e2e",
    ).pack(anchor="w")

    opt_list = tk.Text(
        opt_frame,
        font=("Consolas", 8),
        bg="#313244",
        fg="#bac2de",
        height=9,
        relief="flat",
        state="disabled",
        wrap="none",
    )
    opt_list.pack(pady=(4, 0), fill="x")

    def update_opt_list(*_args):
        token_mask = key_var.get().strip()
        lines = []
        for name, preset in PRESETS.items():
            lines.append(f"-- {preset['label']} ({name}) --")
            for k, v in preset["vars"].items():
                lines.append(f"  {k}={v}")
        lines.append("")
        for k, v in COMMON_DEFAULTS:
            lines.append(f"  {k}={v}")
        lines.append(f"  ANTHROPIC_AUTH_TOKEN={'***' if token_mask else '(输入 Key 后显示)'}")

        opt_list.configure(state="normal")
        opt_list.delete("1.0", "end")
        opt_list.insert("1.0", "\n".join(lines))
        opt_list.configure(state="disabled")

    key_var.trace_add("write", update_opt_list)

    # ── Storage info ────────────────────────────────────────────────
    tk.Label(
        root,
        text=f"配置文件保存到: {PROFILES_DIR}",
        font=("Segoe UI", 8),
        fg="#585b70",
        bg="#1e1e2e",
    ).pack(pady=(12, 0))

    # ── Buttons ─────────────────────────────────────────────────────
    btn_frame = tk.Frame(root, bg="#1e1e2e")
    btn_frame.pack(pady=(20, 0))

    def on_save():
        api_key = key_var.get().strip()
        if not api_key:
            messagebox.showwarning("请输入 API Key", "请输入 DeepSeek API Key，或点击「跳过」。")
            return
        try:
            save_all(api_key)
            names = ", ".join(PRESETS.keys())
            messagebox.showinfo(
                "配置完成",
                f"已生成 {len(PRESETS)} 个配置: {names}\n\n"
                f"默认激活: deepseek-v4-pro\n"
                f"配置文件目录: {PROFILES_DIR}\n\n"
                "IDE 扩展和 CLI 会自动读取此配置。\n"
                "现在可以启动 Claude Code 使用了！",
            )
            root.destroy()
        except Exception as e:
            messagebox.showerror("保存失败", str(e))

    tk.Button(
        btn_frame,
        text="保存配置",
        command=on_save,
        font=("Segoe UI", 11, "bold"),
        bg="#cba6f7",
        fg="#1e1e2e",
        activebackground="#b4befe",
        activeforeground="#1e1e2e",
        relief="flat",
        padx=24,
        pady=6,
        cursor="hand2",
    ).pack(side="left", padx=(0, 12))

    tk.Button(
        btn_frame,
        text="跳过",
        command=root.destroy,
        font=("Segoe UI", 11),
        bg="#45475a",
        fg="#cdd6f4",
        activebackground="#585b70",
        activeforeground="#cdd6f4",
        relief="flat",
        padx=24,
        pady=6,
        cursor="hand2",
    ).pack(side="left")

    # Init
    update_opt_list()
    key_entry.focus_set()
    root.mainloop()


if __name__ == "__main__":
    main()
