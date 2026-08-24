#!/usr/bin/env python3
"""handoff_extract.py — 会话压缩交接的脚本提取器。

给 handoff-compact 技能用。提取"可机械拿到、量大、有权威源"的内容作为原料，
模型再在此基础上做取舍（决策留痕表 / 不可再生资料提炼 / 待办 / 索引 / skills）。

用法:
  python handoff_extract.py [<session.jsonl>] [-o <out.md>] [--project <slug>]
    <session.jsonl>  会话 JSONL 路径；省略则自动定位（见下）
    -o <out.md>      输出 markdown 路径；默认 ./handoff-extracted.md
    --project <slug>  项目 slug，用于定位会话文件；省略则从当前目录名推断

自动定位会话 JSONL:
  取 ~/.claude/projects/<slug>/ 下最新、最大、非 edit-history 的 .jsonl。
  slug 默认 = 当前目录名（- 转 .，空格转 -）。

行为:
  1. git 上下文快照（log/status/branch/remote，近用可再生 -> 复制）
  2. dist/release 版本目录扫描（若存在）
  3. 从 JSONL 提取 Read 工具调用 -> "已读资料原料"段（不可再生 -> 给原料，模型取舍）
  4. 组装骨架 markdown 写 <out.md>
  5. stdout 只打印节段统计，不打印正文（防敏感内容入日志）

退出码: 0 成功；2 用法错误；1 其他失败。
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys

PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")

# ---------------------------------------------------------------------------
# 会话定位
# ---------------------------------------------------------------------------

def infer_slug(cwd):
    name = os.path.basename(os.path.normpath(cwd)) or "workspace"
    name = re.sub(r"[- ]", "_", name)
    return name


def find_session_jsonl(slug, explicit=None):
    if explicit:
        if not os.path.isfile(explicit):
            raise FileNotFoundError(f"session jsonl not found: {explicit}")
        return explicit
    cands = glob.glob(os.path.join(PROJECTS_DIR, slug, "*.jsonl"))
    cands = [c for c in cands if "edit-history" not in os.path.basename(c)]
    if not cands:
        raise FileNotFoundError(
            f"no session jsonl under {os.path.join(PROJECTS_DIR, slug)}"
        )
    # 最新最大优先
    cands.sort(key=lambda p: (os.path.getmtime(p), os.path.getsize(p)), reverse=True)
    return cands[0]


# ---------------------------------------------------------------------------
# git 快照
# ---------------------------------------------------------------------------

def run_git(args, cwd):
    try:
        r = subprocess.run(
            ["git"] + args, cwd=cwd, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30,
        )
        return r.stdout.strip()
    except Exception:
        return ""


def git_snapshot(cwd):
    head = run_git(["log", "-8", "--oneline"], cwd)
    status = run_git(["status", "--short"], cwd)
    branch = run_git(["branch", "--show-current"], cwd)
    sync = run_git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], cwd)
    lines = ["### Git 状态", ""]
    lines.append(f"- branch: `{branch or '(detached/no-branch)'}`")
    if sync and "error" not in sync.lower():
        lines.append(f"- HEAD vs upstream: `{sync}`")
    lines.append("")
    lines.append("```text")
    lines.append(head or "(no git log)")
    lines.append("```")
    if status:
        lines.append("")
        lines.append("**工作区未提交改动** (`git status --short`):")
        lines.append("")
        lines.append("```text")
        lines.append(status)
        lines.append("```")
    return "\n".join(lines)


def release_snapshot(cwd):
    dist = os.path.join(cwd, "dist", "release")
    if not os.path.isdir(dist):
        return ""
    vers = sorted([d for d in os.listdir(dist) if os.path.isdir(os.path.join(dist, d))])
    if not vers:
        return ""
    lines = ["### 发布版本 (dist/release)", ""]
    for v in vers[-5:][::-1]:
        sub = os.path.join(dist, v)
        parts = [p for p in os.listdir(sub) if os.path.isfile(os.path.join(sub, p))]
        lines.append(f"- {v}: {', '.join(sorted(parts))}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 已读资料提取（Read tool_use <-> tool_result 配对）
# ---------------------------------------------------------------------------

LINE_PREFIX = re.compile(r"^\d+\t", re.MULTILINE)


def strip_line_numbers(text):
    return LINE_PREFIX.sub("", text)


def extract_reads(jsonl_path):
    """返回 [(file_path, content), ...]，按会话顺序。"""
    tool_results = {}  # tool_use_id -> content
    reads = []         # [(file_path, content)]
    pending = []       # [(file_path, tool_use_id)]
    with open(jsonl_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = o.get("message") or {}
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for c in content:
                if not isinstance(c, dict):
                    continue
                ctype = c.get("type")
                if ctype == "tool_use" and c.get("name") == "Read":
                    fp = (c.get("input") or {}).get("file_path")
                    if fp:
                        pending.append((fp, c.get("id")))
                elif ctype == "tool_result":
                    uid = c.get("tool_use_id")
                    if uid:
                        tool_results[uid] = c.get("content") or ""
    for fp, uid in pending:
        res = tool_results.get(uid, "")
        if isinstance(res, list):
            res = "\n".join(
                x.get("text", "") for x in res if isinstance(x, dict) and x.get("type") == "text"
            )
        res = str(res)
        # 剥行号前缀 + 系统注入的 system-reminder 噪声 + 去空白
        clean = strip_line_numbers(res)
        clean = re.sub(r"<system-reminder>.*?</system-reminder>", "", clean, flags=re.S).strip()
        if clean:
            reads.append((fp, clean))
    return reads


# 5 反引号 fence：Read 内容本身可能含 ``` 三反引号，用更长 fence 包裹防误闭合
FENCE = "`````"

def reads_section(reads):
    if not reads:
        return "### 已读资料原料\n\n（本会话无 Read 工具调用）"
    lines = [
        "### 已读资料原料（Read 结果原文，模型取舍：哪些是核心、怎么提炼）",
        "",
        "> 每条约 `<第N次> <文件路径>`。这是不可再生资料，供决策/背景引用，模型判断保留还是折叠。",
        "",
    ]
    for i, (fp, content) in enumerate(reads, 1):
        lines.append(f"**({i}) {fp}**")
        lines.append("")
        lines.append(FENCE + "text")
        lines.append(content[:4000])
        if len(content) > 4000:
            lines.append(f"...[截断 {len(content) - 4000} 字符]")
        lines.append(FENCE)
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 最近用户输入（对话停点）
# ---------------------------------------------------------------------------

def extract_recent_user_messages(jsonl_path, n=5, max_len=200):
    """取最后 n 条用户纯文本输入，让下轮知道交流停在哪里。

    排除 tool_result / system / 压缩摘要（claude 内置压缩注入的长 user 消息）。
    """
    msgs = []
    with open(jsonl_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if o.get("type") != "user":
                continue
            content = o.get("message", {}).get("content")
            texts = []
            if isinstance(content, str):
                texts = [content]
            elif isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        texts.append(c.get("text", ""))
            for t in texts:
                t = t.strip()
                if not t or t.startswith("This session is being continued"):
                    continue
                msgs.append(t)
    msgs = msgs[-n:]
    out = []
    for i, m in enumerate(msgs, 1):
        m = m.replace("\n", " ⏎ ")
        if len(m) > max_len:
            m = m[:max_len] + f"…[+{len(m) - max_len} 字符]"
        out.append(f"- ({i}) {m}")
    return out


def recent_user_section(jsonl_path):
    msgs = extract_recent_user_messages(jsonl_path)
    lines = [
        "> 最后几条用户消息，下轮从这里续上。模型可在此后补一句「停在这里：正在讨论 X」。",
        "",
    ]
    lines += msgs if msgs else ["（本会话无用户纯文本输入）"]
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------

def assemble(cwd, jsonl_path, git_sec, release_sec, reads_sec, recent_sec):
    L = []
    L.append("# Handoff 提取原料（脚本产物，模型在基础上组装最终文档）")
    L.append("")
    L.append(f"- 会话源: `{jsonl_path}`")
    L.append(f"- 工作区: `{cwd}`")
    L.append("")
    L.append("## 热数据（近用可再生，脚本直接复制）")
    L.append("")
    L.append(git_sec)
    L.append("")
    if release_sec:
        L.append(release_sec)
        L.append("")
    L.append("## 最近用户输入（对话停点）")
    L.append("")
    L.append(recent_sec)
    L.append("")
    L.append("## 不可再生资料原料（Read 提取，模型取舍提炼）")
    L.append("")
    L.append(reads_sec)
    L.append("")
    L.append("## 模型待写节（脚本不产出，见 SKILL.md 流程）")
    L.append("")
    L.append("- 会话概览")
    L.append("- 决策留痕表")
    L.append("- 不可再生资料（提炼版，参考上面原料）")
    L.append("- 当前状态 / 待办")
    L.append("- 冷数据索引")
    L.append("- Suggested skills")
    return "\n".join(L)


def section_stats(text):
    """stdout 只打印节段名+行数，不打印正文；跳过 code block 内的标题。"""
    stats = []
    lines = text.split("\n")
    in_fence = False
    for i, ln in enumerate(lines):
        # 匹配 4+ 反引号 fence（与 reads_section 的 5 反引号一致）
        if re.match(r"^`{4,}", ln.strip()):
            in_fence = not in_fence
            continue
        if not in_fence:
            mm = re.match(r"^(#{2,3}) (.+)$", ln)
            if mm:
                end = i + 1
                while end < len(lines):
                    if re.match(r"^#{1,3} ", lines[end]):
                        break
                    end += 1
                seg = "\n".join(lines[i + 1:end])
                stats.append(f"{mm.group(2)}: {end - i - 1} 行 / {len(seg)} 字符")
    return stats


# ---------------------------------------------------------------------------

def main(argv=None):
    # Windows 终端默认 GBK，强制 UTF-8 避免统计信息乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="handoff-compact 脚本提取器")
    ap.add_argument("session", nargs="?", help="会话 JSONL 路径（省略自动定位）")
    ap.add_argument("-o", "--out", default="handoff-extracted.md", help="输出 markdown 路径")
    ap.add_argument("--project", default=None, help="项目 slug（定位会话用）")
    args = ap.parse_args(argv)

    cwd = os.getcwd()
    slug = args.project or infer_slug(cwd)

    try:
        jsonl = find_session_jsonl(slug, args.session)
    except FileNotFoundError as e:
        print(f"ERR 定位会话失败: {e}", file=sys.stderr)
        return 1

    git_sec = git_snapshot(cwd)
    release_sec = release_snapshot(cwd)
    recent_sec = recent_user_section(jsonl)
    reads = extract_reads(jsonl)
    reads_sec = reads_section(reads)
    out = assemble(cwd, jsonl, git_sec, release_sec, reads_sec, recent_sec)

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(out)

    print(f"OK 输出: {os.path.abspath(args.out)}")
    for s in section_stats(out):
        print("  " + s)
    print(f"已读资料原料: {len(reads)} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
