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
MISSING_SKILLS=""

for skill in \
  brainstorming \
  writing-plans \
  subagent-driven-development \
  verification-before-completion \
  tdd \
  diagnose \
  improve-codebase-architecture \
  skill-surgeon \
  claude-md-improver
do
  if ! check_skill "$skill"; then
    MISSING_SKILLS="$MISSING_SKILLS $skill"
  fi
done

if [ -n "$MISSING_SKILLS" ]; then
  err "Missing required skills:$MISSING_SKILLS"
  err ""
  err "Install via: npx --yes skills@latest add obra/superpowers -a claude-code -g -y"
  err "         and: npx --yes skills@latest add mattpocock/skills -a claude-code -g -y"
  err "         and: npx --yes skills@latest add darian-deng/agent-skills --skill skill-surgeon -a claude-code -g -y"
  exit $FAIL
fi

# ── 4. feature-dev plugin ──────────────────────────────────────────────────────
PLUGIN_LIST=$(claude plugins list 2>/dev/null || echo "")
if ! echo "$PLUGIN_LIST" | grep -q "feature-dev"; then
  err "Plugin 'feature-dev' not found."
  err "Install via: claude plugins install feature-dev@claude-plugins-official"
  exit $FAIL
fi

exit $PASS
