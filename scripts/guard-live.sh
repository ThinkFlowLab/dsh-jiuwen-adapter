#!/usr/bin/env bash
# scripts/guard-live.sh — nightly live guard (box-side), end to end:
#   1. snapshot Jiuwen: config + MCP state bytes (sha256), RPC-visible state, the running agentserver/gateway
#      command line + env + cwd (kept in a 0700 temp dir, deleted at exit, never printed)
#   2. probe the real model once (HTTP status only); 429 → skip the real-model smoke
#   3. start the scripted stand-in model
#   4. npm run test:live (LIVE_SMOKE=1 if the model answered; /jiuwen commands, live-deep, compat-runtime,
#      drop recovery) and npm run test:plain-dsh (full matrix: adapter-last and adapter-first load orders)
#   5. restore Jiuwen exactly and verify (checksums + state), check protected ports were not touched
#   6. write $GUARD_LOG_DIR/<date>.md (pass/fail counts + failing test names), exit non-zero on any failure
# Usage: bash scripts/guard-live.sh            (or: npm run guard:live)
# Env (box defaults): DSH_BIN, DSH_NM, JIUWEN_HOME (~/.jiuwenswarm), JIUWEN_GATEWAY_URL (ws://127.0.0.1:19000/ws),
#   STANDIN_PORT (18999), GUARD_LOG_DIR (/workspace/guard-logs), GUARD_PROTECT_PORTS ("3335": FlyBot demo, never touched),
#   GUARD_SKIP_SMOKE=1 (never run the real-model smoke), LEAK_TURNS (200).
#   GUARD_ONLY=live|plain-dsh (run one suite only; the summary is marked partial and the run never counts as a full PASS).
#   GUARD_BACKEND=agent-core|gateway|both (default agent-core). Sets JIUWEN_BACKEND for plain-dsh / live; `both` runs plain-dsh twice.
# Internal subcommands used as JW_USE_STANDIN_CMD / JW_RESTORE_CMD / GW_KILL / GW_START: __use-standin, __restore-real,
#   __gw-kill, __gw-start (need GUARD_SNAP).
set -uo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SELF="$ROOT/scripts/guard-live.sh"
JW_HOME=${JIUWEN_HOME:-$HOME/.jiuwenswarm}
CFG=$JW_HOME/config
MCP_STATE=$JW_HOME/agent/workspace/mcp/state.json
GW_URL=${JIUWEN_GATEWAY_URL:-ws://127.0.0.1:19000/ws}
GW_PORT=$(node -e 'console.log(new URL(process.argv[1]).port)' "$GW_URL")
envval() { grep -E "^$1=" "$CFG/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//'; }
AGENT_PORT=${JW_AGENT_PORT:-$(envval AGENT_SERVER_PORT)}; AGENT_PORT=${AGENT_PORT:-18092}
STANDIN_PORT=${STANDIN_PORT:-18999}
STANDIN_BASE="http://127.0.0.1:$STANDIN_PORT/v1"
export DSH_BIN=${DSH_BIN:-/workspace/dsh-rc5/prefix/bin/dsh}
export DSH_NM=${DSH_NM:-/workspace/dsh-rc5/prefix/lib/node_modules/@deepseek-ai/dsh/node_modules}
LOG_ROOT=${GUARD_LOG_DIR:-/workspace/guard-logs}
PROTECT_PORTS=${GUARD_PROTECT_PORTS:-3335}

log() { printf '[guard %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
listener_pid() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }
port_up() { [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]; }
wait_port() { local p=$1 t=${2:-90}; for ((i = 0; i < t; i++)); do port_up "$p" && { sleep 2; return 0; }; sleep 1; done; return 1; }

# ---- Jiuwen service control (exact command line / env / cwd captured at snapshot) ----
stop_pid() { local pid=$1; [ -z "$pid" ] && return 0; kill -TERM "$pid" 2>/dev/null; for ((i = 0; i < 20; i++)); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done; kill -KILL "$pid" 2>/dev/null; sleep 1; }
stop_services() { stop_pid "$(listener_pid "$GW_PORT")"; stop_pid "$(listener_pid "$AGENT_PORT")"; for ((i = 0; i < 20; i++)); do port_up "$GW_PORT" || port_up "$AGENT_PORT" || return 0; sleep 0.5; done; }
start_one() { # name mode(real|standin)
  local name=$1 mode=$2 cwd; cwd=$(cat "$GUARD_SNAP/$name.cwd")
  local -a E C; mapfile -d '' E < "$GUARD_SNAP/$name.env"; mapfile -d '' C < "$GUARD_SNAP/$name.cmd"
  [ "$mode" = standin ] && E+=("API_BASE=$STANDIN_BASE")
  (cd "$cwd" && exec env -i "${E[@]}" setsid nohup "${C[@]}" </dev/null >>"${GUARD_RUN_DIR:-$GUARD_SNAP}/jw-$name.log" 2>&1) &
}
start_services() { start_one agent "$1"; wait_port "$AGENT_PORT" 60 || sleep 4; start_one gateway "$1"; wait_port "$GW_PORT" 90; }
restore_files() { (cd "$GUARD_SNAP/files" && find . -type f -print0 | while IFS= read -r -d '' f; do cmp -s "$f" "$JW_HOME/$f" || cp -p "$f" "$JW_HOME/$f"; done); }
verify_sums() { (cd "$JW_HOME" && sha256sum --quiet -c "$GUARD_SNAP/sums" >/dev/null 2>&1); }
use_standin() { stop_services; restore_files; sed -i "s#^API_BASE=.*#API_BASE=$STANDIN_BASE#" "$CFG/.env"; start_services standin; }
restore_real() { stop_services; restore_files; start_services real; }
state_cmd() { (cd "$ROOT" && JIUWEN_GATEWAY_URL=$GW_URL node test/live/guard-state.mjs "$@" 2>/dev/null | tail -1); }

case "${1:-}" in
  __use-standin) use_standin; exit $? ;;
  __restore-real) restore_real; exit $? ;;
  __gw-kill) pid=$(listener_pid "$GW_PORT"); [ -n "$pid" ] && kill -KILL "$pid"; exit 0 ;;
  __gw-start) start_one gateway standin; wait_port "$GW_PORT" 90; exit $? ;;
  "") ;;
  *) echo "usage: $0" >&2; exit 2 ;;
