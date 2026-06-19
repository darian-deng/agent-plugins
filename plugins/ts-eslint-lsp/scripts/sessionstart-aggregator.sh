#!/bin/sh
# SessionStart hook for ts-eslint-lsp — CRITICAL PATH.
#
# This runs at the start of EVERY Claude Code session. It must NEVER hang and must
# ALWAYS exit 0: a failure here must not block the user's session. The aggregator it
# manages is only a performance helper — when it's absent, the PostToolUse hook falls
# back to running ESLint directly, so correctness never depends on this script.
#
# What it does:
#   1. Best-effort stage the proxy script into the plugin data dir (non-fatal on failure).
#   2. Inspect the currently-registered aggregator (if any) and decide whether to recycle it:
#        - process is not actually our aggregator (dead / PID reused) -> just clear stale PID file, do NOT kill
#        - it's an aggregator but a DIFFERENT version path                -> recycle (old version)
#        - it's our current-version aggregator but RSS over the ceiling   -> recycle (reclaim memory)
#        - it's our current-version aggregator under the ceiling          -> leave it running
#   3. Start a fresh aggregator only if none is registered.
#
# The RSS ceiling exists because the aggregator is a long-lived singleton shared by all
# concurrent sessions; it only ever restarted on a version change, so under continuous
# multi-session use (sessions rarely all closed) its memory could climb unbounded and
# never be reclaimed. Recycling it when a NEW session starts (a frequent action) caps that.

PID_FILE="${HOME}/.claude/ts-eslint-lsp.pid"
AGGREGATOR="${CLAUDE_PLUGIN_ROOT}/src/eslint-aggregator.mjs"
# RSS ceiling in KB above which a healthy same-version aggregator is recycled. 500 MB default.
# Sanitised to pure digits so a mistyped env value (e.g. "500MB") can't make the numeric test
# below error out and silently disable memory recycling; fall back to the default if empty.
RSS_LIMIT_KB="$(printf '%s' "${ESLINT_AGG_RSS_LIMIT_KB:-512000}" | tr -dc '0-9')"
[ -n "${RSS_LIMIT_KB}" ] || RSS_LIMIT_KB=512000

# --- 1. Best-effort: stage the proxy into the plugin data dir (decoupled from aggregator start,
#        so a copy failure can never prevent the aggregator from starting). ---
if [ -n "${CLAUDE_PLUGIN_DATA}" ]; then
  mkdir -p "${CLAUDE_PLUGIN_DATA}" 2>/dev/null \
    && cp "${CLAUDE_PLUGIN_ROOT}/src/ts-eslint-proxy.mjs" "${CLAUDE_PLUGIN_DATA}/ts-eslint-proxy.mjs" 2>/dev/null \
    && chmod +x "${CLAUDE_PLUGIN_DATA}/ts-eslint-proxy.mjs" 2>/dev/null
fi

# --- 2. Decide whether to recycle the registered aggregator. ---
recycle=0      # 1 -> kill the running pid then respawn
clean_only=0   # 1 -> just remove a stale PID file (do NOT kill anything)
running_pid=""

if [ -f "${PID_FILE}" ]; then
  running_pid="$(cat "${PID_FILE}" 2>/dev/null)"
  if [ -n "${running_pid}" ]; then
    # Read the full command line of whatever holds this pid, then match identity with `grep -F`
    # (fixed string). If the pid is dead or was reused by an unrelated process, the markers are
    # absent and we will NOT kill it (clean_only). Fixed-string matching is deliberate: a
    # `[^ ]*…` extraction would truncate at the first space and misjudge every space-containing
    # install path as a "different version", thrashing the aggregator on each session start.
    running_args="$(ps -ww -p "${running_pid}" -o args= 2>/dev/null)"
    if ! printf '%s' "${running_args}" | grep -Fq 'eslint-aggregator.mjs'; then
      clean_only=1                          # not an aggregator (dead pid, or reused by something else)
    elif ! printf '%s' "${running_args}" | grep -Fq "${AGGREGATOR}"; then
      recycle=1                             # an aggregator, but a different (old) version path
    else
      # Our current-version aggregator is alive — enforce the memory ceiling.
      # `tr -dc 0-9` guarantees a pure-digit string (or empty) so the numeric test can never error.
      running_rss="$(ps -p "${running_pid}" -o rss= 2>/dev/null | tr -dc '0-9')"
      if [ -n "${running_rss}" ] && [ "${running_rss}" -gt "${RSS_LIMIT_KB}" ]; then
        recycle=1
      fi
    fi
  else
    clean_only=1
  fi
fi

if [ "${recycle}" = "1" ]; then
  kill "${running_pid}" 2>/dev/null || true
  # Wait up to 2s for graceful exit, then force-kill. Bounded loop — never hangs.
  for _ in 1 2 3 4; do
    kill -0 "${running_pid}" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "${running_pid}" 2>/dev/null || true
  rm -f "${PID_FILE}" 2>/dev/null
elif [ "${clean_only}" = "1" ]; then
  rm -f "${PID_FILE}" 2>/dev/null
fi

# --- 3. Start a fresh aggregator only if none is registered. The aggregator binds a fixed
#        port as its singleton lock, so a racing duplicate start just exits on EADDRINUSE. ---
if [ ! -f "${PID_FILE}" ]; then
  mkdir -p "${HOME}/.claude/logs" 2>/dev/null
  ESLINT_IDE_PORT=7475 node "${AGGREGATOR}" >> "${HOME}/.claude/logs/eslint-aggregator.log" 2>&1 &
fi

exit 0
