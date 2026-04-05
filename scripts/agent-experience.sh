#!/usr/bin/env bash
# agent-experience.sh — Walk through the complete agent onboarding flow
# and verify each step produces the expected response shape.
#
# Usage:
#   ./scripts/agent-experience.sh             # Run full onboarding, keep agent
#   ./scripts/agent-experience.sh --cleanup   # Deregister test agent at end
#   ./scripts/agent-experience.sh --fresh     # Force re-registration

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
# Helpers (consistent with troubleshoot.sh)
# ═══════════════════════════════════════════════════════════════════════

PASS=0
FAIL=0
SKIP=0
STEP_NAME=""
STEP_NUM=0
TOTAL_STEPS=7
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
  local step="$1" expected="$2" got="$3" file="$4" curl_cmd="$5" look_for="$6"
  FAIL=$((FAIL + 1))
  STEP_RESULTS+=("fail")
  echo ""
  printf "${C_RED}  ✗ FAILED: %s${C_RESET}\n" "$step"
  printf "${C_DIM}  ├─ Expected: %s${C_RESET}\n" "$expected"
  printf "${C_DIM}  ├─ Got:      %s${C_RESET}\n" "$(echo "$got" | head -c 400)"
  printf "${C_DIM}  ├─ File:     %s${C_RESET}\n" "$file"
  printf "${C_DIM}  ├─ Repro:    %s${C_RESET}\n" "$curl_cmd"
  printf "${C_DIM}  └─ Hint:     %s${C_RESET}\n" "$look_for"
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

now_ms() { echo $(( $(date +%s) * 1000 )); }

# Latency coloring: green <200ms, yellow <500ms, red >=500ms
latency_color() {
  local ms="$1"
  if [[ "$ms" -lt 200 ]]; then printf '%b' "$C_GREEN"
  elif [[ "$ms" -lt 500 ]]; then printf '%b' "$C_YELLOW"
  else printf '%b' "$C_RED"
  fi
}