esac

# ---- main ----
DAY=$(date +%F); STAMP=$(date +%F-%H%M%S); T0=$(date +%s); START=$(date '+%F %H:%M')
RUN_DIR="$LOG_ROOT/$STAMP"; SUMMARY="$LOG_ROOT/$DAY${GUARD_ONLY:+-$GUARD_ONLY}.md"
mkdir -p "$RUN_DIR/live" && chmod 755 "$LOG_ROOT" "$RUN_DIR" "$RUN_DIR/live" && export GUARD_RUN_DIR=$RUN_DIR
exec > >(tee -a "$RUN_DIR/guard.log") 2>&1
# Revision the suites ran against (taken once: a commit during the run must not relabel it); "+dirty" = uncommitted changes.
REV=$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet HEAD -- . ':!bench/results' 2>/dev/null || echo +dirty)
log "run dir $RUN_DIR (adapter $REV)"

FAILS=()   # step-level failures
NOTES=()
fail() { FAILS+=("$*"); log "FAIL $*"; }

port_up "$GW_PORT" || { log "Gateway not listening on :$GW_PORT — nothing to guard"; exit 2; }
GW_PID=$(listener_pid "$GW_PORT"); AG_PID=$(listener_pid "$AGENT_PORT")
[ -n "$GW_PID" ] && [ -n "$AG_PID" ] || { log "cannot find the gateway/agentserver processes (:$GW_PORT / :$AGENT_PORT)"; exit 2; }
for x in "$DSH_BIN" "$DSH_NM"; do [ -e "$x" ] || { log "missing $x (set DSH_BIN / DSH_NM)"; exit 2; }; done
declare -A PROT; for p in $PROTECT_PORTS; do PROT[$p]=$(listener_pid "$p"); done

