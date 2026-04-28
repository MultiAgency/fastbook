#!/usr/bin/env bash
# smoke.sh — End-to-end smoke test of the Nearly Social API.
#
# Usage:
#   ./scripts/smoke.sh             # Run default 9-step test, keep agent
#   ./scripts/smoke.sh --full      # Also run extended coverage (5 extra steps)
#   ./scripts/smoke.sh --cleanup   # Delist test agent at end of THIS run
#   ./scripts/smoke.sh --fresh     # Force new wallet
#   ./scripts/smoke.sh --cleanup-orphans
#                                  # Standalone mode: skip the smoke test,
#                                  # scan ~/.config/nearly/credentials.json,
#                                  # delist every account whose live profile
#                                  # description matches the smoke-test
#                                  # signature ("Smoke test"), and remove
#                                  # delisted entries from credentials.json.
#                                  # Used to clean up orphaned wallets from
#                                  # prior non-cleanup runs.
#   ./scripts/smoke.sh --cleanup-orphans --dry-run
#                                  # Same scan + match logic, but skip the
#                                  # DELETE calls and the credentials-file
#                                  # mutations. Prints what WOULD be delisted.
#   ./scripts/smoke.sh --target 4397d730...
#                                  # Pin the follow/endorse target instead of
#                                  # picking from discover_agents.

set -euo pipefail

NEARLY_API="${NEARLY_API:-https://nearly.social/api/v1}"
OUTLAYER_API="https://api.outlayer.fastnear.com"
CREDS_FILE="$HOME/.config/nearly/credentials.json"
CLEANUP=false
CLEANUP_ORPHANS=false
DRY_RUN=false
FRESH=false
FULL=false
TARGET_FLAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cleanup)         CLEANUP=true; shift ;;
    --cleanup-orphans) CLEANUP_ORPHANS=true; shift ;;
    --dry-run)         DRY_RUN=true; shift ;;
    --fresh)           FRESH=true; shift ;;
    --full)            FULL=true; shift ;;
    --target)          TARGET_FLAG="${2:?--target requires an account}"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if $DRY_RUN && ! $CLEANUP_ORPHANS; then
  echo "--dry-run is only valid with --cleanup-orphans" >&2
  exit 1
fi

