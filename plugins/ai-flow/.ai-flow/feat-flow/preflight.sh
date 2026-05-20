#!/bin/sh
# feat-flow preflight — runs once when 'feat-flow start' is called.
# Exit 0 = all checks pass. Non-zero = blocked with error message.

SKILLS_DIR="$HOME/.claude/skills"
PASS=0
FAIL=1

check_cmd() {
  command -v "$1" >/dev/null 2>&1
}

check_skill() {
  [ -f "$SKILLS_DIR/$1/SKILL.md" ]
}

err() {
  echo "❌  $1" >&2
}

# ── 1. Claude Code CLI ─────────────────────────────────────────────────────────
if ! check_cmd claude; then
  err "claude CLI not found. feat-flow only runs inside Claude Code."
  err "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code"
  exit $FAIL
fi

# ── 2. Node.js ≥ 18 ────────────────────────────────────────────────────────────
if ! check_cmd node; then
  err "node not found. Node.js ≥ 18 is required."
  exit $FAIL
fi
NODE_MAJOR=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js ≥ 18 required (found: $(node --version 2>/dev/null || echo 'unknown'))."
  exit $FAIL
fi

# ── 3. Required skills ─────────────────────────────────────────────────────────
# TODO: skill 检查逻辑需要重写——按缺失的 skill 定点提示对应安装命令，
#       安装源也需要更新为最新的正确来源。暂时跳过此检查。

# ── 4. feature-dev plugin ──────────────────────────────────────────────────────
# TODO: feature-dev 检查暂时也跳过，等 skill 检查一起修复。

exit $PASS