# 1. snapshot
export GUARD_SNAP; GUARD_SNAP=$(mktemp -d /tmp/guard-live.XXXXXX); chmod 700 "$GUARD_SNAP"
RESTORED=0; STANDIN_PID=
cleanup() {
  [ -n "$STANDIN_PID" ] && kill -- -"$STANDIN_PID" 2>/dev/null
  if [ "$RESTORED" != 1 ] && [ -d "$GUARD_SNAP/files" ]; then
    log "emergency restore"; restore_real
    [ -f "$GUARD_SNAP/state.json" ] && log "state after emergency restore: $(state_cmd restore "$GUARD_SNAP/state.json" || echo error)"
  fi
  rm -rf "$GUARD_SNAP"
}
trap cleanup EXIT
trap 'log "interrupted"; exit 130' INT TERM
mkdir -p "$GUARD_SNAP/files"
(cd "$JW_HOME" && { find config -maxdepth 1 -type f; [ -f "${MCP_STATE#$JW_HOME/}" ] && echo "${MCP_STATE#$JW_HOME/}"; } | sort > "$GUARD_SNAP/list" \
  && tar -cf - -T "$GUARD_SNAP/list" | tar -xpf - -C "$GUARD_SNAP/files" && xargs -d '\n' sha256sum < "$GUARD_SNAP/list" > "$GUARD_SNAP/sums")
for n in agent:$AG_PID gateway:$GW_PID; do
  name=${n%%:*} pid=${n#*:}
  cat "/proc/$pid/environ" > "$GUARD_SNAP/$name.env"; cat "/proc/$pid/cmdline" > "$GUARD_SNAP/$name.cmd"; readlink "/proc/$pid/cwd" > "$GUARD_SNAP/$name.cwd"
done
REAL_API_BASE_SHA=$(tr '\0' '\n' < "$GUARD_SNAP/gateway.env" | grep -E '^API_BASE=' | sha256sum | cut -c1-16)
SNAP_MSG=$(state_cmd save "$GUARD_SNAP/state.json") || { log "state snapshot failed"; exit 2; }
# secret values (for the leak scan of the logs; never printed)
grep -E '^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=' "$CFG/.env" | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//' | awk 'length >= 12' > "$GUARD_SNAP/secrets" || true
tr '\0' '\n' < "$GUARD_SNAP/gateway.env" | grep -E '^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=' | cut -d= -f2- | awk 'length >= 12' >> "$GUARD_SNAP/secrets" || true
log "snapshot: $(wc -l < "$GUARD_SNAP/sums") files checksummed, $SNAP_MSG"

# 2. real-model probe (one request; HTTP status only)
SMOKE=skip SMOKE_WHY=
if [ "${GUARD_SKIP_SMOKE:-}" = 1 ]; then SMOKE_WHY="GUARD_SKIP_SMOKE=1"
else
  base=$(envval API_BASE) model=$(envval MODEL_NAME)
  printf 'Authorization: Bearer %s\n' "$(envval API_KEY)" > "$GUARD_SNAP/auth.hdr"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -H @"$GUARD_SNAP/auth.hdr" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}" "${base%/}/chat/completions") || code=000
  rm -f "$GUARD_SNAP/auth.hdr"
  case $code in
    2??) SMOKE=run ;;
    429) SMOKE_WHY="model rate-limited (HTTP 429)" ;;
    *) SMOKE_WHY="model probe HTTP $code" ;;
  esac
fi
log "real-model smoke: $SMOKE${SMOKE_WHY:+ ($SMOKE_WHY)}"

