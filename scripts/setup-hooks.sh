#!/bin/sh
# Install git hooks for this repo.
# Run once after cloning: sh scripts/setup-hooks.sh
set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
# Git's resolved hooks path is correct in linked worktrees and when core.hooksPath is set;
# a hardcoded $REPO_ROOT/.git/hooks silently writes to the wrong place there.
HOOKS_DIR=$(git rev-parse --git-path hooks)
SCRIPTS_DIR="$REPO_ROOT/scripts/hooks"

case "$HOOKS_DIR" in
  /*) ;;
  *) HOOKS_DIR="$REPO_ROOT/$HOOKS_DIR" ;;
esac

mkdir -p "$HOOKS_DIR"
for hook in pre-commit pre-push; do
  cp "$SCRIPTS_DIR/$hook" "$HOOKS_DIR/$hook"
  chmod +x "$HOOKS_DIR/$hook"
  echo "installed $hook -> $HOOKS_DIR"
done

echo "git hooks installed ✓"
