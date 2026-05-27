#!/bin/sh
# feat-flow preflight — runs once when 'feat-flow start' is called.
# Exit 0 = all checks pass. Non-zero = blocked with error message.
# cwd is .ai-flow/feat-flow/

PASS=0
FAIL=1

SKILLS_DIR="$HOME/.claude/skills"
PLUGINS_CACHE="$HOME/.claude/plugins/cache"

err()  { printf "❌  %s\n" "$1" >&2; }
cmd()  { printf "    %s\n" "$1" >&2; }
warn() { printf "⚠️   %s\n" "$1" >&2; }
ok()   { printf "✅  %s\n" "$1"; }

check_cmd() { command -v "$1" >/dev/null 2>&1; }
check_skill() { [ -f "$SKILLS_DIR/$1/SKILL.md" ]; }
check_plugin() {
  # Match any directory named $1 up to 4 levels deep in plugin cache
  find "$PLUGINS_CACHE" -maxdepth 4 -type d -name "$1" 2>/dev/null | grep -q .
}

# ── 1. Claude Code CLI ──────────────────────────────────────────────────────────
if ! check_cmd claude; then
  err "claude CLI not found. feat-flow only runs inside Claude Code."
  err "Install: https://docs.anthropic.com/en/docs/claude-code"
  exit $FAIL
fi
ok "claude CLI"

# ── 2. Node.js ≥ 18 ─────────────────────────────────────────────────────────────
if ! check_cmd node; then
  err "node not found. Node.js ≥ 18 is required."
  exit $FAIL
fi
NODE_MAJOR=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js ≥ 18 required (found: $(node --version 2>/dev/null || echo 'unknown'))."
  exit $FAIL
fi
ok "Node.js $(node --version)"

# ── 3. git ──────────────────────────────────────────────────────────────────────
if ! check_cmd git; then
  err "git not found. feat-flow requires git for BASE_SHA_CODE tracking and per-task commits."
  exit $FAIL
fi
ok "git $(git --version | awk '{print $3}')"

# ── 4. 必需 user-installed skills ──────────────────────────────────────────────
# skill 来源（均通过 npx skills add <owner/repo@skill> -g 安装）：
#   grill-me                    → mattpocock/skills
#   writing-plans               → obra/superpowers
#   subagent-driven-development → obra/superpowers
#   receiving-code-review       → obra/superpowers
#   optimize-claude-context     → darian-deng/agent-skills
#   adr-manage                  → darian-deng/agent-skills
REQUIRED_SKILLS="grill-me writing-plans subagent-driven-development receiving-code-review optimize-claude-context adr-manage"
MISSING_SKILLS=""

for skill in $REQUIRED_SKILLS; do
  if check_skill "$skill"; then
    ok "skill: $skill"
  else
    MISSING_SKILLS="$MISSING_SKILLS $skill"
  fi
done

if [ -n "$MISSING_SKILLS" ]; then
  err "Missing required skills:$MISSING_SKILLS"
  err ""
  err "── 复制以下命令到终端执行 ──────────────────────────────────"

  # 按 skill 输出精确安装命令
  for skill in $MISSING_SKILLS; do
    case "$skill" in
      grill-me)
        cmd "npx skills add mattpocock/skills@grill-me -g"
        ;;
      writing-plans)
        cmd "npx skills add obra/superpowers@writing-plans -g"
        ;;
      subagent-driven-development)
        cmd "npx skills add obra/superpowers@subagent-driven-development -g"
        ;;
      receiving-code-review)
        cmd "npx skills add obra/superpowers@receiving-code-review -g"
        ;;
      optimize-claude-context)
        cmd "npx skills add darian-deng/agent-skills@optimize-claude-context -g"
        ;;
      adr-manage)
        cmd "npx skills add darian-deng/agent-skills@adr-manage -g"
        ;;
    esac
  done

  err "────────────────────────────────────────────────────────────"
  exit $FAIL
fi

# ── 5. feature-dev plugin (code-explorer / code-architect / code-reviewer) ──────
if check_plugin "feature-dev"; then
  ok "plugin: feature-dev"
else
  err "feature-dev plugin not detected in plugin cache."
  err "Install via: claude plugin install feature-dev@claude-plugins-official --scope user"
  err "feat-flow will fail at Stage 1, 2, and 5 without this plugin."
  exit $FAIL
fi

exit $PASS