# 3. stand-in
if port_up "$STANDIN_PORT"; then log "stand-in already listening on :$STANDIN_PORT (reused)"
else
  (PORT=$STANDIN_PORT STANDIN_LOG="$RUN_DIR/standin.jsonl" setsid node "$ROOT/test/fixtures/stand-in.mjs" </dev/null >"$RUN_DIR/standin.log" 2>&1 & echo $! > "$GUARD_SNAP/standin.pid")
  STANDIN_PID=$(cat "$GUARD_SNAP/standin.pid"); wait_port "$STANDIN_PORT" 20 || fail "stand-in did not start"
fi

# 4. suites
COMMON=(JIUWEN_LIVE=1 JIUWEN_GATEWAY_URL="$GW_URL" STANDIN_PORT="$STANDIN_PORT" STANDIN_LOG="$RUN_DIR/standin.jsonl"
  JW_USE_STANDIN_CMD="bash '$SELF' __use-standin" JW_RESTORE_CMD="bash '$SELF' __restore-real")
run_suite() { # name logfile env...
  local name=$1 out=$2; shift 2; local t=$(date +%s)
  log "▶ $name"
  (cd "$ROOT" && env "${COMMON[@]}" "$@" npm run --silent "$name") > "$out" 2>&1; local rc=$?
  sed -E 's/^/    /' "$out" | grep -E '^\s+(PASS|FAIL|SKIP|NOTE)|passed$' || true
  log "◀ $name exit $rc ($(( $(date +%s) - t ))s)"
  return $rc
}
LIVE_ENV=(LIVE_LOG_DIR="$RUN_DIR/live" LEAK_TURNS="${LEAK_TURNS:-200}" GW_KILL="bash '$SELF' __gw-kill" GW_START="bash '$SELF' __gw-start" DSH_BIN=)
[ "$SMOKE" = run ] && LIVE_ENV+=(LIVE_SMOKE=1)
ONLY=${GUARD_ONLY:-}
BACKEND=${GUARD_BACKEND:-agent-core}
case $ONLY in ""|live|plain-dsh) ;; *) log "GUARD_ONLY must be live or plain-dsh"; exit 2 ;; esac
case $BACKEND in agent-core|gateway|both|agentcore|ac) ;; *) log "GUARD_BACKEND must be agent-core|gateway|both"; exit 2 ;; esac
[ "$BACKEND" = agentcore ] || [ "$BACKEND" = ac ] && BACKEND=agent-core
skipped_suite() { printf 'SKIP  %s (GUARD_ONLY=%s)\n' "$1" "$ONLY" > "$2"; log "skip $1 (GUARD_ONLY=$ONLY)"; }
if [ "$ONLY" = plain-dsh ]; then skipped_suite test:live "$RUN_DIR/test-live.log"; LIVE_RC=0
else run_suite test:live "$RUN_DIR/test-live.log" "${LIVE_ENV[@]}" JIUWEN_BACKEND="${BACKEND%%,*}"; LIVE_RC=$?; fi
PLAIN_RC=0
PLAIN_AC_RC=0
PLAIN_GW_RC=0
run_plain() { # backend logfile
  local be=$1 out=$2
  run_suite test:plain-dsh "$out" DSH_BIN="$DSH_BIN" JIUWEN_BACKEND="$be"
}
if [ "$ONLY" = live ]; then
  skipped_suite test:plain-dsh "$RUN_DIR/test-plain-dsh.log"; PLAIN_RC=0
