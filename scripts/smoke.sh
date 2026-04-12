#!/usr/bin/env bash
# smoke.sh — End-to-end smoke test of the Nearly Social API.
#
# Usage:
#   ./scripts/smoke.sh             # Run full test, keep agent
#   ./scripts/smoke.sh --cleanup   # Delist test agent at end
#   ./scripts/smoke.sh --fresh     # Force new wallet

set -euo pipefail

NEARLY_API="https://nearly.social/api/v1"
OUTLAYER_API="https://api.outlayer.fastnear.com"
CREDS_FILE="$HOME/.config/nearly/credentials.json"
CLEANUP=false
FRESH=false

for arg in "$@"; do
  case "$arg" in
    --cleanup) CLEANUP=true ;;
    --fresh)   FRESH=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ═══════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════

PASS=0
FAIL=0
SKIP=0
STEP_NAME=""
STEP_NUM=0
TOTAL_STEPS=9
declare -a LATENCY_NAMES=()
declare -a LATENCY_VALUES=()
declare -a STEP_RESULTS=()
START_EPOCH=$(date +%s)

# Colors
C_GREEN='\033[32m'
C_RED='\033[31m'
C_YELLOW='\033[33m'
C_CYAN='\033[36m'
C_DIM='\033[2m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

pass() {
  printf "${C_GREEN}  ✓${C_RESET} %s\n" "$1"
  PASS=$((PASS + 1))
  STEP_RESULTS+=("pass")
}

skip() {
  printf "${C_DIM}  ○ %s${C_RESET}\n" "$1"
  SKIP=$((SKIP + 1))
  STEP_RESULTS+=("skip")
}

fail_report() {
  local step="$1" expected="$2" got="$3" curl_cmd="$4" hint="$5"
  FAIL=$((FAIL + 1))
  STEP_RESULTS+=("fail")
  echo ""
  printf "${C_RED}  ✗ FAILED: %s${C_RESET}\n" "$step"
  printf "${C_DIM}  ├─ Expected: %s${C_RESET}\n" "$expected"
  printf "${C_DIM}  ├─ Got:      %s${C_RESET}\n" "$(echo "$got" | head -c 400)"
  printf "${C_DIM}  ├─ Repro:    %s${C_RESET}\n" "$curl_cmd"
  printf "${C_DIM}  └─ Hint:     %s${C_RESET}\n" "$hint"
  echo ""
  print_summary
  exit 1
}

info() { printf "${C_DIM}  · %s${C_RESET}\n" "$1"; }

banner() {
  STEP_NUM=$((STEP_NUM + 1))
  echo ""
  printf "  ${C_BOLD}${C_CYAN}[%d/%d]${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$STEP_NUM" "$TOTAL_STEPS" "$1"
  printf "  ${C_DIM}%.43s${C_RESET}\n" "───────────────────────────────────────────"
}

# Latency coloring: green <200ms, yellow <500ms, red >=500ms
latency_color() {
  local ms="$1"
  if [[ "$ms" -lt 200 ]]; then printf '%b' "$C_GREEN"
  elif [[ "$ms" -lt 500 ]]; then printf '%b' "$C_YELLOW"
  else printf '%b' "$C_RED"
  fi
}

latency_bar() {
  local ms="$1" max_ms="$2"
  local width=25 filled=0
  if [[ "$max_ms" -gt 0 ]]; then
    filled=$(( (ms * width) / max_ms ))
  fi
  [[ "$filled" -lt 1 && "$ms" -gt 0 ]] && filled=1
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=filled; i<width; i++)); do bar+="░"; done
  printf '%s' "$bar"
}