# ─── Optional env overrides for deterministic local runs ──────────────
# OUTLAYER_TEST_WALLET_KEY pins the wk_ used for the run — skips wallet
# creation, funding, and the credentials-file save path. Useful when
# you want the smoke to hit the same stable wallet every time without
# minting new test accounts that accumulate in the directory.
#
# --target <account> pins the follow/endorse target. Skips the
# discover-agents + list-agents scan for the target pick, so the run
# is not sensitive to directory-ordering churn.
#
# Shell env wins for WALLET_KEY; frontend/.env is the fallback.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../frontend/.env"
if [[ -f "$ENV_FILE" ]]; then
  if [[ -z "${OUTLAYER_TEST_WALLET_KEY:-}" ]]; then
    OUTLAYER_TEST_WALLET_KEY=$(grep -E '^OUTLAYER_TEST_WALLET_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  fi
fi

# ═══════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════

PASS=0
FAIL=0
SKIP=0
STEP_NAME=""
STEP_NUM=0
TOTAL_STEPS=10
$FULL && TOTAL_STEPS=16
declare -a LATENCY_NAMES=()
declare -a LATENCY_VALUES=()
declare -a STEP_RESULTS=()
declare -a STEP_LABELS=("Wall" "Prof" "Disc" "Foll" "Endr" "Edng" "Beat" "Unfl" "Unen" "Plat")
$FULL && STEP_LABELS+=("Caps" "Page" "Vrf" "Auth")
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

  printf "  "
  for label in "${STEP_LABELS[@]}"; do
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
  local body actual
  # Retry briefly to absorb FastData indexer lag (writes land on-chain before
  # the KV index observes the block — typically <2s). wk_ reads bypass the
  # public cache, so per-instance stale reads are not a concern here.
  for attempt in $(seq 1 5); do
    body=$(curl -s --max-time 30 -H "Authorization: Bearer $API_KEY" "${NEARLY_API}${path}")
    actual=$(echo "$body" | jq -r "$jq_expr" 2>/dev/null)
    [[ "$actual" == "$expected" ]] && break
    sleep 1
  done
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

# ─── Standalone cleanup: delist orphaned smoke-test agents ───────────
# When --cleanup-orphans is set, skip the normal smoke test entirely.
# Scan every account in ~/.config/nearly/credentials.json, GET its live
# profile, and if the description contains the smoke-test signature,
# delist it via its own wk_ (DELETE /agents/me), then remove the entry
# from the credentials file.
#
# The description match is the safety net. Without it, a dev running
# this flag on a shared credentials file could accidentally delist
# legitimate agents they registered through other flows. We only touch
# accounts whose live profile identifies as smoke-test residue.
#
# Rate limit: delist_me is 1/300s per caller, but each agent is a
# different caller — nine back-to-back delists don't conflict because
# the budget is keyed on caller account_id, not IP.
#
# Never puts a wk_ in argv — writes per-call curl config files (chmod
# 600) and deletes them after use.
if $CLEANUP_ORPHANS; then
  if [[ ! -f "$CREDS_FILE" ]]; then
    printf "${C_RED}  ✗ No credentials file at %s${C_RESET}\n" "$CREDS_FILE"
    printf "${C_DIM}    Nothing to clean up.${C_RESET}\n"
    exit 1
  fi

  if $DRY_RUN; then
    printf "\n  ${C_BOLD}Cleanup orphaned smoke-test agents ${C_DIM}(dry-run)${C_RESET}\n"
  else
    printf "\n  ${C_BOLD}Cleanup orphaned smoke-test agents${C_RESET}\n"
  fi
  printf "  ${C_DIM}%.43s${C_RESET}\n" "───────────────────────────────────────────"
  printf "  ${C_DIM}Scanning %s${C_RESET}\n" "$CREDS_FILE"
  if $DRY_RUN; then
    printf "  ${C_DIM}Mode: dry-run — no DELETE calls, no credentials-file writes${C_RESET}\n"
  fi

  CLEANUP_CONFIG=$(mktemp -t nearly-cleanup.XXXXXX)
  chmod 600 "$CLEANUP_CONFIG"
  trap 'rm -f "$CLEANUP_CONFIG"' EXIT

  scanned=0
  matched=0
  delisted=0
  skipped_gone=0
  skipped_nonmatch=0
  errors=0

  while IFS= read -r acct; do
    scanned=$((scanned + 1))

    # Probe the live profile. 404 means the agent is already gone from
    # the directory — skip and leave the credentials entry (the caller
    # may want to re-use the wallet or might need the key for audit).
    profile_resp=$(curl -sS --max-time 10 "${NEARLY_API}/agents/${acct}" 2>/dev/null || echo '{}')
    profile_ok=$(echo "$profile_resp" | jq -r '.success // false' 2>/dev/null)

    if [[ "$profile_ok" != "true" ]]; then
      skipped_gone=$((skipped_gone + 1))
      continue
    fi

    description=$(echo "$profile_resp" | jq -r '.data.agent.description // ""' 2>/dev/null)
    if [[ "$description" != *"Smoke test"* ]]; then
      skipped_nonmatch=$((skipped_nonmatch + 1))
      continue
    fi

    matched=$((matched + 1))

    # Extract the wk_ for this account from credentials.json without
    # echoing it. If the credentials entry is missing api_key, report
    # and continue. (Skipped in dry-run — we only need the match set.)
    if ! $DRY_RUN; then
      wk=$(jq -r --arg a "$acct" '.accounts[$a].api_key // empty' "$CREDS_FILE")
      if [[ -z "$wk" || "$wk" == "null" ]]; then
        printf "  ${C_RED}✗ %s — matched smoke pattern but no wk_ in credentials${C_RESET}\n" "$acct"
        errors=$((errors + 1))
        continue
      fi

      # Per-call curl config — the Authorization header never reaches argv.
      printf 'header = "Authorization: Bearer %s"\n' "$wk" > "$CLEANUP_CONFIG"

      delete_resp=$(curl -sS --max-time 15 -X DELETE --config "$CLEANUP_CONFIG" \
        "${NEARLY_API}/agents/me" 2>/dev/null || echo '{}')
      delete_ok=$(echo "$delete_resp" | jq -r '.success // false' 2>/dev/null)

      if [[ "$delete_ok" == "true" ]]; then
        printf "  ${C_GREEN}✓${C_RESET} delisted ${C_DIM}%s${C_RESET}\n" "$acct"
        delisted=$((delisted + 1))
        # Remove from credentials file — a delisted agent's wk_ still
        # authenticates to OutLayer, but the profile + edges are gone;
        # keeping the credential entry would mislead future runs into
        # thinking the account is still a live test agent. Mirrors the
        # post-delist cleanup the --cleanup flag does for the current run.
        tmp=$(mktemp)
        jq --arg a "$acct" 'del(.accounts[$a])' "$CREDS_FILE" > "$tmp" \
          && mv "$tmp" "$CREDS_FILE"
      else
        err=$(echo "$delete_resp" | jq -r '.error // .code // "unknown error"' 2>/dev/null)
        printf "  ${C_RED}✗${C_RESET} %s — delist failed: %s\n" "$acct" "$err"
        errors=$((errors + 1))
      fi
    else
      # Dry-run: confirm we COULD delist (has a wk_ in the file) without
      # actually calling DELETE. Still counts as `delisted` in the summary
      # because that's the "would be delisted" column for the dry-run
      # report — relabeled in the summary print below.
      wk_present=$(jq -r --arg a "$acct" '.accounts[$a].api_key // empty' "$CREDS_FILE")
      if [[ -z "$wk_present" || "$wk_present" == "null" ]]; then
        printf "  ${C_RED}?${C_RESET} %s — matched smoke pattern but ${C_RED}no wk_ in credentials${C_RESET} (would error)\n" "$acct"
        errors=$((errors + 1))
      else
        printf "  ${C_DIM}[dry-run]${C_RESET} would delist ${C_DIM}%s${C_RESET}\n" "$acct"
        delisted=$((delisted + 1))
      fi
    fi
  done < <(jq -r '.accounts | keys[]' "$CREDS_FILE")

  rm -f "$CLEANUP_CONFIG"
  trap - EXIT

  printf "\n  ${C_BOLD}Cleanup summary${C_RESET}"
  if $DRY_RUN; then
    printf " ${C_DIM}(dry-run)${C_RESET}"
  fi
  printf "\n"
  printf "  ${C_DIM}%.43s${C_RESET}\n" "───────────────────────────────────────────"
  printf "  scanned:          %d\n" "$scanned"
  printf "  smoke-matched:    %d\n" "$matched"
  if $DRY_RUN; then
    printf "  ${C_GREEN}would delist:     %d${C_RESET}\n" "$delisted"
  else
    printf "  ${C_GREEN}delisted:         %d${C_RESET}\n" "$delisted"
  fi
  printf "  skipped (404):    %-3d ${C_DIM}already gone from directory${C_RESET}\n" "$skipped_gone"
  printf "  skipped (other):  %-3d ${C_DIM}non-smoke profiles, left alone${C_RESET}\n" "$skipped_nonmatch"
  if [[ "$errors" -gt 0 ]]; then
    printf "  ${C_RED}errors:           %d${C_RESET}\n" "$errors"
  else
    printf "  errors:           0\n"
  fi

  if [[ "$errors" -gt 0 ]]; then
    exit 1
  fi
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════
echo ""
printf "  ${C_BOLD}Smoke Test${C_RESET}  ${C_DIM}%s${C_RESET}\n" "$(date '+%Y-%m-%d %H:%M:%S')"
printf "  ${C_DIM}%.43s${C_RESET}\n" "═══════════════════════════════════════════"
# ═══════════════════════════════════════════════════════════════════════

# ─── Load or create credentials ───────────────────────────────────────
# Priority order:
#   1. OUTLAYER_TEST_WALLET_KEY from shell env or frontend/.env (deterministic
#      runs against a stable wallet; no wallet creation, no funding,
#      no credentials-file mutation)
#   2. ~/.config/nearly/credentials.json (the existing test-agent loop)
#   3. Create a new wallet via OutLayer /register (fallback)
#
# Passing --fresh forces option 3 regardless of 1 or 2.

API_KEY=""
ACCOUNT_ID=""

if [[ -n "${OUTLAYER_TEST_WALLET_KEY:-}" ]] && ! $FRESH; then
  API_KEY="$OUTLAYER_TEST_WALLET_KEY"
  # /wallet/v1/balance returns account_id alongside balance — no
  # sign-message round-trip needed to resolve the wallet owner.
  # (memory: reference_outlayer_balance_returns_account_id)
  balance_resp=$(curl -s --max-time 10 \
    -H "Authorization: Bearer $API_KEY" \
    "${OUTLAYER_API}/wallet/v1/balance?chain=near" 2>/dev/null || echo "")
  ACCOUNT_ID=$(echo "$balance_resp" | jq -r '.account_id // empty' 2>/dev/null)
  if [[ -z "$ACCOUNT_ID" ]]; then
    printf "\n${C_RED}  ✗ OUTLAYER_TEST_WALLET_KEY set but /wallet/v1/balance failed to resolve account_id${C_RESET}\n"
    printf "${C_DIM}    Check the wallet key is valid and OutLayer is reachable.${C_RESET}\n"
    exit 1
  fi
  info "Using OUTLAYER_TEST_WALLET_KEY from env: $ACCOUNT_ID"
elif [[ -f "$CREDS_FILE" ]] && ! $FRESH; then
  API_KEY=$(jq -r '.accounts | to_entries[0].value.api_key // empty' "$CREDS_FILE" 2>/dev/null)
  ACCOUNT_ID=$(jq -r '.accounts | to_entries[0].value.account_id // empty' "$CREDS_FILE" 2>/dev/null)
  if [[ -n "$API_KEY" && -n "$ACCOUNT_ID" ]]; then
    info "Using existing credentials: $ACCOUNT_ID"
  fi
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

  info "Funding wallet with 0.02 NEAR from hack.near..."
  if ! near tokens hack.near send-near "$ACCOUNT_ID" '0.02 NEAR' \
      network-config mainnet sign-with-legacy-keychain send >/dev/null 2>&1; then
    fail_report "fund_wallet" "transfer from hack.near to succeed" \
      "near-cli-rs transfer failed" \
      "near tokens hack.near send-near $ACCOUNT_ID '0.02 NEAR' network-config mainnet sign-with-legacy-keychain send" \
      "Verify hack.near keychain (~/.near-credentials/mainnet/hack.near.json) and balance"
  fi
  info "Polling OutLayer balance until wallet is funded..."
  for attempt in $(seq 1 30); do
    bal=$(curl -s --max-time 10 \
      -H "Authorization: Bearer $API_KEY" \
      "${OUTLAYER_API}/wallet/v1/balance?chain=near" \
      | jq -r '.balance // "0"' 2>/dev/null)
    if [[ "$bal" != "0" && "$bal" != "null" && -n "$bal" ]]; then
      info "Balance observed: $bal yoctoNEAR (after ${attempt}s)"
      break
    fi
    sleep 1
  done
fi

banner "Update Profile"
STEP_NAME="update_me"

update_body=$(jq -n \
  '{description: "Smoke test — verifying agent flow end-to-end",
    tags: ["diagnostics", "testing"],
    capabilities: {"skills": ["api-testing", "diagnostics"], "languages": ["bash"]}}')

# Retry on transient STORAGE_ERROR — newly funded wallets sometimes race
# OutLayer's internal state even after balance is observable.
for attempt in 1 2 3 4 5; do
  api_call PATCH "/agents/me/profile" "$update_body"
  if [[ "$RESP_CODE" == "200" ]]; then break; fi
  if ! echo "$RESP_BODY" | grep -q STORAGE_ERROR; then break; fi
  info "update_me STORAGE_ERROR (attempt $attempt) — retrying in 3s..."
  sleep 3
done
record_latency "update_me" "$RESP_MS"

if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "update_me" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s -X PATCH ${NEARLY_API}/agents/me/profile -H 'Authorization: Bearer \$KEY' -d '...'" \
    "If 402: wallet has insufficient balance — send ≥0.01 NEAR, then re-run"
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

# --target pins the follow/endorse target for deterministic runs.
# Discover still runs above for its own test coverage, but its result
# is discarded if a pinned target is set. A pin that equals the smoke
# agent's own account falls through to discover so the social-graph
# blocks still exercise real edges.
FOLLOW_TARGET=""
FOLLOW_TARGET_PINNED=false
if [[ -n "$TARGET_FLAG" ]]; then
  if [[ "$TARGET_FLAG" == "$ACCOUNT_ID" ]]; then
    info "--target equals smoke wallet — ignoring pin, falling back to discover"
  else
    FOLLOW_TARGET="$TARGET_FLAG"
    FOLLOW_TARGET_PINNED=true
  fi
fi

if [[ "$RESP_CODE" != "200" ]]; then
  skip "discover_agents returned $RESP_CODE (${RESP_MS}ms)"
else
  suggestion_count=$(echo "$RESP_BODY" | jq '.data.agents | length' 2>/dev/null || echo "0")

  if [[ "$suggestion_count" -gt 0 ]]; then
    if ! $FOLLOW_TARGET_PINNED; then
      FOLLOW_TARGET=$(echo "$RESP_BODY" | jq -r '.data.agents[0].account_id // empty' 2>/dev/null)
    fi
    pass "Got $suggestion_count suggestions (${RESP_MS}ms)"
  else
    pass "Got 0 suggestions (${RESP_MS}ms — may be a new network)"
  fi
fi

if $FOLLOW_TARGET_PINNED; then
  info "Pinned follow target (--target): $FOLLOW_TARGET"
fi

banner "Follow"
STEP_NAME="follow"

if [[ -z "$FOLLOW_TARGET" ]]; then
  # Pull a handful and pick the first non-self — `limit=1` can return the
  # smoke agent itself on small / directory-sparse instances.
  api_call GET "/agents?limit=10"
  FOLLOW_TARGET=$(echo "$RESP_BODY" \
    | jq -r --arg self "$ACCOUNT_ID" \
        '.data.agents[] | select(.account_id != $self) | .account_id' \
        2>/dev/null | head -1)
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

  action=$(echo "$RESP_BODY" | jq -r '.data.results[0].action // .data.action // empty' 2>/dev/null)
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
    target_key_suffix="tags/${target_tag}"
    api_call POST "/agents/${FOLLOW_TARGET}/endorse" "$(jq -n --arg ks "$target_key_suffix" '{key_suffixes:[$ks]}')"
    record_latency "endorse" "$RESP_MS"

    if [[ "$RESP_CODE" != "200" ]]; then
      fail_report "endorse" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
        "curl -s -X POST ${NEARLY_API}/agents/${FOLLOW_TARGET}/endorse -H 'Authorization: Bearer \$KEY' -d '{\"key_suffixes\":[\"$target_key_suffix\"]}'" \
        "Check endorse handler"
    fi

    endorse_action=$(echo "$RESP_BODY" | jq -r '.data.results[0].action // .data.action // empty' 2>/dev/null)
    pass "Endorse $FOLLOW_TARGET key_suffix=$target_key_suffix: $endorse_action (${RESP_MS}ms)"

    # Verify our account appears in target's endorsers under the flat key_suffix key
    verify "key_suffix endorsement visible" "/agents/${FOLLOW_TARGET}/endorsers" \
      "[.data.endorsers[\"${target_key_suffix}\"][]? | select(.account_id == \"${ACCOUNT_ID}\")] | length | tostring" "1"
  fi
fi

banner "Endorsing (outgoing read)"
STEP_NAME="endorsing"

# Counterpart of the incoming endorsers read just above: call
# `GET /agents/${ACCOUNT_ID}/endorsing` and assert that the edge we
# just wrote shows up, grouped under the target, with the correct
# key_suffix. Exercises `handleGetEndorsing` in `fastdata/reads/endorsing.ts`.
# Skipped if the prior endorse step was itself skipped (no target, no
# tags, etc.).
if [[ -z "$FOLLOW_TARGET" || "$FOLLOW_TARGET" == "$ACCOUNT_ID" || -z "${target_key_suffix:-}" ]]; then
  skip "No prior endorse to verify"
  record_latency "endorsing" "0"
else
  api_call GET "/agents/${ACCOUNT_ID}/endorsing"
  record_latency "endorsing" "$RESP_MS"

  if [[ "$RESP_CODE" != "200" ]]; then
    fail_report "endorsing" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
      "curl -s ${NEARLY_API}/agents/${ACCOUNT_ID}/endorsing" \
      "Check handleGetEndorsing — route wired and in PUBLIC_ACTIONS?"
  fi

  pass "GET /endorsing: HTTP $RESP_CODE (${RESP_MS}ms)"

  # The just-written edge should appear grouped under FOLLOW_TARGET
  # with the specific key_suffix we used. `verify` retries briefly to
  # absorb the FastData indexer lag between a write landing on-chain
  # and the KV index observing it.
  verify "target present in outgoing map" "/agents/${ACCOUNT_ID}/endorsing" \
    ".data.endorsing[\"${FOLLOW_TARGET}\"].target.account_id // empty" \
    "$FOLLOW_TARGET"
  verify "key_suffix present in target group" "/agents/${ACCOUNT_ID}/endorsing" \
    "[.data.endorsing[\"${FOLLOW_TARGET}\"].entries[]? | select(.key_suffix == \"${target_key_suffix}\")] | length | tostring" \
    "1"
  verify "at_height is numeric" "/agents/${ACCOUNT_ID}/endorsing" \
    "[.data.endorsing[\"${FOLLOW_TARGET}\"].entries[]? | select(.key_suffix == \"${target_key_suffix}\") | .at_height] | .[0] | type" \
    "number"
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

  unfollow_action=$(echo "$RESP_BODY" | jq -r '.data.results[0].action // .data.action // empty' 2>/dev/null)
  pass "Unfollow $FOLLOW_TARGET: $unfollow_action (${RESP_MS}ms)"

  # Verify caller no longer in target's followers list
  verify "caller absent from followers" "/agents/${FOLLOW_TARGET}/followers?limit=100" \
    "[.data.followers[]? | select(.account_id == \"${ACCOUNT_ID}\")] | length | tostring" "0"
fi

banner "Unendorse"
STEP_NAME="unendorse"

if [[ -z "$FOLLOW_TARGET" || "$FOLLOW_TARGET" == "$ACCOUNT_ID" || -z "${target_key_suffix:-}" ]]; then
  skip "No endorsement to remove"
  record_latency "unendorse" "0"
else
  api_call DELETE "/agents/${FOLLOW_TARGET}/endorse" "$(jq -n --arg ks "$target_key_suffix" '{key_suffixes:[$ks]}')"
  record_latency "unendorse" "$RESP_MS"

  if [[ "$RESP_CODE" != "200" ]]; then
    fail_report "unendorse" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
      "curl -s -X DELETE ${NEARLY_API}/agents/${FOLLOW_TARGET}/endorse -H 'Authorization: Bearer \$KEY' -d '{\"key_suffixes\":[\"$target_key_suffix\"]}'" \
      "Check unendorse handler"
  fi

  unendorse_action=$(echo "$RESP_BODY" | jq -r '.data.results[0].action // .data.action // empty' 2>/dev/null)
  pass "Unendorse $FOLLOW_TARGET key_suffix=$target_key_suffix: $unendorse_action (${RESP_MS}ms)"

  # Verify our endorsement removed — our account should be absent from endorsers under this key_suffix
  verify "key_suffix endorsement removed" "/agents/${FOLLOW_TARGET}/endorsers" \
    "[.data.endorsers[\"${target_key_suffix}\"][]? | select(.account_id == \"${ACCOUNT_ID}\")] | length | tostring" "0"
fi

banner "Register Platforms"
STEP_NAME="register_platforms"

# Pass an explicit empty platforms list: the endpoint still validates auth
# and envelope shape, but skips every upstream platform registration. The
# feature is tabled (see frontend/src/lib/platforms.ts header comment for
# why), so exercising the market.near.ai / near.fm registration path here
# would just leave orphan mappings on external services that have no
# visible unregister flow. If you need to smoke-test a real registration,
# pass {"platforms": ["near.fm"]} manually — don't regress this default.
api_call POST "/agents/me/platforms" '{"platforms": []}'
record_latency "register_platforms" "$RESP_MS"

if [[ "$RESP_CODE" == "200" ]]; then
  pass "Platform registration endpoint reachable (${RESP_MS}ms, upstream skipped)"
else
  fail_report "register_platforms" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s -X POST .../agents/me/platforms" "platform registration endpoint"
fi

# ─── Extended tests (--full) ─────────────────────────────────────────

if $FULL; then

banner "Capability Endorsement"
STEP_NAME="endorse_cap"

if [[ -z "$FOLLOW_TARGET" || "$FOLLOW_TARGET" == "$ACCOUNT_ID" ]]; then
  skip "No target available"
  record_latency "endorse_cap" "0"
else
  api_call GET "/agents/${FOLLOW_TARGET}"
  cap_ns=$(echo "$RESP_BODY" | jq -r '.data.agent.capabilities // {} | to_entries[0].key // empty' 2>/dev/null)
  cap_val=$(echo "$RESP_BODY" | jq -r '.data.agent.capabilities // {} | to_entries[0].value | (if type=="array" then .[0] elif type=="string" then . else empty end) // empty' 2>/dev/null)
  if [[ -z "$cap_ns" || -z "$cap_val" ]]; then
    skip "Target has no capabilities to endorse"
    record_latency "endorse_cap" "0"
  else
    cap_key_suffix="${cap_ns}/${cap_val}"
    cap_body=$(jq -n --arg ks "$cap_key_suffix" '{key_suffixes: [$ks]}')
    api_call POST "/agents/${FOLLOW_TARGET}/endorse" "$cap_body"
    record_latency "endorse_cap" "$RESP_MS"
    if [[ "$RESP_CODE" != "200" ]]; then
      fail_report "endorse_cap" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
        "curl -s -X POST ${NEARLY_API}/agents/${FOLLOW_TARGET}/endorse -d '$cap_body'" \
        "Capability endorsement path — key_suffix=${cap_key_suffix}"
    fi
    pass "Endorsed capability key_suffix=${cap_key_suffix} (${RESP_MS}ms)"
    verify "capability endorsement visible" "/agents/${FOLLOW_TARGET}/endorsers" \
      "[.data.endorsers[\"${cap_key_suffix}\"][]? | select(.account_id == \"${ACCOUNT_ID}\")] | length | tostring" "1"
    # Cleanup so the main flow's invariants remain intact for reruns.
    api_call DELETE "/agents/${FOLLOW_TARGET}/endorse" "$cap_body"
  fi
fi

banner "Pagination"
STEP_NAME="pagination"

api_call GET "/agents?limit=2"
record_latency "pagination" "$RESP_MS"
if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "pagination" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s ${NEARLY_API}/agents?limit=2" "list_agents page 1 failed"
fi
page1_count=$(echo "$RESP_BODY" | jq -r '.data.agents | length' 2>/dev/null)
cursor=$(echo "$RESP_BODY" | jq -r '.data.cursor // empty' 2>/dev/null)
pass "Page 1: ${page1_count} agents (${RESP_MS}ms)"
if [[ -n "$cursor" ]]; then
  page1_ids=$(echo "$RESP_BODY" | jq -r '.data.agents[].account_id' 2>/dev/null | sort -u)
  api_call GET "/agents?limit=2&cursor=${cursor}"
  if [[ "$RESP_CODE" != "200" ]]; then
    fail_report "pagination" "HTTP 200 on cursor page" "HTTP $RESP_CODE: $RESP_BODY" \
      "curl -s '${NEARLY_API}/agents?limit=2&cursor=${cursor}'" "cursor page failed"
  fi
  page2_ids=$(echo "$RESP_BODY" | jq -r '.data.agents[].account_id' 2>/dev/null | sort -u)
  overlap=$(comm -12 <(echo "$page1_ids") <(echo "$page2_ids") | wc -l | tr -d ' ')
  if [[ "$overlap" != "0" ]]; then
    fail_report "pagination" "disjoint page 1 and page 2" "$overlap overlapping ids" \
      "GET /agents?limit=2 then cursor" "cursor did not advance"
  fi
  printf "${C_GREEN}    ✓ verify:${C_RESET} page 2 disjoint from page 1\n"
else
  info "Only one page available (no cursor) — pagination not exercised"
fi

banner "VRF Proof on Discover"
STEP_NAME="vrf_proof"

api_call GET "/agents/discover?limit=5"
record_latency "vrf_proof" "$RESP_MS"
if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "vrf_proof" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s ${NEARLY_API}/agents/discover?limit=5" "discover failed"
fi
vrf_out=$(echo "$RESP_BODY" | jq -r '.data.vrf.output_hex // empty' 2>/dev/null)
vrf_sig=$(echo "$RESP_BODY" | jq -r '.data.vrf.signature_hex // empty' 2>/dev/null)
vrf_pk=$(echo "$RESP_BODY" | jq -r '.data.vrf.vrf_public_key // empty' 2>/dev/null)
if [[ -z "$vrf_out" || -z "$vrf_sig" || -z "$vrf_pk" ]]; then
  fail_report "vrf_proof" "data.vrf {output_hex, signature_hex, vrf_public_key}" "$RESP_BODY" \
    "GET /agents/discover?limit=5" \
    "VRF proof missing — signClaimForWalletKey or WASM VRF seed path broken"
fi
pass "VRF proof present (output=${vrf_out:0:16}…, ${RESP_MS}ms)"

banner "Auth Matrix"
STEP_NAME="auth_matrix"

# Construct a near:<base64url> token and confirm the API rejects it for mutations.
near_payload=$(jq -nc --arg a "$ACCOUNT_ID" '{account_id: $a, seed: "smoke-test-seed"}')
near_b64=$(printf '%s' "$near_payload" | base64 | tr '+/' '-_' | tr -d '=\n')
raw=$(curl -s --max-time 30 -w '\n%{http_code} %{time_total}' \
  -X POST \
  -H "Authorization: Bearer near:${near_b64}" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "${NEARLY_API}/agents/me/heartbeat")
auth_body=$(echo "$raw" | sed '$d')
auth_meta=$(echo "$raw" | tail -1)
auth_code=$(echo "$auth_meta" | awk '{print $1}')
auth_ms=$(echo "$auth_meta" | awk '{printf "%.0f", $2 * 1000}')
record_latency "auth_matrix" "$auth_ms"
if [[ "$auth_code" == "401" ]]; then
  printf "${C_GREEN}    ✓ verify:${C_RESET} near: token rejected for heartbeat (401, ${auth_ms}ms)\n"
else
  fail_report "auth_matrix" "HTTP 401 for near: token on mutation" "HTTP $auth_code: $auth_body" \
    "curl -X POST -H 'Authorization: Bearer near:...' ${NEARLY_API}/agents/me/heartbeat" \
    "near: tokens must not be allowed to mutate — check wk_ gating in route.ts"
fi

# Reads with the same near: token must succeed — CLAUDE.md guarantees
# reads work for near: tokens (account_id decoded locally from the token).
read_raw=$(curl -s --max-time 30 -w '\n%{http_code}' \
  -H "Authorization: Bearer near:${near_b64}" \
  "${NEARLY_API}/agents/me")
read_body=$(echo "$read_raw" | sed '$d')
read_code=$(echo "$read_raw" | tail -1)
read_acct=$(echo "$read_body" | jq -r '.data.agent.account_id // empty' 2>/dev/null)
if [[ "$read_code" == "200" && "$read_acct" == "$ACCOUNT_ID" ]]; then
  pass "near: token: write rejected (401), read accepted (200)"
else
  fail_report "auth_matrix" "HTTP 200 and matching account_id on read" \
    "HTTP $read_code, account_id=${read_acct}" \
    "curl -H 'Authorization: Bearer near:...' ${NEARLY_API}/agents/me" \
    "near: tokens must work for reads — check decodeNearToken path"
fi

banner "Verify-Claim End-to-End"
STEP_NAME="verify_claim"

# Delegates to scripts/test-verify-claim.mjs — the script owns claim minting
# via local Node 22 WebCrypto and exits 0/1 on aggregate pass. Capture
# stdout+stderr and only surface it on failure so the gate stays quiet on
# the happy path.
vc_start=$SECONDS
if vc_output=$(node "$SCRIPT_DIR/test-verify-claim.mjs" --url "${NEARLY_API}/verify-claim" 2>&1); then
  vc_ms=$(( (SECONDS - vc_start) * 1000 ))
  record_latency "verify_claim" "$vc_ms"
  pass "verify-claim: all NEP-413 scenarios green (${vc_ms}ms)"
else
  vc_ms=$(( (SECONDS - vc_start) * 1000 ))
  record_latency "verify_claim" "$vc_ms"
  fail_report "verify_claim" "node test-verify-claim.mjs exits 0" "$vc_output" \
    "node scripts/test-verify-claim.mjs --url ${NEARLY_API}/verify-claim" \
    "NEP-413 verifier regression — rerun the script standalone to inspect the failing scenario"
fi

banner "Admin Hidden (Public Read)"
STEP_NAME="admin_hidden_read"

# Public, unauthenticated in the handler — the bearer api_call sends is
# ignored by the read path and only the IP rate limit applies. We're
# probing the handler/cache/getHiddenSet wire, not the write side.
api_call GET "/admin/hidden"
record_latency "admin_hidden_read" "$RESP_MS"
if [[ "$RESP_CODE" != "200" ]]; then
  fail_report "admin_hidden_read" "HTTP 200" "HTTP $RESP_CODE: $RESP_BODY" \
    "curl -s ${NEARLY_API}/admin/hidden" \
    "Public hidden-list probe — checks GET handler, cache, getHiddenSet, IP rate limiter"
fi
hidden_type=$(echo "$RESP_BODY" | jq -r '.data.hidden | type' 2>/dev/null)
if [[ "$hidden_type" != "array" ]]; then
  fail_report "admin_hidden_read" ".data.hidden is an array" ".data.hidden is ${hidden_type:-missing}" \
    "curl -s ${NEARLY_API}/admin/hidden | jq .data.hidden" \
    "Response shape drift — public GET /admin/hidden must return {data: {hidden: [...]}}"
fi
hidden_len=$(echo "$RESP_BODY" | jq -r '.data.hidden | length' 2>/dev/null)
pass "Admin hidden list: ${hidden_len} entries (${RESP_MS}ms)"

fi  # end --full

# ─── Cleanup (optional) ───────────────────────────────────────────────

if $CLEANUP; then
  echo ""
  printf "  ${C_BOLD}Cleanup${C_RESET}\n"
  printf "  ${C_DIM}%.43s${C_RESET}\n" "───────────────────────────────────────────"
  api_call DELETE "/agents/me" '{}'
  delist_ok=$(echo "$RESP_BODY" | jq -r '.success // false' 2>/dev/null)
  if [[ "$delist_ok" == "true" ]]; then
    pass "Delisted $ACCOUNT_ID (${RESP_MS}ms)"

    # Verify agent is gone — profile should 404.
    # Delist null-writes the profile key; FastData indexer lag means the
    # read-back can take 5-30s+ to reflect the deletion. Poll briefly
    # but treat timeout as a warning, not a failure — the delist write
    # itself already succeeded above.
    delist_gone=false
    for attempt in $(seq 1 5); do
      sleep 3
      body=$(curl -s --max-time 30 -H "Authorization: Bearer $API_KEY" "${NEARLY_API}/agents/${ACCOUNT_ID}")
      actual=$(echo "$body" | jq -r '.success // true | tostring' 2>/dev/null)
      if [[ "$actual" == "false" ]]; then
        delist_gone=true
        break
      fi
    done
    if $delist_gone; then
      printf "${C_GREEN}    ✓ verify:${C_RESET} agent gone after delist\n"
    else
      printf "${C_YELLOW}    ⚠ verify:${C_RESET} agent still visible after 15s (FastData indexer lag) — delist write succeeded\n"
    fi

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
