#!/bin/sh
# Install git hooks for this repo.
# Run once after cloning: sh scripts/setup-hooks.sh
set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SCRIPTS_DIR="$REPO_ROOT/scripts/hooks"

for hook in pre-commit pre-push; do
  cp "$SCRIPTS_DIR/$hook" "$HOOKS_DIR/$hook"
  chmod +x "$HOOKS_DIR/$hook"
  echo "installed $hook"
done

echo "git hooks installed ✓"