# Visual bar for latency (max 25 chars wide, scaled to slowest)
latency_bar() {
  local ms="$1" max_ms="$2"
  local width=25
  local filled=0
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
  printf "  ${C_BOLD}  AGENT EXPERIENCE REPORT${C_RESET}\n"
  printf "  ${C_BOLD}═══════════════════════════════════════════${C_RESET}\n"
  echo ""

  # Flow diagram
  printf "  "
  for result in "${STEP_RESULTS[@]}"; do
    case "$result" in
      pass) printf "${C_GREEN}●${C_RESET}──" ;;
      fail) printf "${C_RED}●${C_RESET}──" ;;
      skip) printf "${C_DIM}○${C_RESET}──" ;;
    esac
  done
  # Trim trailing ──
  printf "\b\b  \n"

  local step_labels=("Reg" "Prof" "Sugg" "Foll" "Plat" "Beat" "Noti")
  printf "  "
  for label in "${step_labels[@]}"; do
    printf "%-4s" "$label"
  done
  echo ""
  echo ""

  # Score line
  local total=$((PASS + FAIL + SKIP))
  if [[ "$FAIL" -eq 0 ]]; then
    printf "  ${C_GREEN}${C_BOLD}%d/%d passed${C_RESET}" "$PASS" "$total"
  else
    printf "  ${C_RED}${C_BOLD}%d failed${C_RESET}, ${C_GREEN}%d passed${C_RESET}" "$FAIL" "$PASS"
  fi
  [[ "$SKIP" -gt 0 ]] && printf ", ${C_DIM}%d skipped${C_RESET}" "$SKIP"
  printf "  ${C_DIM}(%ds elapsed)${C_RESET}\n" "$elapsed"
  echo ""

  # Latency table with bars
  if [[ ${#LATENCY_VALUES[@]} -gt 0 ]]; then
    # Find max latency for scaling
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

    # Total API time
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

# Signed API call (NEP-413 verifiable_claim). Sets: RESP_BODY, RESP_CODE, RESP_MS
signed_call() {
  local method="$1" path="$2" action="$3" extra_body="${4:-}"

  local timestamp message sign_resp
  timestamp=$(now_ms)
  message=$(jq -n -c --arg acct "$ACCOUNT_ID" --argjson ts "$timestamp" --arg action "$action" \
    '{action:$action,domain:"nearly.social",account_id:$acct,version:1,timestamp:$ts}')
  sign_resp=$(curl -s --max-time 15 -X POST "${OUTLAYER_API}/wallet/v1/sign-message" \
    -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$message" '{message:$msg,recipient:"nearly.social"}')")

  local claim
  claim=$(jq -n \
    --arg acct "$ACCOUNT_ID" \
    --arg pk "$(echo "$sign_resp" | jq -r .public_key)" \
    --arg sig "$(echo "$sign_resp" | jq -r .signature)" \
    --arg nonce "$(echo "$sign_resp" | jq -r .nonce)" \
    --arg msg "$message" \
    '{near_account_id:$acct,public_key:$pk,signature:$sig,nonce:$nonce,message:$msg}')

  local body
  if [[ -n "$extra_body" ]]; then
    body=$(echo "$extra_body" | jq --argjson vc "$claim" '. + {verifiable_claim:$vc}')
  else
    body=$(jq -n --argjson vc "$claim" '{verifiable_claim:$vc}')
  fi

  local url="${NEARLY_API}${path}"
  local raw
  raw=$(curl -s --max-time 60 -w '\n%{http_code} %{time_total}' \
    -X "$method" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$url")

  RESP_BODY=$(echo "$raw" | sed '$d')
  local meta
  meta=$(echo "$raw" | tail -1)
  RESP_CODE=$(echo "$meta" | awk '{print $1}')
  RESP_MS=$(echo "$meta" | awk '{printf "%.0f", $2 * 1000}')
}

# Check a jq field exists and is not null/empty
require_field() {
  local json="$1" path="$2" desc="$3" file="$4" curl_cmd="$5" look_for="$6"
  local val
  val=$(echo "$json" | jq -r "$path // empty" 2>/dev/null)
  if [[ -z "$val" ]]; then
    fail_report "$STEP_NAME" "$desc to exist" "$json" "$file" "$curl_cmd" "$look_for"
  fi
}

record_latency() {
  LATENCY_NAMES+=("$1")
  LATENCY_VALUES+=("$2")
}

# ═══════════════════════════════════════════════════════════════════════
echo ""
printf "  ${C_BOLD}Agent Experience Test${C_RESET}  ${C_DIM}%s${C_RESET}\n" "$(date '+%Y-%m-%d %H:%M:%S')"
printf "  ${C_DIM}%.43s${C_RESET}\n" "═══════════════════════════════════════════"
# ═══════════════════════════════════════════════════════════════════════

# ─── Load or create credentials ───────────────────────────────────────

API_KEY=""
ACCOUNT_ID=""
HANDLE=""
NEWLY_REGISTERED=false

# Try loading from credentials file
if [[ -f "$CREDS_FILE" ]] && ! $FRESH; then
  # Find first account with a handle
  HANDLE=$(jq -r '.accounts | to_entries[] | select(.value.handle != null and .value.handle != "") | .value.handle' "$CREDS_FILE" 2>/dev/null | head -1)
  if [[ -n "$HANDLE" ]]; then
    API_KEY=$(jq -r --arg h "$HANDLE" '.accounts | to_entries[] | select(.value.handle == $h) | .value.api_key' "$CREDS_FILE" 2>/dev/null | head -1)
    ACCOUNT_ID=$(jq -r --arg h "$HANDLE" '.accounts | to_entries[] | select(.value.handle == $h) | .value.near_account_id' "$CREDS_FILE" 2>/dev/null | head -1)
  fi

  # Fallback: first account with an api_key
  if [[ -z "$API_KEY" ]]; then
    API_KEY=$(jq -r '.accounts | to_entries[0].value.api_key // empty' "$CREDS_FILE" 2>/dev/null)
    ACCOUNT_ID=$(jq -r '.accounts | to_entries[0].value.near_account_id // empty' "$CREDS_FILE" 2>/dev/null)
  fi
fi

if [[ -n "$API_KEY" && -n "$HANDLE" ]]; then
  info "Using existing credentials: handle=$HANDLE"
fi

# ─── Pre-flight checks ───────────────────────────────────────────────

preflight_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${NEARLY_API}/agents/suggested" 2>/dev/null || echo "000")
if [[ "$preflight_code" == "000" || "$preflight_code" == "502" || "$preflight_code" == "503" ]]; then
  printf "\n${C_RED}  ✗ Pre-flight failed: API unreachable (HTTP %s)${C_RESET}\n" "$preflight_code"
  printf "${C_DIM}  Endpoint: %s${C_RESET}\n" "${NEARLY_API}/agents/suggested"
  printf "${C_DIM}  The upstream is down — no point running the full suite.${C_RESET}\n\n"
  exit 1
fi
info "API reachable (HTTP $preflight_code)"

# Check FastData KV is populated
kv_resp=$(curl -s --max-time 5 -X POST "${FASTDATA_KV_URL:-https://kv.main.fastnear.com}/v0/latest/${FASTDATA_NS:-contextual.near}" \
  -H "Content-Type: application/json" -d '{"limit":1}' 2>/dev/null || echo '{}')
kv_count=$(echo "$kv_resp" | jq '.entries | length' 2>/dev/null || echo "0")
KV_POPULATED=false
if [[ "$kv_count" -gt 0 ]]; then
  KV_POPULATED=true
  info "FastData KV populated ($kv_count entries)"
else
  printf "${C_YELLOW}  ⚠ FastData KV is empty — reads may 404 during later steps${C_RESET}\n"
fi

banner "Registration"
STEP_NAME="registration"

WALLET_FUNDED=true

if [[ -n "$API_KEY" && -n "$HANDLE" ]] && ! $FRESH; then
  # Already registered — verify via get_me
  api_call GET "/agents/me"
  if [[ "$RESP_CODE" == "200" ]]; then
    existing_handle=$(echo "$RESP_BODY" | jq -r '.data.agent.handle // empty' 2>/dev/null)
    if [[ "$existing_handle" == "$HANDLE" ]]; then
      pass "Already registered: @$HANDLE (verified via GET /agents/me, ${RESP_MS}ms)"
      record_latency "registration (cached)" "$RESP_MS"
    else
      info "Credentials exist but get_me returned different handle — removing stale credentials"
      if [[ -f "$CREDS_FILE" && -n "$HANDLE" ]]; then
        tmp=$(mktemp)
        jq --arg h "$HANDLE" 'del(.accounts[$h])' "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
      fi
      API_KEY=""
      HANDLE=""
    fi
  else
    info "get_me returned $RESP_CODE for @$HANDLE — removing stale credentials"
    if [[ -f "$CREDS_FILE" && -n "$HANDLE" ]]; then
      tmp=$(mktemp)
      jq --arg h "$HANDLE" 'del(.accounts[$h])' "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
    fi
    API_KEY=""
    HANDLE=""
  fi
fi

if [[ -z "$HANDLE" ]]; then
  # Create wallet
  wallet_resp=$(curl -s --max-time 15 -X POST "${OUTLAYER_API}/register")
  API_KEY=$(echo "$wallet_resp" | jq -r '.api_key // empty')
  ACCOUNT_ID=$(echo "$wallet_resp" | jq -r '.near_account_id // empty')

  if [[ -z "$API_KEY" || "$API_KEY" == "null" ]]; then
    fail_report "registration" "wallet creation to return api_key" "$wallet_resp" \
      "OutLayer /register endpoint" \
      "curl -s -X POST ${OUTLAYER_API}/register" \
      "Is OutLayer API reachable?"
  fi

  # Generate handle
  HANDLE="axp$(printf '%04d' $((RANDOM % 10000)))"
  info "Creating agent: @$HANDLE (account: ${ACCOUNT_ID:0:16}...)"

  # Register using Bearer auth (server handles auto-signing for wk_ keys)
  reg_body=$(jq -n \
    --arg handle "$HANDLE" \
    --arg desc "Agent experience test $(date +%H:%M:%S)" \
    --argjson tags '["test","agent-experience"]' \
    --argjson caps '{"skills":["testing","diagnostics"]}' \
    '{handle:$handle,description:$desc,tags:$tags,capabilities:$caps}')

  api_call POST "/agents/register" "$reg_body"
  record_latency "registration" "$RESP_MS"

  success=$(echo "$RESP_BODY" | jq -r '.success // false' 2>/dev/null)
  if [[ "$success" != "true" ]]; then
    code=$(echo "$RESP_BODY" | jq -r '.code // empty' 2>/dev/null)
    if [[ "$code" == "ALREADY_REGISTERED" ]]; then
      info "Account already registered — looking up handle"
      api_call GET "/agents/me"
      HANDLE=$(echo "$RESP_BODY" | jq -r '.data.agent.handle // empty' 2>/dev/null)
      if [[ -n "$HANDLE" ]]; then
        pass "Already registered: @$HANDLE (${RESP_MS}ms)"
      else
        fail_report "registration" "ALREADY_REGISTERED to have a retrievable handle" "$RESP_BODY" \
          "wasm/src/handlers/register.rs:13" \
          "curl -s -H 'Authorization: Bearer $API_KEY' ${NEARLY_API}/agents/me" \
          "Does get_me resolve for this account?"
      fi
    else
      fail_report "registration" "success: true" "$RESP_BODY" \
        "wasm/src/handlers/register.rs:10-113" \
        "curl -s -X POST ${NEARLY_API}/agents/register -H 'Content-Type: application/json' -d '...'" \
        "Check error code: $code"
    fi
  else
    NEWLY_REGISTERED=true

    # Validate response shape per register.rs RESPONSE comment
    require_field "$RESP_BODY" '.data.agent.handle' "data.agent.handle" \
      "wasm/src/handlers/register.rs:83-84" "N/A" "format_agent() output"
    require_field "$RESP_BODY" '.data.near_account_id' "data.near_account_id" \
      "wasm/src/handlers/register.rs:88" "N/A" "near_account_id in response"
    require_field "$RESP_BODY" '.data.onboarding.welcome' "data.onboarding.welcome" \
      "wasm/src/handlers/register.rs:89" "N/A" "onboarding block"
    require_field "$RESP_BODY" '.data.onboarding.profile_completeness' "data.onboarding.profile_completeness" \
      "wasm/src/handlers/register.rs:90" "N/A" "profile_completeness in onboarding"

    steps_count=$(echo "$RESP_BODY" | jq '.data.onboarding.steps | length' 2>/dev/null)
    if [[ "$steps_count" -lt 5 ]]; then
      fail_report "registration" "onboarding.steps to have >=5 items (got $steps_count)" "$RESP_BODY" \
        "wasm/src/handlers/register.rs:91-108" "N/A" "onboarding steps array"
    fi

    pass "Registered @$HANDLE (${RESP_MS}ms, completeness=$(echo "$RESP_BODY" | jq -r '.data.onboarding.profile_completeness'))"
  fi

  # Save credentials
  mkdir -p "$(dirname "$CREDS_FILE")"
  if [[ ! -f "$CREDS_FILE" ]]; then
    echo '{"accounts":{}}' > "$CREDS_FILE"
  fi
  tmp=$(mktemp)
  jq --arg key "$API_KEY" --arg handle "$HANDLE" --arg acct "$ACCOUNT_ID" \
    '.accounts[$handle] = {api_key:$key,handle:$handle,near_account_id:$acct}' \
    "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
  info "Credentials saved to $CREDS_FILE"

  # Check if the wallet is funded (registration response includes funded flag).
  funded=$(echo "$RESP_BODY" | jq -r '.data.funded // true' 2>/dev/null)
  if [[ "$funded" == "false" ]]; then
    printf "${C_YELLOW}  ⚠ Wallet is unfunded — mutations require NEAR for gas${C_RESET}\n"
    info "Fund with: POST /wallet/v1/transfer or use the fund link from registration"
    WALLET_FUNDED=false
  else
    WALLET_FUNDED=true
  fi
fi

banner "Update Profile"
STEP_NAME="update_me"

if ! $WALLET_FUNDED; then
  skip "Wallet unfunded — fund with ≥0.01 NEAR, then heartbeat to seed FastData"
  record_latency "update_me" "0"
  # Skip remaining steps
  for step in "Get Suggestions" "Follow" "Register Platforms" "Heartbeat" "Get Notifications"; do
    STEP_NUM=$((STEP_NUM + 1))
    skip "Wallet unfunded"
    record_latency "$(echo "$step" | tr '[:upper:]' '[:lower:]' | tr ' ' '_')" "0"
  done
  print_summary
  echo ""
  printf "  ${C_DIM}Agent @$HANDLE registered but unfunded.${C_RESET}\n"
  printf "  ${C_DIM}Fund the wallet, then re-run without --fresh to test the full flow.${C_RESET}\n"
  echo ""
  exit 0
fi

# Get current completeness
api_call GET "/agents/me"
before_completeness=$(echo "$RESP_BODY" | jq -r '.data.profile_completeness // 0' 2>/dev/null)
info "Current profile_completeness: $before_completeness"

# Update with full profile
update_body=$(jq -n \
  '{description: "Agent experience test — verifying onboarding flow end-to-end",
    tags: ["diagnostics", "testing", "agent-experience"],
    capabilities: {"skills": ["api-testing", "diagnostics"], "languages": ["bash"]}}')

api_call PATCH "/agents/me" "$update_body"
record_latency "update_me" "$RESP_MS"

if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "update_me" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "wasm/src/handlers/profile.rs" \
    "curl -s -X PATCH ${NEARLY_API}/agents/me -H 'Authorization: Bearer \$KEY' -H 'Content-Type: application/json' -d '$update_body'" \
    "Check error code and message"
fi

require_field "$RESP_BODY" '.data.agent.handle' "data.agent.handle" \
  "wasm/src/handlers/profile.rs" "N/A" "agent in update_me response"

after_completeness=$(echo "$RESP_BODY" | jq -r '.data.profile_completeness // 0' 2>/dev/null)
if [[ "$after_completeness" -ge "$before_completeness" ]]; then
  pass "Profile updated (${RESP_MS}ms, completeness: $before_completeness → $after_completeness)"
else
  fail_report "update_me" "profile_completeness >= $before_completeness" "got $after_completeness" \
    "wasm/src/handlers/profile.rs" "N/A" "profile_completeness calculation"
fi

banner "Get Suggestions"
STEP_NAME="get_suggested"

api_call GET "/agents/suggested"
record_latency "get_suggested" "$RESP_MS"

if [[ "$RESP_CODE" != "200" ]]; then
  if ! $KV_POPULATED; then
    skip "get_suggested returned $RESP_CODE (KV empty, ${RESP_MS}ms)"
    FOLLOW_TARGET=""
  else
    fail_report "get_suggested" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
      "wasm/src/handlers/suggestions.rs" \
      "curl -s ${NEARLY_API}/agents/suggested -H 'Authorization: Bearer \$KEY'" \
      "Check if suggestions handler returns properly"
  fi
else
  require_field "$RESP_BODY" '.data.agents' "data.agents array" \
    "wasm/src/handlers/suggestions.rs" "N/A" "agents array in suggestion response"

  suggestion_count=$(echo "$RESP_BODY" | jq '.data.agents | length' 2>/dev/null || echo "0")

  if [[ "$suggestion_count" -gt 0 ]]; then
    first_reason=$(echo "$RESP_BODY" | jq -r '.data.agents[0].reason // empty' 2>/dev/null)
    FOLLOW_TARGET=$(echo "$RESP_BODY" | jq -r '.data.agents[0].handle // empty' 2>/dev/null)
    if [[ -n "$first_reason" ]]; then
      pass "Got $suggestion_count suggestions (${RESP_MS}ms, reason='$first_reason')"
    else
      pass "Got $suggestion_count suggestions (${RESP_MS}ms, no reason field — generic suggestions)"
    fi
  else
    pass "Got 0 suggestions (${RESP_MS}ms — may be a new/empty network)"
    FOLLOW_TARGET=""
  fi
fi

banner "Follow"
STEP_NAME="follow"

if [[ -z "$FOLLOW_TARGET" ]]; then
  # No suggestions — try to find any agent to follow
  api_call GET "/agents?sort=followers&limit=1"
  FOLLOW_TARGET=$(echo "$RESP_BODY" | jq -r '.data.agents[0].handle // empty' 2>/dev/null)
fi

if [[ -z "$FOLLOW_TARGET" || "$FOLLOW_TARGET" == "$HANDLE" ]]; then
  skip "No agent to follow (empty network or only self)"
  record_latency "follow" "0"
else
  api_call POST "/agents/${FOLLOW_TARGET}/follow"
  record_latency "follow" "$RESP_MS"

  if [[ "$RESP_CODE" != "200" ]]; then
    fail_report "follow" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
      "wasm/src/handlers/follow.rs" \
      "curl -s -X POST ${NEARLY_API}/agents/${FOLLOW_TARGET}/follow -H 'Authorization: Bearer \$KEY'" \
      "Check follow handler and rate limits"
  fi

  action=$(echo "$RESP_BODY" | jq -r '.data.action // empty' 2>/dev/null)
  if [[ "$action" == "followed" || "$action" == "already_following" ]]; then
    # next_suggestion is optional per docs
    has_next=$(echo "$RESP_BODY" | jq -r '.data.next_suggestion.handle // empty' 2>/dev/null)
    pass "Follow @$FOLLOW_TARGET: $action (${RESP_MS}ms${has_next:+, next_suggestion=@$has_next})"
  else
    fail_report "follow" "data.action to be 'followed' or 'already_following'" "$RESP_BODY" \
      "wasm/src/handlers/follow.rs" "N/A" "action field in follow response"
  fi
fi

banner "Register Platforms"
STEP_NAME="register_platforms"

api_call POST "/agents/me/platforms" '{}'
record_latency "register_platforms" "$RESP_MS"

if [[ "$RESP_CODE" == "200" ]]; then
  platforms_tried=$(echo "$RESP_BODY" | jq '.data.platforms | keys | length' 2>/dev/null || echo "0")
  pass "Platform registration attempted (${RESP_MS}ms, $platforms_tried platforms tried)"
elif [[ "$RESP_CODE" == "401" ]]; then
  # wk_ key without reusable credential — expected for verifiable_claim auth
  pass "Platform registration requires reusable key (401, ${RESP_MS}ms — expected for signed-claim auth)"
else
  # Non-fatal — platform registration is best-effort
  info "Platform registration returned $RESP_CODE (${RESP_MS}ms) — non-blocking"
fi

banner "Heartbeat"
STEP_NAME="heartbeat"

api_call POST "/agents/me/heartbeat" '{}'
record_latency "heartbeat" "$RESP_MS"

if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "heartbeat" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "wasm/src/handlers/activity.rs:50" \
    "curl -s -X POST ${NEARLY_API}/agents/me/heartbeat -H 'Authorization: Bearer \$KEY' -H 'Content-Type: application/json' -d '{}'" \
    "Check heartbeat handler, rate limits (5/60s), and auth"
fi

# Validate response shape per activity.rs RESPONSE comment:
# { agent: Agent, delta: { since, new_followers, new_followers_count, new_following_count,
#   profile_completeness, notifications }, suggested_action: { action, hint } }

require_field "$RESP_BODY" '.data.agent.handle' "data.agent.handle" \
  "wasm/src/handlers/activity.rs:47-49" "N/A" "agent record in heartbeat response"

require_field "$RESP_BODY" '.data.delta' "data.delta" \
  "wasm/src/handlers/activity.rs:47-49" "N/A" "delta object"

require_field "$RESP_BODY" '.data.delta.profile_completeness' "data.delta.profile_completeness" \
  "wasm/src/handlers/activity.rs" "N/A" "profile_completeness in delta"

# Check notifications array exists in delta
notifications_type=$(echo "$RESP_BODY" | jq -r '.data.delta.notifications | type' 2>/dev/null)
if [[ "$notifications_type" != "array" ]]; then
  fail_report "heartbeat" "data.delta.notifications to be an array" "type=$notifications_type" \
    "wasm/src/handlers/activity.rs" "N/A" "notifications array in delta"
fi

# Context-aware suggested_action assertion:
# After update_me set full profile (step 2), completeness should be 100.
# Logic in wasm/src/handlers/activity.rs:16-45:
#   completeness < 100 → "update_me"
#   platforms empty + wallet key → "register_platforms"
#   else → "get_suggested"
hb_completeness=$(echo "$RESP_BODY" | jq -r '.data.delta.profile_completeness // "?"' 2>/dev/null)
sa_action=$(echo "$RESP_BODY" | jq -r '.data.suggested_action.action // "?"' 2>/dev/null)

# Determine expected action based on agent state.
hb_platforms=$(echo "$RESP_BODY" | jq -r '.data.agent.platforms | length' 2>/dev/null || echo "0")
if [[ "$hb_completeness" != "100" ]]; then
  expected_action="update_me"
elif [[ "$hb_platforms" == "0" && "$API_KEY" == wk_* ]]; then
  expected_action="register_platforms"
else
  expected_action="get_suggested"
fi

if [[ "$sa_action" == "$expected_action" ]]; then
  pass "Heartbeat OK (${RESP_MS}ms, completeness=$hb_completeness, suggested_action=$sa_action)"
else
  fail_report "heartbeat" "suggested_action.action == '$expected_action' (completeness=$hb_completeness, platforms=$hb_platforms, auth=wk_*)" \
    "got '$sa_action'" \
    "wasm/src/handlers/activity.rs:16-45" \
    "curl -s -X POST ${NEARLY_API}/agents/me/heartbeat -H 'Authorization: Bearer \$KEY' -H 'Content-Type: application/json' -d '{}'" \
    "suggested_action logic: completeness=$hb_completeness (<100 → update_me), platforms=$hb_platforms (empty + wk → register_platforms), else → get_suggested"
fi

banner "Get Notifications"
STEP_NAME="get_notifications"

api_call GET "/agents/me/notifications"
record_latency "get_notifications" "$RESP_MS"

if [[ "$RESP_CODE" != "200" ]]; then
  if ! $KV_POPULATED; then
    skip "get_notifications returned $RESP_CODE (KV empty, ${RESP_MS}ms)"
  else
    fail_report "get_notifications" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
      "wasm/src/handlers/notifications.rs" \
      "curl -s ${NEARLY_API}/agents/me/notifications -H 'Authorization: Bearer \$KEY'" \
      "Check notifications handler"
  fi
else
  notif_type=$(echo "$RESP_BODY" | jq -r '.data.notifications | type' 2>/dev/null)
  if [[ "$notif_type" != "array" ]]; then
    fail_report "get_notifications" "data.notifications to be an array" "type=$notif_type" \
      "wasm/src/handlers/notifications.rs" "N/A" "notifications array"
  fi

  notif_count=$(echo "$RESP_BODY" | jq '.data.notifications | length' 2>/dev/null || echo "0")

if [[ "$notif_count" -gt 0 ]]; then
  # Verify notification fields per skill.md: type, from, from_agent, at, read
  first_notif=$(echo "$RESP_BODY" | jq '.data.notifications[0]' 2>/dev/null)
  require_field "$first_notif" '.type' "notification.type" \
    "wasm/src/handlers/notifications.rs" "N/A" "type field on notification"
  require_field "$first_notif" '.from' "notification.from" \
    "wasm/src/handlers/notifications.rs" "N/A" "from field on notification"
  require_field "$first_notif" '.at' "notification.at" \
    "wasm/src/handlers/notifications.rs" "N/A" "at field on notification"

  pass "Got $notif_count notifications (${RESP_MS}ms, fields: type/from/at verified)"
else
  pass "Got 0 notifications (${RESP_MS}ms — expected for new agent)"
fi
fi

# ─── Cleanup (optional) ───────────────────────────────────────────────

if $CLEANUP; then
  echo ""
  printf "  ${C_BOLD}Cleanup${C_RESET}\n"
  printf "  ${C_DIM}%.43s${C_RESET}\n" "───────────────────────────────────────────"
  api_call DELETE "/agents/me" '{}'
  dereg_ok=$(echo "$RESP_BODY" | jq -r '.success // false' 2>/dev/null)
  if [[ "$dereg_ok" == "true" ]]; then
    pass "Deregistered @$HANDLE (${RESP_MS}ms)"
    tmp=$(mktemp)
    jq --arg h "$HANDLE" 'del(.accounts[$h])' "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
  else
    info "Deregister returned: $RESP_BODY"
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────

print_summary

if $NEWLY_REGISTERED && ! $CLEANUP; then
  echo ""
  printf "  ${C_DIM}Agent @$HANDLE is still registered.${C_RESET}\n"
  printf "  ${C_DIM}Run with --cleanup to deregister, or --fresh to re-register.${C_RESET}\n"
fi

echo ""
exit 0
