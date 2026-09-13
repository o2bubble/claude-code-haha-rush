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
# Rebuild the index+worktree from main's latest tree.
# 不要 exclude .gitignore —— main 的 .gitignore 是权威（含 .private/、.codex/、
# AGENTS.md）。曾经 exclude 它、靠快照分支自带的旧版 .gitignore，结果那份缺
# .private/ 条目 → 下面 `git add -A` 把 .private/ 里的 API key 收进快照并推到
# 公开 gitee（2026-09-12 事故）。忽略规则必须与 main 一致。
git rm -r --cached --quiet . 2>/dev/null || true
git checkout main -- .
# 删除 main 已不存在、但工作树仍残留的文件。
#
# ⚠️ 顺序陷阱：`git checkout main -- .` 只**覆盖/新增** main 里有的路径，对 main
# 没有的文件既不删索引也不删工作树。它在上面 `git rm --cached .` 之后执行，于是
# 这些文件处于「不在索引、但留在工作树」的状态 —— 紧接着的 `git add -A` 又原样
# 加回来，**每轮同步都保留**。
#
# 实际事故（2026-09-13）：services/ 下 4 个改名前的旧文件（dataBus*.ts /
# serviceBus.ts → crossWindowBus*.ts / windowBus.ts）作为孤儿在快照里存续数周。
# CI 的 tsc（include: ["src"]）把它们一并编译，直到它们引用的旧 API
# （terminalStore.appendToLastEntry）被删除才报错 → **CI 构建失败，而本地怎么
# 跑都是绿的**（本地在 main 上，根本没有这些文件）。
#
# 用 `--others` 一并列出**未跟踪**文件再比差集：孤儿此刻正在这个状态里，
# 只看索引（旧版 `comm` 的做法）会漏掉它们。`-f` 覆盖「工作树有改动」的拒绝。
comm -23 <(git ls-files --cached --others --exclude-standard | sort -u) \
         <(git ls-tree -r --name-only main | sort) \
  | xargs -r git rm -q -f -- 2>/dev/null || true
git add -A

# ── 安全闸：敏感路径一旦入 stage 立即中止 ────────────────────────────────
# 这是最后一道防线。上面已对齐忽略规则，但 ignore 规则可能再次漂移（或有人在
# 快照分支加了 force-add），所以提交前显式核对一次，宁可失败也不泄露。
FORBIDDEN='^\.private/|^\.codex/|^AGENTS\.md$|^\.env$|^\.env\.'
if git diff --cached --name-only | grep -qE "$FORBIDDEN"; then
    echo "!! 中止：暂存区出现敏感路径，拒绝提交 ——" >&2
    git diff --cached --name-only | grep -E "$FORBIDDEN" >&2
    echo "!! 修复：git reset 后把这些路径加入快照分支的 .gitignore" >&2
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

# Push GitHub (private) and persist the snapshot branch to gitee.
git push github HEAD:main --force
git push origin github-clean --force

git checkout main
echo "done"