elif [ "$BACKEND" = both ]; then
  run_plain agent-core "$RUN_DIR/test-plain-dsh-agent-core.log"; PLAIN_AC_RC=$?
  run_plain gateway "$RUN_DIR/test-plain-dsh-gateway.log"; PLAIN_GW_RC=$?
  PLAIN_RC=0; [ $PLAIN_AC_RC = 0 ] || PLAIN_RC=$PLAIN_AC_RC; [ $PLAIN_GW_RC = 0 ] || PLAIN_RC=$PLAIN_GW_RC
  # Keep a combined alias for summary parsers
  { echo "=== agent-core ==="; cat "$RUN_DIR/test-plain-dsh-agent-core.log"; echo "=== gateway ==="; cat "$RUN_DIR/test-plain-dsh-gateway.log"; } > "$RUN_DIR/test-plain-dsh.log"
else
  run_plain "$BACKEND" "$RUN_DIR/test-plain-dsh.log"; PLAIN_RC=$?
fi

# 5. restore + verify
[ -n "$STANDIN_PID" ] && { kill -- -"$STANDIN_PID" 2>/dev/null; STANDIN_PID=; }
cur_base_sha() { local p; p=$(listener_pid "$GW_PORT"); [ -n "$p" ] && tr '\0' '\n' < "/proc/$p/environ" | grep -E '^API_BASE=' | sha256sum | cut -c1-16; }
if ! verify_sums || [ "$(cur_base_sha)" != "$REAL_API_BASE_SHA" ]; then log "suites left Jiuwen off its snapshot: restoring"; restore_real; fi
RESTORED=1
verify_sums && SUMS=ok || { SUMS=differ; fail "Jiuwen file checksums differ after restore: $(cd "$JW_HOME" && sha256sum -c "$GUARD_SNAP/sums" 2>/dev/null | grep -v ': OK$' | cut -d: -f1 | tr '\n' ' ')"; }
[ "$(cur_base_sha)" = "$REAL_API_BASE_SHA" ] || fail "Gateway is not back on the real model endpoint"
STATE_DIFF=$(state_cmd diff "$GUARD_SNAP/state.json") || STATE_DIFF="state read failed"
if [ -n "$STATE_DIFF" ]; then log "state differs ($STATE_DIFF): resetting"; STATE_DIFF=$(state_cmd restore "$GUARD_SNAP/state.json") || STATE_DIFF="state restore failed"; verify_sums || restore_real; fi
[ -z "$STATE_DIFF" ] || fail "Jiuwen state differs after restore: $STATE_DIFF"
PROT_MSG="untouched"
for p in "${!PROT[@]}"; do [ "$(listener_pid "$p")" = "${PROT[$p]}" ] || { PROT_MSG="CHANGED"; fail "protected port :$p changed (was pid '${PROT[$p]}', now '$(listener_pid "$p")')"; }; done
# leak scan: a secret value in any log → redact it and fail (the value is never printed)
if [ -s "$GUARD_SNAP/secrets" ]; then
  leaked=$(grep -rlF -f "$GUARD_SNAP/secrets" "$RUN_DIR" 2>/dev/null || true)
  if [ -n "$leaked" ]; then
    while IFS= read -r f; do while IFS= read -r s; do [ -n "$s" ] && F="$f" S="$s" node -e 'const fs=require("fs");const f=process.env.F;fs.writeFileSync(f,fs.readFileSync(f,"utf8").split(process.env.S).join("[REDACTED]"))'; done < "$GUARD_SNAP/secrets"; done <<< "$leaked"
    fail "secret value found (and redacted) in: $(echo "$leaked" | sed "s#$RUN_DIR/##" | tr '\n' ' ')"
  fi
fi

