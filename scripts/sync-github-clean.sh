#!/bin/bash
# Sync main -> github-clean snapshot branch, push GitHub CI + persist to gitee.
#
# Why: GitHub has a 100MB single-file limit, and offline-tools/windows/bun.exe is
# 111MB. A branch that inherits main's history would carry that blob and fail to
# push. `github-clean` is an orphan snapshot branch (no common history with main)
# whose tree always excludes offline-tools. Each sync here is an INCREMENTAL commit
# on github-clean (git records the diff vs the previous snapshot), so GitHub keeps
# a real commit history instead of one monolithic snapshot per release.
#
# Usage: bash scripts/sync-github-clean.sh
# Requires: git remotes `github` (o2bubble/claude-code-haha-rush) + `origin` (gitee).
set -euo pipefail

git checkout main
git pull origin main 2>/dev/null || true

git checkout github-clean
# Rebuild the index+worktree from main's latest tree, then drop the large binaries.
# ':(exclude).gitignore' keeps github-clean's own .gitignore (which lists
# offline-tools/) — main's would overwrite it and let the 111MB bun.exe back in.
git rm -r --cached --quiet . 2>/dev/null || true
git checkout main -- . ':(exclude).gitignore'
git rm -r --cached --quiet offline-tools 2>/dev/null || true
git add -A

if git diff --cached --quiet; then
    echo "no changes since last snapshot, skipping commit"
else
    git commit -m "sync from main @$(git rev-parse --short main)"
fi

# Push GitHub (triggers macOS CI) and persist the snapshot branch to gitee.
git push github HEAD:main --force
git push origin github-clean

git checkout main
echo "done"
