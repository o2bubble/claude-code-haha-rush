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
# 删除 main 已不存在但工作树残留的已跟踪文件（checkout 只覆盖/添加, 不删——
# 曾导致 guiDiffParse 等删除文件在 github-clean 永久残留, 需手动 git rm）。
comm -23 <(git ls-files | sort) <(git ls-tree -r --name-only main | sort) | xargs -r git rm -q -- 2>/dev/null || true
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