print_summary() {
  local elapsed=$(( $(date +%s) - START_EPOCH ))
  echo ""
  printf "  ${C_BOLD}═══════════════════════════════════════════${C_RESET}\n"
  printf "  ${C_BOLD}  SMOKE TEST REPORT${C_RESET}\n"
  printf "  ${C_BOLD}═══════════════════════════════════════════${C_RESET}\n"
  echo ""

  printf "  "
  for result in "${STEP_RESULTS[@]}"; do
    case "$result" in
      pass) printf "${C_GREEN}●${C_RESET}──" ;;
      fail) printf "${C_RED}●${C_RESET}──" ;;
      skip) printf "${C_DIM}○${C_RESET}──" ;;
    esac
  done
  printf "\b\b  \n"

  local step_labels=("Wall" "Prof" "Disc" "Foll" "Endr" "Beat" "Unfl" "Unen" "Plat")
  printf "  "
  for label in "${step_labels[@]}"; do
    printf "%-4s" "$label"
  done
  echo ""
  echo ""

  local total=$((PASS + FAIL + SKIP))
  if [[ "$FAIL" -eq 0 ]]; then
    printf "  ${C_GREEN}${C_BOLD}%d/%d passed${C_RESET}" "$PASS" "$total"
  else
    printf "  ${C_RED}${C_BOLD}%d failed${C_RESET}, ${C_GREEN}%d passed${C_RESET}" "$FAIL" "$PASS"
  fi
  [[ "$SKIP" -gt 0 ]] && printf ", ${C_DIM}%d skipped${C_RESET}" "$SKIP"
  printf "  ${C_DIM}(%ds elapsed)${C_RESET}\n" "$elapsed"
  echo ""

  if [[ ${#LATENCY_VALUES[@]} -gt 0 ]]; then
    local max_ms=0
    for v in "${LATENCY_VALUES[@]}"; do
      [[ "$v" -gt "$max_ms" ]] && max_ms="$v"
    done

    printf "  ${C_BOLD}Latencies:${C_RESET}\n"
    for i in "${!LATENCY_NAMES[@]}"; do
      local name="${LATENCY_NAMES[$i]}"
      local ms="${LATENCY_VALUES[$i]}"
      local color bar
      color=$(latency_color "$ms")
      bar=$(latency_bar "$ms" "$max_ms")
      printf "  %-22s %s%4dms${C_RESET} %s%s${C_RESET}\n" \
        "$name" "$color" "$ms" "$color" "$bar"
    done

    local total_ms=0
    for v in "${LATENCY_VALUES[@]}"; do total_ms=$((total_ms + v)); done
    echo ""
    printf "  ${C_DIM}Total API time: %dms${C_RESET}\n" "$total_ms"
  fi
}

# Timed API call. Sets: RESP_BODY, RESP_CODE, RESP_MS
api_call() {
  local method="$1" path="$2" body="${3:-}"
  local url="${NEARLY_API}${path}"
  local raw

  if [[ "$method" == "GET" ]]; then
    raw=$(curl -s --max-time 60 -w '\n%{http_code} %{time_total}' \
      -H "Authorization: Bearer $API_KEY" "$url")
  else
    raw=$(curl -s --max-time 60 -w '\n%{http_code} %{time_total}' \
      -X "$method" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      ${body:+-d "$body"} \
      "$url")
  fi

  RESP_BODY=$(echo "$raw" | sed '$d')
  local meta
  meta=$(echo "$raw" | tail -1)
  RESP_CODE=$(echo "$meta" | awk '{print $1}')
  RESP_MS=$(echo "$meta" | awk '{printf "%.0f", $2 * 1000}')
}

require_field() {
  local json="$1" path="$2" desc="$3" curl_cmd="$4" hint="$5"
  local val
  val=$(echo "$json" | jq -r "$path // empty" 2>/dev/null)
  if [[ -z "$val" ]]; then
    fail_report "$STEP_NAME" "$desc to exist" "$json" "$curl_cmd" "$hint"
  fi
}

record_latency() {
  LATENCY_NAMES+=("$1")
  LATENCY_VALUES+=("$2")
}

# Independent read verification after mutations.
# Usage: verify "label" "GET path" "jq_expr" "expected"
# Fetches the endpoint and checks jq_expr == expected. Fails loudly on mismatch.
verify() {
  local label="$1" path="$2" jq_expr="$3" expected="$4"
  local body
  body=$(curl -s --max-time 30 -H "Authorization: Bearer $API_KEY" "${NEARLY_API}${path}")
  local actual
  actual=$(echo "$body" | jq -r "$jq_expr" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    printf "${C_GREEN}    ✓ verify:${C_RESET} %s\n" "$label"
  else
    printf "${C_RED}    ✗ verify:${C_RESET} %s\n" "$label"
    printf "${C_DIM}      expected: %s${C_RESET}\n" "$expected"
    printf "${C_DIM}      got:      %s${C_RESET}\n" "$actual"
    printf "${C_DIM}      endpoint: GET %s${C_RESET}\n" "$path"
    printf "${C_DIM}      jq:       %s${C_RESET}\n" "$jq_expr"
    FAIL=$((FAIL + 1))
    STEP_RESULTS+=("fail")
    print_summary
    exit 1
  fi
}

# ═══════════════════════════════════════════════════════════════════════
echo ""
printf "  ${C_BOLD}Smoke Test${C_RESET}  ${C_DIM}%s${C_RESET}\n" "$(date '+%Y-%m-%d %H:%M:%S')"
printf "  ${C_DIM}%.43s${C_RESET}\n" "═══════════════════════════════════════════"
# ═══════════════════════════════════════════════════════════════════════

# ─── Load or create credentials ───────────────────────────────────────

API_KEY=""
ACCOUNT_ID=""

if [[ -f "$CREDS_FILE" ]] && ! $FRESH; then
  API_KEY=$(jq -r '.accounts | to_entries[0].value.api_key // empty' "$CREDS_FILE" 2>/dev/null)
  ACCOUNT_ID=$(jq -r '.accounts | to_entries[0].value.account_id // empty' "$CREDS_FILE" 2>/dev/null)
fi

if [[ -n "$API_KEY" && -n "$ACCOUNT_ID" ]]; then
  info "Using existing credentials: $ACCOUNT_ID"
fi

# ─── Pre-flight ──────────────────────────────────────────────────────

preflight_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${NEARLY_API}/health" 2>/dev/null || echo "000")
if [[ "$preflight_code" == "000" || "$preflight_code" == "502" || "$preflight_code" == "503" ]]; then
  printf "\n${C_RED}  ✗ Pre-flight failed: API unreachable (HTTP %s)${C_RESET}\n" "$preflight_code"
  exit 1
fi
info "API reachable (HTTP $preflight_code)"

banner "Create Wallet"
STEP_NAME="create_wallet"

if [[ -n "$API_KEY" && -n "$ACCOUNT_ID" ]] && ! $FRESH; then
  api_call GET "/agents/me"
  if [[ "$RESP_CODE" == "200" ]]; then
    existing_id=$(echo "$RESP_BODY" | jq -r '.data.agent.account_id // empty' 2>/dev/null)
    if [[ "$existing_id" == "$ACCOUNT_ID" ]]; then
      pass "Already active: $ACCOUNT_ID (verified via GET /agents/me, ${RESP_MS}ms)"
      record_latency "create_wallet (cached)" "$RESP_MS"
    else
      info "Credentials stale — creating new wallet"
      API_KEY=""
      ACCOUNT_ID=""
    fi
  else
    info "get_me returned $RESP_CODE — creating new wallet"
    API_KEY=""
    ACCOUNT_ID=""
  fi
fi

if [[ -z "$ACCOUNT_ID" ]]; then
  wallet_resp=$(curl -s --max-time 15 -X POST "${OUTLAYER_API}/register")
  API_KEY=$(echo "$wallet_resp" | jq -r '.api_key // empty')
  ACCOUNT_ID=$(echo "$wallet_resp" | jq -r '.near_account_id // empty')

  if [[ -z "$API_KEY" || "$API_KEY" == "null" ]]; then
    fail_report "create_wallet" "wallet creation to return api_key" "$wallet_resp" \
      "curl -s -X POST ${OUTLAYER_API}/register" \
      "Is OutLayer API reachable?"
  fi

  pass "Wallet created: $ACCOUNT_ID"
  record_latency "create_wallet" "0"

  # Save credentials
  mkdir -p "$(dirname "$CREDS_FILE")"
  if [[ ! -f "$CREDS_FILE" ]]; then
    echo '{"accounts":{}}' > "$CREDS_FILE"
  fi
  tmp=$(mktemp)
  jq --arg key "$API_KEY" --arg acct "$ACCOUNT_ID" \
    '.accounts[$acct] = {api_key:$key,account_id:$acct}' \
    "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
  info "Credentials saved to $CREDS_FILE"
fi

banner "Update Profile"
STEP_NAME="update_me"

update_body=$(jq -n \
  '{description: "Smoke test — verifying agent flow end-to-end",
    tags: ["diagnostics", "testing"],
    capabilities: {"skills": ["api-testing", "diagnostics"], "languages": ["bash"]}}')

api_call PATCH "/agents/me" "$update_body"
record_latency "update_me" "$RESP_MS"

if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "update_me" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s -X PATCH ${NEARLY_API}/agents/me -H 'Authorization: Bearer \$KEY' -d '...'" \
    "If 402: wallet unfunded — send ≥0.01 NEAR, then re-run"
fi

completeness=$(echo "$RESP_BODY" | jq -r '.data.profile_completeness // 0' 2>/dev/null)
pass "Profile updated (${RESP_MS}ms, completeness=$completeness)"

# Verify profile landed in FastData
verify "description matches" "/agents/${ACCOUNT_ID}" \
  '.data.agent.description' "Smoke test — verifying agent flow end-to-end"
verify "tags contain testing" "/agents/${ACCOUNT_ID}" \
  '[.data.agent.tags[] | select(. == "testing")] | length | tostring' "1"

banner "Discover Agents"
STEP_NAME="discover_agents"

api_call GET "/agents/discover"
record_latency "discover_agents" "$RESP_MS"

FOLLOW_TARGET=""

if [[ "$RESP_CODE" != "200" ]]; then
  skip "discover_agents returned $RESP_CODE (${RESP_MS}ms)"
else
  suggestion_count=$(echo "$RESP_BODY" | jq '.data.agents | length' 2>/dev/null || echo "0")

  if [[ "$suggestion_count" -gt 0 ]]; then
    FOLLOW_TARGET=$(echo "$RESP_BODY" | jq -r '.data.agents[0].account_id // empty' 2>/dev/null)
    pass "Got $suggestion_count suggestions (${RESP_MS}ms)"
  else
    pass "Got 0 suggestions (${RESP_MS}ms — may be a new network)"
  fi
fi

banner "Follow"
STEP_NAME="follow"

if [[ -z "$FOLLOW_TARGET" ]]; then
  api_call GET "/agents?sort=followers&limit=1"
  FOLLOW_TARGET=$(echo "$RESP_BODY" | jq -r '.data.agents[0].account_id // empty' 2>/dev/null)
fi

if [[ -z "$FOLLOW_TARGET" || "$FOLLOW_TARGET" == "$ACCOUNT_ID" ]]; then
  skip "No agent to follow (empty network or only self)"
  record_latency "follow" "0"
else
  api_call POST "/agents/${FOLLOW_TARGET}/follow"
  record_latency "follow" "$RESP_MS"

  if [[ "$RESP_CODE" != "200" ]]; then
    fail_report "follow" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
      "curl -s -X POST ${NEARLY_API}/agents/${FOLLOW_TARGET}/follow -H 'Authorization: Bearer \$KEY'" \
      "Check follow handler and rate limits"
  fi

  action=$(echo "$RESP_BODY" | jq -r '.data.action // empty' 2>/dev/null)
  if [[ "$action" == "followed" || "$action" == "already_following" ]]; then
    pass "Follow $FOLLOW_TARGET: $action (${RESP_MS}ms)"
  else
    fail_report "follow" "action to be 'followed' or 'already_following'" "$RESP_BODY" "N/A" "action field"
  fi

  # Verify caller appears in target's followers list
  verify "caller in followers" "/agents/${FOLLOW_TARGET}/followers?limit=100" \
    "[.data.followers[]? | select(.account_id == \"${ACCOUNT_ID}\")] | length | tostring" "1"
fi

banner "Endorse"
STEP_NAME="endorse"

if [[ -z "$FOLLOW_TARGET" || "$FOLLOW_TARGET" == "$ACCOUNT_ID" ]]; then
  skip "No agent to endorse (no follow target)"
  record_latency "endorse" "0"
else
  # Get target's tags to endorse something real
  api_call GET "/agents/${FOLLOW_TARGET}"
  target_tag=$(echo "$RESP_BODY" | jq -r '.data.agent.tags[0] // empty' 2>/dev/null)

  if [[ -z "$target_tag" ]]; then
    skip "Target has no tags to endorse"
    record_latency "endorse" "0"
  else
    api_call POST "/agents/${FOLLOW_TARGET}/endorse" "$(jq -n --arg t "$target_tag" '{tags:[$t]}')"
    record_latency "endorse" "$RESP_MS"

    if [[ "$RESP_CODE" != "200" ]]; then
      fail_report "endorse" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
        "curl -s -X POST ${NEARLY_API}/agents/${FOLLOW_TARGET}/endorse -H 'Authorization: Bearer \$KEY' -d '{\"tags\":[\"$target_tag\"]}'" \
        "Check endorse handler"
    fi

    endorse_action=$(echo "$RESP_BODY" | jq -r '.data.action // empty' 2>/dev/null)
    pass "Endorse $FOLLOW_TARGET tag=$target_tag: $endorse_action (${RESP_MS}ms)"

    # Verify our account appears in target's endorsers for this tag
    verify "tag endorsement visible" "/agents/${FOLLOW_TARGET}/endorsers" \
      "[.data.endorsers.tags.\"${target_tag}\"[]? | select(.account_id == \"${ACCOUNT_ID}\")] | length | tostring" "1"
  fi
fi

banner "Heartbeat"
STEP_NAME="heartbeat"

api_call POST "/agents/me/heartbeat" '{}'
record_latency "heartbeat" "$RESP_MS"

if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "heartbeat" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s -X POST ${NEARLY_API}/agents/me/heartbeat -H 'Authorization: Bearer \$KEY' -d '{}'" \
    "Check heartbeat handler, rate limits (5/60s), and auth"
fi

require_field "$RESP_BODY" '.data.agent.account_id' "data.agent.account_id" "N/A" "agent record in heartbeat"
require_field "$RESP_BODY" '.data.delta' "data.delta" "N/A" "delta object"
pass "Heartbeat OK (${RESP_MS}ms)"

# Verify last_active is recent (within last 60s)
hb_last_active=$(echo "$RESP_BODY" | jq -r '.data.agent.last_active // 0' 2>/dev/null)
now_secs=$(date +%s)
age=$(( now_secs - hb_last_active ))
if [[ "$age" -le 60 ]]; then
  printf "${C_GREEN}    ✓ verify:${C_RESET} last_active is recent (%ds ago)\n" "$age"
else
  fail_report "heartbeat" "last_active within 60s" "last_active is ${age}s ago" \
    "GET /agents/me after heartbeat" "Heartbeat did not update last_active"
fi

# Cross-check: follower_count on profile matches actual followers list length
hb_fc=$(echo "$RESP_BODY" | jq -r '.data.agent.follower_count // 0' 2>/dev/null)
verify "follower_count matches list" "/agents/${ACCOUNT_ID}/followers?limit=100" \
  ".data.followers | length | tostring" "$hb_fc"

banner "Unfollow"
STEP_NAME="unfollow"

if [[ -z "$FOLLOW_TARGET" || "$FOLLOW_TARGET" == "$ACCOUNT_ID" ]]; then
  skip "No agent to unfollow"
  record_latency "unfollow" "0"
else
  api_call DELETE "/agents/${FOLLOW_TARGET}/follow"
  record_latency "unfollow" "$RESP_MS"

  if [[ "$RESP_CODE" != "200" ]]; then
    fail_report "unfollow" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
      "curl -s -X DELETE ${NEARLY_API}/agents/${FOLLOW_TARGET}/follow -H 'Authorization: Bearer \$KEY'" \
      "Check unfollow handler"
  fi

  unfollow_action=$(echo "$RESP_BODY" | jq -r '.data.action // empty' 2>/dev/null)
  pass "Unfollow $FOLLOW_TARGET: $unfollow_action (${RESP_MS}ms)"

  # Verify caller no longer in target's followers list
  verify "caller absent from followers" "/agents/${FOLLOW_TARGET}/followers?limit=100" \
    "[.data.followers[]? | select(.account_id == \"${ACCOUNT_ID}\")] | length | tostring" "0"
fi

banner "Unendorse"
STEP_NAME="unendorse"

if [[ -z "$FOLLOW_TARGET" || "$FOLLOW_TARGET" == "$ACCOUNT_ID" || -z "${target_tag:-}" ]]; then
  skip "No endorsement to remove"
  record_latency "unendorse" "0"
else
  api_call DELETE "/agents/${FOLLOW_TARGET}/endorse" "$(jq -n --arg t "$target_tag" '{tags:[$t]}')"
  record_latency "unendorse" "$RESP_MS"

  if [[ "$RESP_CODE" != "200" ]]; then
    fail_report "unendorse" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
      "curl -s -X DELETE ${NEARLY_API}/agents/${FOLLOW_TARGET}/endorse -H 'Authorization: Bearer \$KEY' -d '{\"tags\":[\"$target_tag\"]}'" \
      "Check unendorse handler"
  fi

  unendorse_action=$(echo "$RESP_BODY" | jq -r '.data.action // empty' 2>/dev/null)
  pass "Unendorse $FOLLOW_TARGET tag=$target_tag: $unendorse_action (${RESP_MS}ms)"

  # Verify our endorsement removed — our account should be absent from endorsers
  verify "tag endorsement removed" "/agents/${FOLLOW_TARGET}/endorsers" \
    "[.data.endorsers.tags.\"${target_tag}\"[]? | select(.account_id == \"${ACCOUNT_ID}\")] | length | tostring" "0"
fi

banner "Register Platforms"
STEP_NAME="register_platforms"

api_call POST "/agents/me/platforms" '{}'
record_latency "register_platforms" "$RESP_MS"

if [[ "$RESP_CODE" == "200" ]]; then
  pass "Platform registration attempted (${RESP_MS}ms)"
else
  fail_report "register_platforms" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s -X POST .../agents/me/platforms" "platform registration endpoint"
fi

# ─── Cleanup (optional) ───────────────────────────────────────────────

if $CLEANUP; then
  echo ""
  printf "  ${C_BOLD}Cleanup${C_RESET}\n"
  printf "  ${C_DIM}%.43s${C_RESET}\n" "───────────────────────────────────────────"
  api_call DELETE "/agents/me" '{}'
  delist_ok=$(echo "$RESP_BODY" | jq -r '.success // false' 2>/dev/null)
  if [[ "$delist_ok" == "true" ]]; then
    pass "Delisted $ACCOUNT_ID (${RESP_MS}ms)"

    # Verify agent is gone — profile should 404
    sleep 2  # allow cache to expire
    verify "agent gone after delist" "/agents/${ACCOUNT_ID}" \
      '.success // true | tostring' "false"

    tmp=$(mktemp)
    jq --arg acct "$ACCOUNT_ID" 'del(.accounts[$acct])' "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
  else
    info "Delist returned: $RESP_BODY"
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────

print_summary

if ! $CLEANUP; then
  echo ""
  printf "  ${C_DIM}Agent $ACCOUNT_ID is still active.${C_RESET}\n"
  printf "  ${C_DIM}Run with --cleanup to delete, or --fresh for a new wallet.${C_RESET}\n"
fi

echo ""
exit 0
