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
# ':(exclude).gitignore' keeps github-clean's own .gitignore (it diverges from
# main's — the snapshot version is the source of truth for the snapshot branch).
git rm -r --cached --quiet . 2>/dev/null || true
git checkout main -- . ':(exclude).gitignore'
# 删除 main 已不存在但工作树残留的已跟踪文件（checkout 只覆盖/添加, 不删——
# 曾导致 guiDiffParse 等删除文件在 github-clean 永久残留, 需手动 git rm）。
comm -23 <(git ls-files | sort) <(git ls-tree -r --name-only main | sort) | xargs -r git rm -q -- 2>/dev/null || true
git add -A

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
