#!/bin/bash
# Sync main -> github-clean snapshot branch, push GitHub CI + persist to gitee.
#
# Why a snapshot branch: main's history accumulated commits containing plaintext
# credentials (and old large binaries). `github-clean` is an orphan branch — no
# common history — so nothing from those commits can be reached from it. Each
# sync commits main's current tree on top of the previous snapshot.
#
# offline-tools/ (167MB of binaries) is gitignored repo-wide since 2026-09-11,
# so it never enters the snapshot and GitHub's 100MB file limit is a non-issue.
#
# Usage: bash scripts/sync-github-clean.sh
# Requires: git remotes `github` (o2bubble/claude-code-haha-rush) + `origin` (gitee).
set -euo pipefail

git checkout main
git pull origin main 2>/dev/null || true

git checkout github-clean

# ── 快照的树 = main 的树，直接构造索引 ──────────────────────────────────
#
# `git read-tree main` 一次把索引整体换成 main 的树。**提交读的是索引**，
# 所以得到的快照树与 main 逐字节相同 —— 不需要碰工作树、不需要 add。
#
# 为什么不用「`git checkout main -- .` + 删除孤儿 + `git add -A`」：
#
#   · **非 ASCII 路径删不掉**。`git ls-files` / `git ls-tree` 默认
#     `core.quotePath=true`，对中文路径输出 C 引号 + 八进制转义
#     （`"plugins/.../01-\345\220\257..."`），这个字符串喂给 `git rm` /
#     `rm -f` 匹配不上任何文件。实测：`plugins/gui-manual` 下 17 个中文
#     文件名作为孤儿连续多轮同步都留在快照里，而脚本一声不吭。
#   · **`git add -A` 会把工作树里任何未跟踪文件扫进快照**。对公开仓来说，
#     那条路径上的任何东西（临时文件、刚写的 .env）都会跟着发布出去。
#     read-tree 只认 main 里已跟踪的内容，从结构上排除这一类事故。
#
# 2026-09-12 的泄露事故（快照自带的旧 .gitignore 漏了 `.private/`，`add -A`
# 把 API key 收进来推到公开 gitee）正是上面第二条的形态。现在的做法根本不
# 走那条路。（下面的安全闸仍保留，作为「main 自己也被污染」时的兜底。）
git read-tree main

# ── 安全闸：敏感路径/密钥一旦进快照立即中止 ─────────────────────────────
# 最后一道防线。现在索引来自 main，所以这里检的是「main 自己有没有被污染」。
# `core.quotePath=false`：默认会 C 引号转义非 ASCII 路径，而下面几条都是
# 锚定行首的正则（`^\.private/`），被引号打头就匹配不上了。
FORBIDDEN='^\.private/|^\.codex/|^AGENTS\.md$'
# `.env.example` 是**该公开**的模板，不能和真 `.env` 一起拦。
ENV_LEAK='(^|/)\.env(\.[^/]*)?$'
sensitive=$(git -c core.quotePath=false ls-files \
    | grep -E "$FORBIDDEN" || true)
env_leak=$(git -c core.quotePath=false ls-files \
    | grep -E "$ENV_LEAK" | grep -v '\.env\.example$' || true)
if [ -n "$sensitive" ] || [ -n "$env_leak" ]; then
    echo "!! 中止：快照里出现敏感路径，拒绝提交 ——" >&2
    printf '%s\n%s\n' "$sensitive" "$env_leak" | sed '/^$/d' >&2
    exit 1
fi
if git diff --cached -U0 | grep -qE '^\+.*(sk-[a-zA-Z0-9]{20,}|LTAI[0-9A-Za-z]{12,}|AKID[A-Za-z0-9]{13,})'; then
    echo "!! 中止：暂存区 diff 命中密钥模式，拒绝提交 ——" >&2
    git diff --cached -U0 | grep -nE '^\+.*(sk-[a-zA-Z0-9]{20,}|LTAI[0-9A-Za-z]{12,}|AKID[A-Za-z0-9]{13,})' | head -5 >&2
    exit 1
fi

if git diff --cached --quiet; then
    echo "no changes since last snapshot, skipping commit"
else
    git commit -m "sync from main @$(git rev-parse --short main)"
fi

# ── 不变量：快照的树必须与 main 逐字节相同 ───────────────────────────────
# 上面所有步骤的意义就是这一条。不成立就说明同步逻辑本身坏了 ——
# 宁可在这里失败，也不要推一个内容不明的快照到公开仓。
snapshot_tree=$(git rev-parse "HEAD^{tree}")
main_tree=$(git rev-parse "main^{tree}")
if [ "$snapshot_tree" != "$main_tree" ]; then
    echo "!! 中止：快照树与 main 不一致（$snapshot_tree != $main_tree）" >&2
    echo "!! 差异：" >&2
    git -c core.quotePath=false diff --stat HEAD main | tail -20 >&2
    exit 1
fi
echo "快照树 == main 树 ✓"

# Push GitHub (private) and persist the snapshot branch to gitee.
git push github HEAD:main --force
git push origin github-clean --force

# `-f`：工作树里还留着上一轮快照的旧文件（read-tree 不碰工作树），
# 不用 -f 会被 "untracked working tree files would be removed by checkout" 拒绝，
# 配合 `set -e` 让脚本在最后一步失败。
git checkout -f main
echo "done"