# 6. summary
counts() { grep -oE '^(live|plain-dsh): [0-9]+/[0-9]+ passed' "$1" | tail -1; }
fails_of() { awk '/^FAIL[ \t]/ { sub(/^FAIL[ \t]+/, ""); print "- " substr($0, 1, 200); next } /^[ \t]+FAIL[ \t]/ { sub(/^[ \t]+FAIL[ \t]+/, ""); print "  - " substr($0, 1, 200) }' "$1"; }
[ $LIVE_RC = 0 ] || fail "test:live exit $LIVE_RC"
[ $PLAIN_RC = 0 ] || fail "test:plain-dsh exit $PLAIN_RC"
LIVE_FAILS=$(fails_of "$RUN_DIR/test-live.log"); PLAIN_FAILS=$(fails_of "$RUN_DIR/test-plain-dsh.log")
LIVE_STEPS=$(grep -E '^(PASS|FAIL|SKIP|NOTE) ' "$RUN_DIR/test-live.log" | sed -E 's/\|/\\|/g; s/^(PASS|FAIL|SKIP|NOTE) +/| \1 | /; s/$/ |/')
PLAIN_PASS=$(grep -cE '^PASS ' "$RUN_DIR/test-plain-dsh.log"); PLAIN_FAIL=$(grep -cE '^FAIL ' "$RUN_DIR/test-plain-dsh.log")
STATUS=$([ ${#FAILS[@]} = 0 ] && echo PASS || echo FAIL)
[ -n "$ONLY" ] && [ "$STATUS" = PASS ] && STATUS="PARTIAL PASS (GUARD_ONLY=$ONLY)"
DUR=$(( ($(date +%s) - T0) / 60 ))
{
  echo "# Live guard $DAY — $STATUS"
  echo
  echo "- Run: $START (UTC+8), ${DUR} min, adapter \`$REV\`, dsh \`$("$DSH_BIN" --version 2>/dev/null | head -1)\`"
  echo "- Real-model smoke: ${SMOKE/run/ran (LIVE_SMOKE=1)}${SMOKE_WHY:+ — $SMOKE_WHY}"
  echo "- Jiuwen restore: checksums $SUMS ($(wc -l < "$GUARD_SNAP/sums") files), state ${STATE_DIFF:-identical}, gateway back on the real model endpoint"
  echo "- Protected ports (${PROTECT_PORTS}): $PROT_MSG (listener pid before: $(for p in "${!PROT[@]}"; do printf '%s=%s ' "$p" "${PROT[$p]:-none}"; done))"
  echo "- Logs: \`$RUN_DIR\`"
  echo
  echo "| Suite | Result | Count |"
  echo "|---|---|---|"
  if [ "$ONLY" = plain-dsh ]; then echo "| npm run test:live | SKIP (GUARD_ONLY) | — |"
  else echo "| npm run test:live | $([ $LIVE_RC = 0 ] && echo PASS || echo FAIL) | $(counts "$RUN_DIR/test-live.log" | cut -d' ' -f2) steps |"; fi
  if [ "$ONLY" = live ]; then echo "| npm run test:plain-dsh (both load orders) | SKIP (GUARD_ONLY) | — |"
  else echo "| npm run test:plain-dsh (both load orders) | $([ $PLAIN_RC = 0 ] && echo PASS || echo FAIL) | $PLAIN_PASS pass / $PLAIN_FAIL fail |"; fi
  echo
  echo "## test:live steps"
  echo
  echo "| Status | Step |"; echo "|---|---|"; echo "$LIVE_STEPS"
  if [ ${#FAILS[@]} -gt 0 ] || [ -n "$LIVE_FAILS$PLAIN_FAILS" ]; then
    echo; echo "## Failures"; echo
    for f in "${FAILS[@]}"; do echo "- $f"; done
    [ -n "$LIVE_FAILS" ] && { echo; echo "test:live (failing steps, then their failing checks; full output in live/<step>.log):"; echo; echo "$LIVE_FAILS"; }
    [ -n "$PLAIN_FAILS" ] && { echo; echo "test:plain-dsh (failing checks):"; echo; echo "$PLAIN_FAILS"; }
  fi
} > "$SUMMARY"
chmod 644 "$SUMMARY"
log "summary → $SUMMARY"
log "RESULT $STATUS${FAILS:+ (${#FAILS[@]} failure(s))}"
[ "$STATUS" != FAIL ]
