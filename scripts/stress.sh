#!/usr/bin/env bash
# stress.sh — Production stress test for nearly.social
#
# Adversarial quality test exercising real behavior under concurrent load.
# Uses only the public API documented in skill.md.
# All test agents are cleaned up at the end regardless of outcome.
#
# Usage:
#   ./scripts/stress.sh              # Run all dimensions
#   ./scripts/stress.sh --skip-cleanup  # Leave test agents (for debugging)

set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════

NEARLY_API="https://nearly.social/api/v1"
OUTLAYER_API="https://api.outlayer.fastnear.com"
FASTDATA_KV_URL="${FASTDATA_KV_URL:-https://kv.main.fastnear.com}"
FASTDATA_NS="${FASTDATA_NS:-nearly.hack.near}"
FASTDATA_SIGNER="${FASTDATA_SIGNER:-hack.near}"
CREDS_FILE="$HOME/.config/nearly/stress-credentials.json"
REPORT_FILE="$(cd "$(dirname "$0")" && pwd)/stress-report.txt"
TMP_DIR=$(mktemp -d)
SKIP_CLEANUP=false
ADMIN_PK="${OUTLAYER_PAYMENT_KEY:-}"

# Unique prefix per run to avoid handle collisions with orphaned agents
RUN_ID=$(printf '%04d' $((RANDOM % 10000)))
AGENTS=(sx${RUN_ID}a sx${RUN_ID}b sx${RUN_ID}c sx${RUN_ID}d sx${RUN_ID}e sx${RUN_ID}f sx${RUN_ID}g sx${RUN_ID}h sx${RUN_ID}i sx${RUN_ID}j)
NUM_AGENTS=${#AGENTS[@]}

# Test counters
TEST_NUM=0
PASS_COUNT=0
FAIL_COUNT=0

# Latency arrays (stored in files)
mkdir -p "$TMP_DIR/latency"

# Findings arrays (stored in files)
mkdir -p "$TMP_DIR/findings"
FINDING_NUM=0

# Per-dimension results
mkdir -p "$TMP_DIR/dims"

# Start time
SCRIPT_START=$(date +%s)

# ═══════════════════════════════════════════════════════════════════════
# Args
# ═══════════════════════════════════════════════════════════════════════

for arg in "$@"; do
  case "$arg" in
    --skip-cleanup) SKIP_CLEANUP=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ═══════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════

log() { echo "[$(date +%H:%M:%S)] $*"; }

check() {
  local ok="$1" desc="$2"
  TEST_NUM=$((TEST_NUM + 1))
  if [[ "$ok" == "true" || "$ok" == "1" ]]; then
    printf '\033[32m[PASS]\033[0m %s\n' "$desc"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '\033[31m[FAIL]\033[0m %s\n' "$desc"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

dim_banner() { log ""; log "═══════════════════════════════════════════"; log "  $1"; log "═══════════════════════════════════════════"; }

require_registered() {
  local min="${1:-2}" dim_name="$2"
  REGISTERED=()
  for h in "${AGENTS[@]}"; do
    local ak
    ak=$(get_api_key "$h" 2>/dev/null)
    [[ -n "$ak" ]] && REGISTERED+=("$h")
  done
  if [[ ${#REGISTERED[@]} -lt $min ]]; then
    log "  SKIP: fewer than $min registered agents"
    check "false" "${dim_name}: need at least $min agents (have ${#REGISTERED[@]})"
    echo "SKIPPED: insufficient agents" > "$TMP_DIR/dims/${dim_name}.txt"
    return 1
  fi
  return 0
}

build_targets_json() {
  local self="$1"; shift
  local arr=("$@")
  local json="[]"
  for t in "${arr[@]}"; do
    [[ "$self" == "$t" ]] && continue
    json=$(echo "$json" | jq --arg t "$t" '. + [$t]')
  done
  echo "$json"
}

finding() {
  local category="$1" detail="$2"
  FINDING_NUM=$((FINDING_NUM + 1))
  echo "$category|$detail" >> "$TMP_DIR/findings/all.txt"
  log "  FINDING [$category]: $detail"
}

now_ms() { echo $(( $(date +%s) * 1000 )); }

now_ns() {
  # macOS: use perl for nanosecond-ish precision
  if command -v gdate &>/dev/null; then
    gdate +%s%N
  else
    perl -MTime::HiRes=time -e 'printf "%d\n", time * 1e9'
  fi
}

elapsed_ms() {
  local start="$1"
  local end
  end=$(now_ns)
  echo $(( (end - start) / 1000000 ))
}

record_latency() {
  local dim="$1" ms="$2"
  echo "$ms" >> "$TMP_DIR/latency/${dim}.txt"
}

latency_stats() {
  local dim="$1"
  local file="$TMP_DIR/latency/${dim}.txt"
  if [[ ! -f "$file" ]]; then
    echo "no data"
    return
  fi
  local sorted
  sorted=$(sort -n "$file")
  local count min max sum avg p50 p95 p99
  count=$(wc -l < "$file" | tr -d ' ')
  min=$(echo "$sorted" | head -1)
  max=$(echo "$sorted" | tail -1)
  sum=0
  while IFS= read -r v; do sum=$((sum + v)); done < "$file"
  avg=$((sum / count))
  p50=$(echo "$sorted" | sed -n "$((count * 50 / 100 + 1))p")
  p95=$(echo "$sorted" | sed -n "$((count * 95 / 100 + 1))p")
  p99=$(echo "$sorted" | sed -n "$((count * 99 / 100 + 1))p")
  echo "min=${min}ms avg=${avg}ms max=${max}ms p50=${p50}ms p95=${p95}ms p99=${p99}ms (n=$count)"
}

# ═══════════════════════════════════════════════════════════════════════
# Credential management (separate from production)
# ═══════════════════════════════════════════════════════════════════════

ensure_creds() {
  mkdir -p "$(dirname "$CREDS_FILE")"
  if [[ ! -f "$CREDS_FILE" ]]; then
    echo '{"accounts":{}}' > "$CREDS_FILE"
  fi
}

save_cred() {
  local handle="$1" data="$2"
  local tmp
  tmp=$(mktemp)
  jq --arg h "$handle" --argjson d "$data" \
    '.accounts[$h] = (.accounts[$h] // {}) * $d' \
    "$CREDS_FILE" > "$tmp" && mv "$tmp" "$CREDS_FILE"
}

get_api_key() {
  local handle="$1"
  jq -r --arg h "$handle" '.accounts[$h].api_key // empty' "$CREDS_FILE"
}

get_account_id() {
  local handle="$1"
  jq -r --arg h "$handle" '.accounts[$h].near_account_id // empty' "$CREDS_FILE"
}

# ═══════════════════════════════════════════════════════════════════════
# API helpers (based on reseed.sh api_call pattern)
# ═══════════════════════════════════════════════════════════════════════

# Unauthenticated GET
st_get() {
  local path="$1"
  curl -s --max-time 30 "${NEARLY_API}${path}"
}

# Authenticated API call with verifiable_claim signing
st_api() {
  local method="$1" path="$2" action="$3" handle="$4" extra_body="${5:-}"
  local api_key account_id
  api_key=$(get_api_key "$handle")
  account_id=$(get_account_id "$handle")

  if [[ -z "$api_key" || -z "$account_id" ]]; then
    echo '{"success":false,"error":"No credentials for '"$handle"'"}'
    return 1
  fi

  if [[ "$method" == "GET" ]]; then
    curl -s --max-time 30 -H "Authorization: Bearer $api_key" "${NEARLY_API}${path}"
    return
  fi

  # Sign NEP-413 message
  local timestamp message sign_resp
  timestamp=$(now_ms)
  message=$(jq -n -c --arg acct "$account_id" --argjson ts "$timestamp" --arg action "$action" \
    '{action:$action,domain:"nearly.social",account_id:$acct,version:1,timestamp:$ts}')
  sign_resp=$(curl -s --max-time 15 -X POST "${OUTLAYER_API}/wallet/v1/sign-message" \
    -H "Authorization: Bearer $api_key" -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$message" '{message:$msg,recipient:"nearly.social"}')")

  local claim
  claim=$(jq -n --arg acct "$account_id" \
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
  curl -s --max-time 30 -X "$method" -H "Content-Type: application/json" -d "$body" "${NEARLY_API}${path}"
}

# ═══════════════════════════════════════════════════════════════════════
# Registration (based on swarm.sh register_agent)
# ═══════════════════════════════════════════════════════════════════════

st_register() {
  local handle="$1"

  # Check if already registered from a previous run
  local existing_key
  existing_key=$(get_api_key "$handle")
  if [[ -n "$existing_key" ]]; then
    local exists
    exists=$(st_get "/agents/${handle}" | jq -r '.success // false')
    if [[ "$exists" == "true" ]]; then
      log "  $handle: already registered (previous run)"
      return 0
    fi
  fi

  # 1. Create custody wallet
  local wallet api_key account_id wallet_id
  wallet=$(curl -s --max-time 15 -X POST "${OUTLAYER_API}/register")
  api_key=$(echo "$wallet" | jq -r '.api_key')
  account_id=$(echo "$wallet" | jq -r '.near_account_id')
  wallet_id=$(echo "$wallet" | jq -r '.wallet_id')

  if [[ -z "$api_key" || "$api_key" == "null" ]]; then
    log "  $handle: wallet creation failed: $wallet"
    return 1
  fi

  # Save credentials immediately
  save_cred "$handle" "$(jq -n \
    --arg ak "$api_key" --arg wid "$wallet_id" --arg nid "$account_id" --arg h "$handle" \
    '{api_key:$ak, wallet_id:$wid, near_account_id:$nid, handle:$h}')"

  # 2. Sign registration message
  local timestamp message sign_resp
  timestamp=$(now_ms)
  message=$(jq -n -c \
    --arg acct "$account_id" --argjson ts "$timestamp" \
    '{action:"register",domain:"nearly.social",account_id:$acct,version:1,timestamp:$ts}')
  sign_resp=$(curl -s --max-time 15 -X POST "${OUTLAYER_API}/wallet/v1/sign-message" \
    -H "Authorization: Bearer $api_key" -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$message" '{message:$msg,recipient:"nearly.social"}')")

  local public_key signature nonce
  public_key=$(echo "$sign_resp" | jq -r '.public_key')
  signature=$(echo "$sign_resp" | jq -r '.signature')
  nonce=$(echo "$sign_resp" | jq -r '.nonce')

  if [[ -z "$signature" || "$signature" == "null" ]]; then
    log "  $handle: signing failed: $sign_resp"
    return 1
  fi

  # 3. Register on Nearly Social
  local reg_body reg_resp
  reg_body=$(jq -n \
    --arg handle "$handle" \
    --arg desc "Stress test agent $handle" \
    --argjson tags '["stress","test"]' \
    --argjson caps '{"skills":["stress_testing"]}' \
    --arg acct "$account_id" \
    --arg pk "$public_key" \
    --arg sig "$signature" \
    --arg nonce "$nonce" \
    --arg msg "$message" \
    '{handle:$handle, description:$desc, tags:$tags, capabilities:$caps,
      verifiable_claim:{near_account_id:$acct, public_key:$pk,
        signature:$sig, nonce:$nonce, message:$msg}}')
  reg_resp=$(curl -s --max-time 60 -X POST "${NEARLY_API}/agents/register" \
    -H "Content-Type: application/json" -d "$reg_body")

  local success
  success=$(echo "$reg_resp" | jq -r '.success // false')
  if [[ "$success" != "true" ]]; then
    local code
    code=$(echo "$reg_resp" | jq -r '.code // empty')
    if [[ "$code" == "ALREADY_REGISTERED" ]]; then
      log "  $handle: ALREADY_REGISTERED (lost response scenario)"
      finding "RELIABILITY" "Registration for $handle returned ALREADY_REGISTERED — possible lost response from prior attempt"
      return 0
    fi

    # Check if it succeeded server-side despite error response (lost response scenario)
    log "  $handle: registration returned error ($code), verifying server-side..."
    sleep 2
    local verify
    verify=$(curl -s --max-time 15 "${NEARLY_API}/agents/${handle}" | jq -r '.success // false')
    if [[ "$verify" == "true" ]]; then
      log "  $handle: FOUND server-side despite error response — lost response confirmed"
      finding "RELIABILITY" "Registration for $handle returned error ($code) but succeeded server-side — lost response"
      return 0
    fi

    log "  $handle: registration failed: $(echo "$reg_resp" | jq -c .)"
    return 1
  fi

  return 0
}

# ═══════════════════════════════════════════════════════════════════════
# Cleanup
# ═══════════════════════════════════════════════════════════════════════

cleanup() {
  if $SKIP_CLEANUP; then
    log "CLEANUP SKIPPED (--skip-cleanup)"
    return
  fi

  dim_banner "CLEANUP: Deregistering test agents"

  for handle in "${AGENTS[@]}"; do
    local api_key
    api_key=$(get_api_key "$handle")
    if [[ -z "$api_key" ]]; then
      continue
    fi

    # Check if still registered
    local still_registered
    still_registered=$(st_get "/agents/${handle}" | jq -r '.success // false' 2>/dev/null || echo "false")
    if [[ "$still_registered" != "true" ]]; then
      continue
    fi

    log "  Deregistering $handle..."
    local resp action

    # Try normal deregister first (via agent's own credentials)
    resp=$(st_api DELETE "/agents/me" "deregister" "$handle" 2>/dev/null || echo '{}')
    action=$(echo "$resp" | jq -r '.data.action // .code // "unknown"' 2>/dev/null || echo "error")

    if [[ "$action" != "deregistered" && -n "$ADMIN_PK" ]]; then
      # Fallback: admin deregister via payment key
      log "    Normal deregister failed ($action), trying admin..."
      resp=$(curl -s --max-time 60 -X POST "${OUTLAYER_API}/call/hack.near/nearly" \
        -H "X-Payment-Key: $ADMIN_PK" \
        -H "Content-Type: application/json" \
        -d "{\"input\":{\"action\":\"admin_deregister\",\"handle\":\"$handle\"}}" 2>/dev/null || echo '{}')
      local output
      output=$(echo "$resp" | jq -r '.output' 2>/dev/null)
      if echo "$output" | jq . &>/dev/null 2>&1; then
        action=$(echo "$output" | jq -r '.data.action // .error // "unknown"')
      else
        action=$(echo "$resp" | jq -r '.output.data.action // .output.error // "unknown"')
      fi
    fi

    log "    → $action"
    sleep 2
  done

  rm -f "$CREDS_FILE"
  log "  Credentials cleaned up"
}

trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════
# Preflight
# ═══════════════════════════════════════════════════════════════════════

log "═══════════════════════════════════════════"
log "  NEARLY SOCIAL PRODUCTION STRESS TEST"
log "  $(date)"
log "═══════════════════════════════════════════"
log ""

# Check dependencies
for cmd in curl jq perl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required"
    exit 1
  fi
done

# Check API is reachable
log "Preflight: checking API health..."
HEALTH=$(st_get "/health")
BASELINE_COUNT=$(echo "$HEALTH" | jq -r '.data.agent_count // 0')
SERVER_TIME=$(echo "$HEALTH" | jq -r '.data.server_time // 0')
log "  Health: ok | Baseline agents: $BASELINE_COUNT | Server time: $SERVER_TIME"

ensure_creds

# ═══════════════════════════════════════════════════════════════════════
# DIMENSION 1: Registration Throughput
# ═══════════════════════════════════════════════════════════════════════

dim1_registration() {
  dim_banner "DIMENSION 1: Registration Throughput"

  local dim_start batch1_end
  dim_start=$(now_ns)
  local success_count=0
  local fail_count=0

  # Batch 1: agents 0-4
  log "  Batch 1: registering ${AGENTS[0]} through ${AGENTS[4]}..."
  for i in 0 1 2 3 4; do
    local handle="${AGENTS[$i]}"
    local t0
    t0=$(now_ns)
    if st_register "$handle"; then
      local ms
      ms=$(elapsed_ms "$t0")
      record_latency "dim1" "$ms"
      log "  $handle: registered (${ms}ms)"
      success_count=$((success_count + 1))
    else
      fail_count=$((fail_count + 1))
      log "  $handle: FAILED"
    fi
    sleep 2
  done

  batch1_end=$(date +%s)

  # Wait for rate window to expire before batch 2
  log "  Waiting for register rate window (5/60s per IP)..."
  local wait_until=$((batch1_end + 55))
  while [[ $(date +%s) -lt $wait_until ]]; do
    local remaining=$((wait_until - $(date +%s)))
    printf "\r  [%ds remaining]  " "$remaining"
    sleep 5
  done
  echo ""

  # Batch 2: agents 5-9
  log "  Batch 2: registering ${AGENTS[5]} through ${AGENTS[9]}..."
  for i in 5 6 7 8 9; do
    local handle="${AGENTS[$i]}"
    local t0
    t0=$(now_ns)
    if st_register "$handle"; then
      local ms
      ms=$(elapsed_ms "$t0")
      record_latency "dim1" "$ms"
      log "  $handle: registered (${ms}ms)"
      success_count=$((success_count + 1))
    else
      fail_count=$((fail_count + 1))
      log "  $handle: FAILED"
    fi
    sleep 2
  done

  # Verify all agents exist
  log "  Verifying registrations..."
  local verified=0
  for handle in "${AGENTS[@]}"; do
    local found_handle
    found_handle=$(st_get "/agents/${handle}" 2>/dev/null | jq -r '.data.agent.handle // empty' 2>/dev/null || echo "")
    if [[ "$found_handle" == "$handle" ]]; then
      verified=$((verified + 1))
    else
      finding "INVARIANT" "Agent $handle not found after successful registration"
    fi
  done

  # Check agent count increased
  local new_count
  new_count=$(st_get "/health" 2>/dev/null | jq -r '.data.agent_count // 0' 2>/dev/null || echo "0")
  local expected=$((BASELINE_COUNT + NUM_AGENTS))

  check "$([[ $success_count -eq $NUM_AGENTS ]] && echo true || echo false)" \
    "dim1: all $NUM_AGENTS registrations succeeded ($success_count/$NUM_AGENTS)"
  check "$([[ $verified -eq $NUM_AGENTS ]] && echo true || echo false)" \
    "dim1: all $NUM_AGENTS agents verified via GET ($verified/$NUM_AGENTS)"
  check "$([[ $new_count -ge $expected ]] && echo true || echo false)" \
    "dim1: health agent_count increased (expected >=$expected, got $new_count)"

  local dim_ms
  dim_ms=$(elapsed_ms "$dim_start")
  log "  Latency: $(latency_stats dim1)"
  log "  Duration: $((dim_ms / 1000))s | Registered: $success_count | Failed: $fail_count"

  echo "Registration: $success_count/$NUM_AGENTS succeeded. Latency: $(latency_stats dim1)" > "$TMP_DIR/dims/dim1.txt"
}

# ═══════════════════════════════════════════════════════════════════════
# DIMENSION 2: Social Graph Density
# ═══════════════════════════════════════════════════════════════════════

dim2_social_density() {
  dim_banner "DIMENSION 2: Social Graph Density"

  local total_follows=0
  local failed_follows=0
  local already_following=0

  require_registered 2 "dim2" || return
  local registered=("${REGISTERED[@]}")

  local reg_count=${#registered[@]}
  local expected_per_agent=$((reg_count - 1))
  local expected_follows=$((reg_count * expected_per_agent))

  # Each agent batch-follows every other — one WASM invocation per agent
  for from in "${registered[@]}"; do
    local targets_json
    targets_json=$(build_targets_json "$from" "${registered[@]}")

    local t0 resp
    t0=$(now_ns)
    local batch_body
    batch_body=$(jq -n --argjson targets "$targets_json" '{targets:$targets}')
    resp=$(st_api POST "/agents/batch-follow" "batch_follow" "$from" "$batch_body" 2>/dev/null || echo '{"success":false,"error":"timeout"}')
    local ms
    ms=$(elapsed_ms "$t0")
    record_latency "dim2_follow" "$ms"

    local batch_action
    batch_action=$(echo "$resp" | jq -r '.data.action // .code // "error"')

    if [[ "$batch_action" == "batch_followed" ]]; then
      # Count individual results
      local n_followed n_already n_errors
      n_followed=$(echo "$resp" | jq '[.data.results[] | select(.action == "followed")] | length')
      n_already=$(echo "$resp" | jq '[.data.results[] | select(.action == "already_following")] | length')
      n_errors=$(echo "$resp" | jq '[.data.results[] | select(.action == "error")] | length')
      total_follows=$((total_follows + n_followed + n_already))
      already_following=$((already_following + n_already))
      failed_follows=$((failed_follows + n_errors))
      if [[ "$n_errors" -gt 0 ]]; then
        local err_details
        err_details=$(echo "$resp" | jq -r '[.data.results[] | select(.action == "error") | "\(.handle): \(.error)"] | join(", ")')
        finding "FAILURE" "Batch follow from $from had $n_errors errors: $err_details"
      fi
      log "  $from: batch-followed $n_followed agents ($n_already already, $n_errors errors)"
    elif [[ "$batch_action" == "RATE_LIMITED" ]]; then
      log "  $from: RATE_LIMITED — waiting..."
      local retry_after
      retry_after=$(echo "$resp" | jq -r '.retry_after // 10')
      sleep "$retry_after"
      # Retry once
      resp=$(st_api POST "/agents/batch-follow" "batch_follow" "$from" "$batch_body" 2>/dev/null || echo '{"success":false,"error":"timeout"}')
      batch_action=$(echo "$resp" | jq -r '.data.action // "error"')
      if [[ "$batch_action" == "batch_followed" ]]; then
        local n_followed
        n_followed=$(echo "$resp" | jq '[.data.results[] | select(.action == "followed" or .action == "already_following")] | length')
        total_follows=$((total_follows + n_followed))
      else
        failed_follows=$((failed_follows + expected_per_agent))
        finding "FAILURE" "Batch follow from $from failed after rate limit retry: $batch_action"
      fi
    else
      failed_follows=$((failed_follows + expected_per_agent))
      finding "FAILURE" "Batch follow from $from returned unexpected: $batch_action"
    fi
    sleep 2
  done

  # Verify counts
  log "  Verifying follower/following counts..."
  local count_ok=0
  local count_drift=0
  for handle in "${registered[@]}"; do
    local profile
    profile=$(st_get "/agents/${handle}" 2>/dev/null || echo '{}')
    local fc fc2
    fc=$(echo "$profile" | jq -r '.data.agent.follower_count // 0')
    fc2=$(echo "$profile" | jq -r '.data.agent.following_count // 0')
    if [[ "$fc" -eq $expected_per_agent && "$fc2" -eq $expected_per_agent ]]; then
      count_ok=$((count_ok + 1))
    else
      count_drift=$((count_drift + 1))
      finding "INVARIANT" "$handle: follower_count=$fc following_count=$fc2 (expected $expected_per_agent/$expected_per_agent)"
    fi
  done

  # Spot-check followers list
  local spot_handle="${registered[0]}"
  local followers_resp
  followers_resp=$(st_get "/agents/${spot_handle}/followers?limit=100" 2>/dev/null || echo '{}')

  local follower_list_count
  follower_list_count=$(echo "$followers_resp" | jq '[.data[]?] | length')

  # Spot-check edges for mutuality
  local edges_resp
  edges_resp=$(st_get "/agents/${spot_handle}/edges?direction=both&limit=100" 2>/dev/null || echo '{}')

  local mutual_count
  mutual_count=$(echo "$edges_resp" | jq '[.data.edges[]? | select(.direction == "mutual")] | length' 2>/dev/null || echo "0")

  check "$([[ $total_follows -eq $expected_follows ]] && echo true || echo false)" \
    "dim2: all $expected_follows follow edges created ($total_follows created, $failed_follows failed)"
  check "$([[ $count_ok -eq $reg_count ]] && echo true || echo false)" \
    "dim2: all agents have counts=$expected_per_agent ($count_ok/$reg_count correct)"
  check "$([[ "$follower_list_count" -eq $expected_per_agent ]] && echo true || echo false)" \
    "dim2: $spot_handle followers list has $expected_per_agent entries (got $follower_list_count)"
  check "$([[ "$mutual_count" -eq $expected_per_agent ]] && echo true || echo false)" \
    "dim2: $spot_handle has $expected_per_agent mutual edges (got $mutual_count)"

  log "  Follow latency: $(latency_stats dim2_follow)"
  log "  Edges: $total_follows/$expected_follows | Count accuracy: $count_ok/$reg_count | Drift: $count_drift"

  echo "Follows: $total_follows/$expected_follows. Count accuracy: $count_ok/$reg_count. Latency: $(latency_stats dim2_follow)" > "$TMP_DIR/dims/dim2.txt"
}

# ═══════════════════════════════════════════════════════════════════════
# DIMENSION 3: Heartbeat Under Concurrent Load
# ═══════════════════════════════════════════════════════════════════════

dim3_heartbeat() {
  dim_banner "DIMENSION 3: Heartbeat Under Concurrent Load"

  require_registered 2 "dim3" || return
  local registered=("${REGISTERED[@]}")
  local reg_count=${#registered[@]}

  # Fire all heartbeats concurrently
  local wall_start
  wall_start=$(now_ns)

  for handle in "${registered[@]}"; do
    (
      local t0 resp
      t0=$(now_ns)
      resp=$(st_api POST "/agents/me/heartbeat" "heartbeat" "$handle" 2>/dev/null || echo '{"success":false,"error":"timeout"}')
      local ms
      ms=$(( ( $(now_ns) - t0 ) / 1000000 ))
      echo "$resp" | jq -c --argjson ms "$ms" '. + {_latency_ms: $ms}' > "$TMP_DIR/hb_${handle}.json"
    ) &
  done
  wait

  local wall_ms
  wall_ms=$(elapsed_ms "$wall_start")
  log "  Wall clock: ${wall_ms}ms for $NUM_AGENTS concurrent heartbeats"

  # Analyze results
  local hb_success=0
  local hb_timeout=0
  local hb_502=0
  local max_latency=0

  for handle in "${registered[@]}"; do
    local file="$TMP_DIR/hb_${handle}.json"
    if [[ ! -f "$file" ]]; then
      hb_timeout=$((hb_timeout + 1))
      finding "FAILURE" "Heartbeat for $handle: no response file"
      continue
    fi

    local success latency_ms new_followers_count
    success=$(jq -r '.success // false' "$file")
    latency_ms=$(jq -r '._latency_ms // 0' "$file")
    record_latency "dim3" "$latency_ms"

    if [[ "$success" == "true" ]]; then
      hb_success=$((hb_success + 1))
      new_followers_count=$(jq -r '.data.delta.new_followers_count // 0' "$file")
      if [[ "$latency_ms" -gt "$max_latency" ]]; then
        max_latency=$latency_ms
      fi
    else
      local error_msg
      error_msg=$(jq -r '.error // "unknown"' "$file")
      if [[ "$error_msg" == *"502"* || "$error_msg" == *"timeout"* ]]; then
        hb_502=$((hb_502 + 1))
        finding "LIMIT" "Heartbeat timeout for $handle (${latency_ms}ms): $error_msg"
      else
        finding "FAILURE" "Heartbeat for $handle failed: $error_msg"
      fi
    fi
  done

  check "$([[ $hb_success -eq $reg_count ]] && echo true || echo false)" \
    "dim3: all $reg_count heartbeats succeeded ($hb_success succeeded, $hb_timeout timeouts, $hb_502 502s)"
  check "$([[ $max_latency -lt 10000 ]] && echo true || echo false)" \
    "dim3: max heartbeat latency < 10s (got ${max_latency}ms)"

  log "  Heartbeat latency: $(latency_stats dim3)"
  log "  Success: $hb_success | Timeouts: $hb_timeout | 502s: $hb_502"

  echo "Heartbeat: $hb_success/$NUM_AGENTS succeeded. Max latency: ${max_latency}ms. Latency: $(latency_stats dim3)" > "$TMP_DIR/dims/dim3.txt"
}

# ═══════════════════════════════════════════════════════════════════════
# DIMENSION 4: Endorsement Cascade
# ═══════════════════════════════════════════════════════════════════════

dim4_endorsements() {
  dim_banner "DIMENSION 4: Endorsement Cascade"

  require_registered 2 "dim4" || return
  local registered=("${REGISTERED[@]}")
  local reg_count=${#registered[@]}

  local total_endorsed=0
  local endorse_failed=0
  local rollback_partials=0
  local warnings_seen=0

  # Each agent batch-endorses every other agent's "stress" tag
  for from in "${registered[@]}"; do
    local targets_json
    targets_json=$(build_targets_json "$from" "${registered[@]}")

    local t0 resp batch_action
    t0=$(now_ns)
    local batch_body
    batch_body=$(jq -n --argjson targets "$targets_json" '{targets:$targets,tags:["stress"]}')
    resp=$(st_api POST "/agents/batch-endorse" "batch_endorse" "$from" "$batch_body" 2>/dev/null || echo '{"success":false,"error":"timeout"}')
    local ms
    ms=$(elapsed_ms "$t0")
    record_latency "dim4_endorse" "$ms"

    batch_action=$(echo "$resp" | jq -r '.data.action // .code // "error"')

    if [[ "$batch_action" == "batch_endorsed" ]]; then
      local n_endorsed n_errors
      n_endorsed=$(echo "$resp" | jq '[.data.results[] | select(.action == "endorsed")] | length')
      n_errors=$(echo "$resp" | jq '[.data.results[] | select(.action == "error")] | length')
      total_endorsed=$((total_endorsed + n_endorsed))
      endorse_failed=$((endorse_failed + n_errors))
      if [[ "$n_errors" -gt 0 ]]; then
        local err_details
        err_details=$(echo "$resp" | jq -r '[.data.results[] | select(.action == "error") | "\(.handle): \(.error)"] | join(", ")')
        finding "FAILURE" "Batch endorse from $from had $n_errors errors: $err_details"
      fi
      # Check for ROLLBACK_PARTIAL in individual results
      local n_rollback
      n_rollback=$(echo "$resp" | jq '[.data.results[] | select(.error == "ROLLBACK_PARTIAL")] | length' 2>/dev/null || echo "0")
      rollback_partials=$((rollback_partials + n_rollback))
      log "  $from: batch-endorsed $n_endorsed agents ($n_errors errors)"
    elif [[ "$batch_action" == "RATE_LIMITED" ]]; then
      log "  $from: endorse RATE_LIMITED — waiting..."
      local retry_after
      retry_after=$(echo "$resp" | jq -r '.retry_after // 10')
      sleep "$retry_after"
      resp=$(st_api POST "/agents/batch-endorse" "batch_endorse" "$from" "$batch_body" 2>/dev/null || echo '{"success":false,"error":"timeout"}')
      batch_action=$(echo "$resp" | jq -r '.data.action // "error"')
      if [[ "$batch_action" == "batch_endorsed" ]]; then
        local n_endorsed
        n_endorsed=$(echo "$resp" | jq '[.data.results[] | select(.action == "endorsed")] | length')
        total_endorsed=$((total_endorsed + n_endorsed))
      else
        endorse_failed=$((endorse_failed + ${#registered[@]} - 1))
        finding "FAILURE" "Batch endorse from $from failed after rate limit retry: $batch_action"
      fi
    else
      endorse_failed=$((endorse_failed + ${#registered[@]} - 1))
      finding "FAILURE" "Batch endorse from $from returned: $batch_action"
    fi
    sleep 2
  done

  # Verify endorsement counts before cascade
  log "  Checking endorsement counts before cascade..."
  local alpha_endorsers_before
  local cascade_agent="${registered[0]}"
  alpha_endorsers_before=$(st_get "/agents/${cascade_agent}/endorsers" 2>/dev/null | jq '[.data.endorsers.tags.stress[]?] | length' 2>/dev/null || echo "0")
  log "  $cascade_agent has $alpha_endorsers_before endorsers for 'stress'"

  # Trigger cascade: first agent removes "stress" tag
  log "  Triggering cascade: $cascade_agent removing 'stress' tag..."
  local cascade_resp
  cascade_resp=$(st_api PATCH "/agents/me" "update_profile" "$cascade_agent" '{"tags":["test","dim4_updated"]}' 2>/dev/null || echo '{"success":false,"error":"timeout"}')
  local cascade_success
  cascade_success=$(echo "$cascade_resp" | jq -r '.success // false')
  local cascade_warnings
  cascade_warnings=$(echo "$cascade_resp" | jq -c '.warnings // []')

  if [[ "$cascade_warnings" != "[]" ]]; then
    finding "OBSERVATION" "Profile update cascade produced warnings: $cascade_warnings"
  fi

  # Wait a moment for cascade to propagate, then verify
  sleep 3

  # Verify endorsements for "stress" on cascade_agent are gone
  local alpha_endorsers_after
  alpha_endorsers_after=$(st_get "/agents/${cascade_agent}/endorsers" 2>/dev/null | jq '[.data.endorsers.tags.stress[]?] | length' 2>/dev/null || echo "0")
  log "  $cascade_agent endorsers for 'stress' after cascade: $alpha_endorsers_after (was $alpha_endorsers_before)"

  # Verify other agents' endorsement counts are unaffected
  local other_ok=0
  for handle in "${registered[@]:1}"; do  # skip cascade_agent
    local endorser_count
    endorser_count=$(st_get "/agents/${handle}/endorsers" 2>/dev/null | jq '[.data.endorsers.tags.stress[]?] | length' 2>/dev/null || echo "0")
    # Cascade only removes endorsements ON cascade_agent (it dropped the tag).
    # Other agents' endorser counts should still be reg_count - 1 (everyone except self).
    local expected_endorsers=$((reg_count - 1))
    if [[ "$endorser_count" -eq $expected_endorsers ]]; then
      other_ok=$((other_ok + 1))
    else
      finding "INVARIANT" "$handle has $endorser_count endorsers for 'stress' (expected $expected_endorsers)"
    fi
  done

  local expected_endorsements=$((reg_count * (reg_count - 1)))
  check "$([[ $total_endorsed -eq $expected_endorsements ]] && echo true || echo false)" \
    "dim4: all $expected_endorsements endorsements created ($total_endorsed created, $endorse_failed failed)"
  check "$([[ $rollback_partials -eq 0 ]] && echo true || echo false)" \
    "dim4: no ROLLBACK_PARTIAL errors ($rollback_partials seen)"
  check "$([[ "$cascade_success" == "true" ]] && echo true || echo false)" \
    "dim4: cascade trigger (tag removal) succeeded"
  check "$([[ $alpha_endorsers_after -eq 0 ]] && echo true || echo false)" \
    "dim4: $cascade_agent 'stress' endorsements removed after cascade (was $alpha_endorsers_before, now $alpha_endorsers_after)"
  check "$([[ $other_ok -eq $((reg_count - 1)) ]] && echo true || echo false)" \
    "dim4: other agents' endorsement counts unaffected ($other_ok/$((reg_count - 1)) correct)"

  log "  Endorse latency: $(latency_stats dim4_endorse)"

  echo "Endorsements: $total_endorsed/$expected_endorsements. ROLLBACK_PARTIAL: $rollback_partials. Cascade: ${cascade_agent} endorsers ${alpha_endorsers_before}→${alpha_endorsers_after}." > "$TMP_DIR/dims/dim4.txt"
}

# ═══════════════════════════════════════════════════════════════════════
# DIMENSION 5: Concurrent Mutations
# ═══════════════════════════════════════════════════════════════════════

dim5_concurrent_mutations() {
  dim_banner "DIMENSION 5: Concurrent Mutations"

  require_registered 3 "dim5" || return
  local registered=("${REGISTERED[@]}")

  local target="${registered[${#registered[@]}-1]}"

  # Step 1: All agents unfollow the target (reset state)
  log "  Resetting: all agents unfollow $target..."
  for handle in "${registered[@]}"; do
    [[ "$handle" == "$target" ]] && continue
    st_api DELETE "/agents/${target}/follow" "unfollow" "$handle" > /dev/null 2>&1 || true
    sleep 1
  done

  # Wait for rate windows
  sleep 5

  # Verify target has 0 followers
  local pre_count
  pre_count=$(st_get "/agents/${target}" 2>/dev/null | jq -r '.data.agent.follower_count // -1' 2>/dev/null || echo "-1")
  log "  $target follower_count before concurrent follows: $pre_count"

  # Step 2: 9 agents simultaneously follow the target
  local expected_concurrent=$((${#registered[@]} - 1))
  log "  Launching $expected_concurrent concurrent follows on $target..."
  local concurrent_agents=()
  for handle in "${registered[@]}"; do
    [[ "$handle" == "$target" ]] && continue
    concurrent_agents+=("$handle")
  done

  for handle in "${concurrent_agents[@]}"; do
    (
      local resp
      resp=$(st_api POST "/agents/${target}/follow" "follow" "$handle" 2>/dev/null || echo '{"success":false}')
      echo "$resp" > "$TMP_DIR/cf_${handle}.json"
    ) &
  done
  wait

  # Analyze results
  local cf_followed=0
  local cf_already=0
  local cf_failed=0
  for handle in "${concurrent_agents[@]}"; do
    local file="$TMP_DIR/cf_${handle}.json"
    if [[ ! -f "$file" ]]; then
      cf_failed=$((cf_failed + 1))
      continue
    fi
    local action
    action=$(jq -r '.data.action // .code // "error"' "$file")
    case "$action" in
      followed) cf_followed=$((cf_followed + 1)) ;;
      already_following) cf_already=$((cf_already + 1)) ;;
      *)
        cf_failed=$((cf_failed + 1))
        finding "FAILURE" "Concurrent follow ${handle}→${target}: $action"
        ;;
    esac
  done

  # Wait a moment, then verify follower count
  sleep 3
  local post_count
  post_count=$(st_get "/agents/${target}" 2>/dev/null | jq -r '.data.agent.follower_count // -1' 2>/dev/null || echo "-1")

  # Check for duplicates in followers list
  local followers_resp
  followers_resp=$(st_get "/agents/${target}/followers?limit=100" 2>/dev/null || echo '{}')

  local unique_followers total_in_list
  total_in_list=$(echo "$followers_resp" | jq '[.data[]?] | length')
  unique_followers=$(echo "$followers_resp" | jq '[.data[]?.handle] | unique | length')

  check "$([[ $cf_followed -eq $expected_concurrent || $((cf_followed + cf_already)) -eq $expected_concurrent ]] && echo true || echo false)" \
    "dim5: all $expected_concurrent concurrent follows completed ($cf_followed followed, $cf_already already, $cf_failed failed)"
  check "$([[ "$post_count" -eq $expected_concurrent ]] && echo true || echo false)" \
    "dim5: $target follower_count = $expected_concurrent after concurrent follows (got $post_count)"
  check "$([[ "$unique_followers" -eq "$total_in_list" ]] && echo true || echo false)" \
    "dim5: no duplicate followers ($unique_followers unique of $total_in_list listed)"

  if [[ "$post_count" -lt $expected_concurrent ]]; then
    finding "INVARIANT" "Lost writes: $target has $post_count followers after $expected_concurrent concurrent follows"
  fi

  log "  Results: $cf_followed followed, $cf_already already, $cf_failed failed"
  log "  $target follower_count: $pre_count → $post_count"

  echo "Concurrent follows: $cf_followed/$expected_concurrent succeeded. Target follower_count: $post_count (expected $expected_concurrent). Duplicates: $((total_in_list - unique_followers))." > "$TMP_DIR/dims/dim5.txt"
}

# ═══════════════════════════════════════════════════════════════════════
# DIMENSION 6: Rate Limit Enforcement
# ═══════════════════════════════════════════════════════════════════════

dim6_rate_limits() {
  dim_banner "DIMENSION 6: Rate Limit Enforcement"

  require_registered 2 "dim6" || return
  local registered=("${REGISTERED[@]}")

  local actor="${registered[0]}"
  local target="${registered[1]}"

  # Wait for rate window to clear — poll until a follow succeeds
  log "  Waiting for $actor follow rate window to clear..."
  local waited=0
  while [[ $waited -lt 120 ]]; do
    local probe
    probe=$(st_api POST "/agents/${target}/follow" "follow" "$actor" 2>/dev/null || echo '{"success":false,"error":"timeout"}')
    local probe_action
    probe_action=$(echo "$probe" | jq -r '.data.action // .code // "error"')
    if [[ "$probe_action" != "RATE_LIMITED" ]]; then
      break
    fi
    local retry_after
    retry_after=$(echo "$probe" | jq -r '.retry_after // 10')
    log "  Still rate limited, waiting ${retry_after}s..."
    sleep "$retry_after"
    waited=$((waited + retry_after))
  done

  # Now we have a fresh window with 1 follow used (the probe).
  # Rapidly alternate follow/unfollow to use up the remaining 9 follow ops
  log "  Hammering follow endpoint (10/60s limit)..."
  local op_count=1  # counting the probe
  local last_success_op=1

  # Unfollow first so we can follow again
  st_api DELETE "/agents/${target}/follow" "unfollow" "$actor" > /dev/null 2>&1 || true
  sleep 0.5

  while [[ $op_count -lt 15 ]]; do
    local resp action code
    resp=$(st_api POST "/agents/${target}/follow" "follow" "$actor" 2>/dev/null || echo '{"success":false,"error":"timeout"}')
    action=$(echo "$resp" | jq -r '.data.action // empty')
    code=$(echo "$resp" | jq -r '.code // empty')
    op_count=$((op_count + 1))

    if [[ "$code" == "RATE_LIMITED" ]]; then
      local retry_after
      retry_after=$(echo "$resp" | jq -r '.retry_after // 0')
      log "  Op $op_count: RATE_LIMITED (retry_after=${retry_after}s)"

      check "true" "dim6: rate limit enforced at operation $op_count (limit 10/60s)"
      check "$([[ $retry_after -gt 0 ]] && echo true || echo false)" \
        "dim6: retry_after present and > 0 (got ${retry_after}s)"
      check "$([[ $last_success_op -le 10 ]] && echo true || echo false)" \
        "dim6: last successful follow was op $last_success_op (expected <= 10)"
      break
    elif [[ "$action" == "followed" || "$action" == "already_following" ]]; then
      last_success_op=$op_count
      log "  Op $op_count: $action"
      # Unfollow so we can follow again
      st_api DELETE "/agents/${target}/follow" "unfollow" "$actor" > /dev/null 2>&1 || true
    else
      log "  Op $op_count: unexpected: $(echo "$resp" | jq -c .)"
      finding "FAILURE" "Rate limit test op $op_count returned unexpected: $action / $code"
    fi
    sleep 0.3
  done

  if [[ $op_count -ge 15 ]]; then
    check "false" "dim6: rate limit never triggered after 15 operations"
    finding "INVARIANT" "Follow rate limit not enforced after 15 operations"
  fi

  echo "Rate limit triggered at op $op_count. Last success: op $last_success_op." > "$TMP_DIR/dims/dim6.txt"
}

# ═══════════════════════════════════════════════════════════════════════
# DIMENSION 7: Deregistration Under Load
# ═══════════════════════════════════════════════════════════════════════

dim7_deregister() {
  dim_banner "DIMENSION 7: Deregistration Under Load"

  require_registered 3 "dim7" || return
  local registered=("${REGISTERED[@]}")

  local target="${registered[0]}"

  # Snapshot before deregistration
  log "  Snapshotting $target state before deregistration..."
  local before_profile
  before_profile=$(st_get "/agents/${target}" 2>/dev/null || echo '{}')
  local before_fc before_fgc
  before_fc=$(echo "$before_profile" | jq -r '.data.agent.follower_count // 0')
  before_fgc=$(echo "$before_profile" | jq -r '.data.agent.following_count // 0')
  log "  $target: follower_count=$before_fc following_count=$before_fgc"

  # Snapshot a connected agent's counts
  local peer="${registered[2]}"
  local peer_fc_before peer_fgc_before
  peer_fc_before=$(st_get "/agents/${peer}" 2>/dev/null | jq -r '.data.agent.follower_count // 0' 2>/dev/null || echo "0")
  peer_fgc_before=$(st_get "/agents/${peer}" 2>/dev/null | jq -r '.data.agent.following_count // 0' 2>/dev/null || echo "0")

  # Deregister
  log "  Deregistering $target..."
  local t0 resp
  t0=$(now_ns)
  resp=$(st_api DELETE "/agents/me" "deregister" "$target" 2>/dev/null || echo '{"success":false,"error":"timeout"}')
  local ms
  ms=$(elapsed_ms "$t0")
  record_latency "dim7" "$ms"

  local action
  action=$(echo "$resp" | jq -r '.data.action // .code // "error"')
  log "  Deregister result: $action (${ms}ms)"

  local has_warnings
  has_warnings=$(echo "$resp" | jq 'has("warnings")' 2>/dev/null || echo "false")
  if [[ "$has_warnings" == "true" ]]; then
    finding "OBSERVATION" "Deregister warnings: $(echo "$resp" | jq -c '.warnings')"
  fi

  local rollback
  rollback=$(echo "$resp" | jq -r '.code // empty')
  if [[ "$rollback" == "ROLLBACK_PARTIAL" ]]; then
    finding "INVARIANT" "Deregistration returned ROLLBACK_PARTIAL"
  fi

  # Wait for cache expiry on public GETs (profiles cached 60s, but let's check quickly)
  sleep 3

  # Verify agent is gone
  local gone_check
  gone_check=$(st_get "/agents/${target}" 2>/dev/null | jq -r '.success // true' 2>/dev/null || echo "true")
  local handle_available
  handle_available=$(st_get "/agents/check/${target}" 2>/dev/null | jq -r '.data.available // false' 2>/dev/null || echo "false")

  # Verify connected agents' counts decremented
  sleep 2
  local peer_fc_after peer_fgc_after
  peer_fc_after=$(st_get "/agents/${peer}" 2>/dev/null | jq -r '.data.agent.follower_count // 0' 2>/dev/null || echo "0")
  peer_fgc_after=$(st_get "/agents/${peer}" 2>/dev/null | jq -r '.data.agent.following_count // 0' 2>/dev/null || echo "0")

  check "$([[ "$action" == "deregistered" ]] && echo true || echo false)" \
    "dim7: deregister returned action=deregistered (got $action)"
  check "$([[ "$gone_check" == "false" ]] && echo true || echo false)" \
    "dim7: GET /agents/$target returns success=false after deregister"
  check "$([[ "$handle_available" == "true" ]] && echo true || echo false)" \
    "dim7: handle $target is available after deregister"

  # Count decrements — note caching may delay this
  local fc_diff=$((peer_fc_before - peer_fc_after))
  local fgc_diff=$((peer_fgc_before - peer_fgc_after))
  check "$([[ $fc_diff -ge 1 ]] && echo true || echo false)" \
    "dim7: $peer follower_count decremented (was $peer_fc_before, now $peer_fc_after, diff=$fc_diff)"
  check "$([[ $fgc_diff -ge 1 ]] && echo true || echo false)" \
    "dim7: $peer following_count decremented (was $peer_fgc_before, now $peer_fgc_after, diff=$fgc_diff)"

  # Mark target as deregistered so cleanup skips it
  save_cred "$target" '{"deregistered":true}'

  echo "Deregister: $action. Handle available: $handle_available. Peer count diffs: fc=$fc_diff fgc=$fgc_diff." > "$TMP_DIR/dims/dim7.txt"
}

# ═══════════════════════════════════════════════════════════════════════
# DIMENSION 8: Pagination Under Mutation
# ═══════════════════════════════════════════════════════════════════════

dim8_pagination() {
  dim_banner "DIMENSION 8: Pagination Under Mutation"

  require_registered 2 "dim8" || return
  local registered=("${REGISTERED[@]}")

  local deregister_target="${registered[1]}"

  # Start deregistration in background
  log "  Starting deregistration of $deregister_target in background..."
  (
    st_api DELETE "/agents/me" "deregister" "$deregister_target" > "$TMP_DIR/dim8_dereg.json" 2>/dev/null
  ) &
  local dereg_pid=$!

  # Simultaneously paginate through all agents
  log "  Paginating GET /agents?limit=3..."
  local all_handles=""
  local cursor=""
  local page=0
  local cursor_resets=0

  while true; do
    local url="/agents?limit=3&sort=newest"
    [[ -n "$cursor" ]] && url="${url}&cursor=${cursor}"

    local resp
    resp=$(st_get "$url" 2>/dev/null || echo '{}')
    page=$((page + 1))

    local page_handles
    page_handles=$(echo "$resp" | jq -r '.data[]?.handle // empty' 2>/dev/null)

    if [[ -z "$page_handles" ]]; then
      break
    fi

    all_handles="${all_handles}${page_handles}"$'\n'

    # Check for cursor_reset
    local is_reset
    is_reset=$(echo "$resp" | jq -r '.pagination.cursor_reset // false')
    if [[ "$is_reset" == "true" ]]; then
      cursor_resets=$((cursor_resets + 1))
      finding "OBSERVATION" "Pagination cursor_reset on page $page"
    fi

    cursor=$(echo "$resp" | jq -r '.pagination.next_cursor // empty')
    if [[ -z "$cursor" ]]; then
      break
    fi

    sleep 0.2
  done

  # Wait for deregistration to complete
  wait "$dereg_pid" 2>/dev/null || true

  # Check for duplicates
  local total_seen unique_seen duplicates
  total_seen=$(echo "$all_handles" | grep -c . || echo 0)
  unique_seen=$(echo "$all_handles" | sort | uniq | grep -c . || echo 0)
  duplicates=$((total_seen - unique_seen))

  # Verify deregistered agent is gone
  local dereg_check
  dereg_check=$(st_get "/agents/${deregister_target}" 2>/dev/null | jq -r '.success // true' 2>/dev/null || echo "true")

  check "$([[ $duplicates -eq 0 ]] && echo true || echo false)" \
    "dim8: no duplicate agents across pages ($duplicates duplicates in $total_seen entries, $page pages)"
  check "$([[ "$dereg_check" == "false" ]] && echo true || echo false)" \
    "dim8: $deregister_target deregistered successfully"

  if [[ $duplicates -gt 0 ]]; then
    finding "INVARIANT" "$duplicates duplicate handles across $page pages"
  fi
  if [[ $cursor_resets -gt 0 ]]; then
    finding "OBSERVATION" "$cursor_resets cursor resets during pagination (expected behavior)"
  fi

  # Mark deregister_target as deregistered
  save_cred "$deregister_target" '{"deregistered":true}'

  log "  Pages: $page | Total entries: $total_seen | Unique: $unique_seen | Duplicates: $duplicates | Cursor resets: $cursor_resets"

  echo "Pagination: $page pages, $total_seen entries, $duplicates duplicates, $cursor_resets resets." > "$TMP_DIR/dims/dim8.txt"
}

# ═══════════════════════════════════════════════════════════════════════
# DIMENSION 9: FastData KV Read Verification
# ═══════════════════════════════════════════════════════════════════════

dim9_fastdata_reads() {
  dim_banner "DIMENSION 9: FastData KV Read Verification"

  require_registered 2 "dim9" || return
  local registered=("${REGISTERED[@]}")
  local reg_count=${#registered[@]}

  local kv_base="${FASTDATA_KV_URL}/v0/latest/${FASTDATA_NS}/${FASTDATA_SIGNER}"
  local kv_multi="${FASTDATA_KV_URL}/v0/multi"

  # --- 9a: Verify registered agents are readable from FastData KV ---
  log "  9a: Checking agent records in FastData KV..."
  local found=0 missing=0
  for h in "${registered[@]}"; do
    local resp
    resp=$(curl -s --max-time 10 "${kv_base}/agent/${h}")
    local has_entry
    has_entry=$(echo "$resp" | jq -r '.entries[0].value.handle // empty' 2>/dev/null)
    if [[ "$has_entry" == "$h" ]]; then
      found=$((found + 1))
    else
      missing=$((missing + 1))
      finding "OBSERVATION" "Agent $h not found in FastData KV"
    fi
  done
  check "$( (( found > 0 )) && echo true || echo false)" \
    "dim9: at least 1 agent readable from FastData KV ($found/$reg_count found)"

  # --- 9b: kvMulti batch read ---
  log "  9b: Batch multi-key read..."
  local multi_keys
  multi_keys=$(printf '%s\n' "${registered[@]}" | head -20 | \
    jq -R "\"${FASTDATA_NS}/${FASTDATA_SIGNER}/agent/\" + ." | jq -s '{keys: .}')
  local multi_start
  multi_start=$(now_ns)
  local multi_resp
  multi_resp=$(curl -s --max-time 15 -X POST -H "Content-Type: application/json" \
    -d "$multi_keys" "$kv_multi")
  local multi_ms
  multi_ms=$(elapsed_ms "$multi_start")
  record_latency "dim9_multi" "$multi_ms"

  local multi_count
  multi_count=$(echo "$multi_resp" | jq '[.entries[]? | select(. != null)] | length' 2>/dev/null || echo 0)
  local expected_multi
  expected_multi=$(printf '%s\n' "${registered[@]}" | head -20 | wc -l | tr -d ' ')
  check "$( (( multi_count >= expected_multi / 2 )) && echo true || echo false)" \
    "dim9: kvMulti returned $multi_count/$expected_multi entries (${multi_ms}ms)"

  # --- 9c: Eventual consistency after follow mutations ---
  # Depends on dim2 having created a follow edge between the first two agents.
  # Guard: verify the edge exists in the primary API before polling FastData,
  # so a dim2 failure doesn't burn 30s and produce a misleading failure here.
  log "  9c: Polling for follow-edge consistency..."
  local agent0="${registered[0]}"
  local agent1="${registered[1]}"
  local convergence_ms=0

  local api_edge
  api_edge=$(st_get "/agents/${agent1}/followers" | jq -r ".followers[]?.handle // empty" 2>/dev/null)
  if ! echo "$api_edge" | grep -q "^${agent0}$"; then
    log "  9c: SKIP — ${agent0}→${agent1} follow edge not present in API (dim2 may have failed)"
    finding "OBSERVATION" "dim9 9c skipped: follow edge ${agent0}→${agent1} not in API"
  else
    local poll_start poll_found=false
    poll_start=$(now_ns)

    for attempt in $(seq 1 15); do
      local edge_resp
      edge_resp=$(curl -s --max-time 10 "${kv_base}/follower/${agent1}/${agent0}")
      local edge_val
      edge_val=$(echo "$edge_resp" | jq -r '.entries[0].value // empty' 2>/dev/null)
      if [[ -n "$edge_val" && "$edge_val" != "null" ]]; then
        poll_found=true
        convergence_ms=$(elapsed_ms "$poll_start")
        break
      fi
      sleep 2
    done

    if [[ "$poll_found" == "true" ]]; then
      record_latency "dim9_converge" "$convergence_ms"
      log "  Follower edge converged in ${convergence_ms}ms"
    else
      convergence_ms=$(elapsed_ms "$poll_start")
      finding "LIMIT" "FastData follower edge not found after ${convergence_ms}ms (${agent0}→${agent1})"
    fi
    check "$poll_found" \
      "dim9: follower edge ${agent0}→${agent1} visible in FastData KV (${convergence_ms}ms)"
  fi

  # --- 9d: Verify agent_count metadata ---
  log "  9d: Checking meta/agent_count..."
  local meta_resp meta_count
  meta_resp=$(curl -s --max-time 10 "${kv_base}/meta/agent_count")
  meta_count=$(echo "$meta_resp" | jq -r '.entries[0].value // 0' 2>/dev/null || echo 0)
  check "$( (( meta_count > 0 )) && echo true || echo false)" \
    "dim9: meta/agent_count > 0 in FastData KV (got $meta_count)"

  log "  Multi-read latency: $(latency_stats dim9_multi)"
  echo "FastData: $found/$reg_count agents found. Multi: ${multi_ms}ms. Convergence: ${convergence_ms}ms." > "$TMP_DIR/dims/dim9.txt"
}

# ═══════════════════════════════════════════════════════════════════════
# Report
# ═══════════════════════════════════════════════════════════════════════

generate_report() {
  local duration=$(( $(date +%s) - SCRIPT_START ))
  local mins=$((duration / 60))
  local secs=$((duration % 60))

  {
    echo "═══════════════════════════════════════════════════════════════"
    echo "  NEARLY.SOCIAL PRODUCTION STRESS TEST REPORT"
    echo "  Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "  Duration: ${mins}m ${secs}s"
    echo "  Agents: $NUM_AGENTS (prefix: sx${RUN_ID})"
    echo "  Baseline agent count: $BASELINE_COUNT"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""

    # System limits
    echo "SYSTEM LIMITS FOUND"
    echo "-------------------"
    if [[ -f "$TMP_DIR/findings/all.txt" ]]; then
      while IFS='|' read -r cat detail; do
        if [[ "$cat" == "LIMIT" ]]; then
          echo "  - $detail"
        fi
      done < "$TMP_DIR/findings/all.txt"
    fi
    echo ""

    # Invariant violations
    echo "INVARIANT VIOLATIONS"
    echo "--------------------"
    local violations=0
    if [[ -f "$TMP_DIR/findings/all.txt" ]]; then
      while IFS='|' read -r cat detail; do
        if [[ "$cat" == "INVARIANT" ]]; then
          echo "  - $detail"
          violations=$((violations + 1))
        fi
      done < "$TMP_DIR/findings/all.txt"
    fi
    if [[ $violations -eq 0 ]]; then echo "  None"; fi
    echo ""

    # Reliability observations
    echo "RELIABILITY OBSERVATIONS"
    echo "------------------------"
    if [[ -f "$TMP_DIR/findings/all.txt" ]]; then
      while IFS='|' read -r cat detail; do
        if [[ "$cat" == "RELIABILITY" || "$cat" == "OBSERVATION" ]]; then
          echo "  - $detail"
        fi
      done < "$TMP_DIR/findings/all.txt"
    fi
    echo ""

    # Failures
    echo "FAILURES"
    echo "--------"
    local failures=0
    if [[ -f "$TMP_DIR/findings/all.txt" ]]; then
      while IFS='|' read -r cat detail; do
        if [[ "$cat" == "FAILURE" ]]; then
          echo "  - $detail"
          failures=$((failures + 1))
        fi
      done < "$TMP_DIR/findings/all.txt"
    fi
    if [[ $failures -eq 0 ]]; then echo "  None"; fi
    echo ""

    # Dimension results
    echo "DIMENSION RESULTS"
    echo "-----------------"
    for i in 1 2 3 4 5 6 7 8 9; do
      local file="$TMP_DIR/dims/dim${i}.txt"
      if [[ -f "$file" ]]; then
        echo "  Dim $i: $(cat "$file")"
      else
        echo "  Dim $i: (not run)"
      fi
    done
    echo ""

    # Recommendations
    echo "RECOMMENDATIONS"
    echo "---------------"
    echo "  (Based on findings above — see individual findings for details)"
    if [[ -f "$TMP_DIR/findings/all.txt" ]] && grep -q "INVARIANT" "$TMP_DIR/findings/all.txt" 2>/dev/null; then
      echo "  - Investigate invariant violations — counts may drift from reality"
    fi
    if [[ -f "$TMP_DIR/findings/all.txt" ]] && grep -q "timeout\|502" "$TMP_DIR/findings/all.txt" 2>/dev/null; then
      echo "  - Concurrent WASM operations cause upstream timeouts — agents should serialize mutations"
      echo "  - Agents should verify state (GET) after any timeout before retrying"
    fi
    echo "  - Registration must be serialized (5 concurrent registrations = 5 upstream timeouts)"
    echo "  - Deregister rate limit is per-account, not global — cleanup parallelizes well"
    echo ""

    # Summary
    echo "SUMMARY"
    echo "-------"
    echo "  $PASS_COUNT passed, $FAIL_COUNT failed (of $TEST_NUM)"
    echo ""

    if [[ $FAIL_COUNT -gt 0 ]]; then
      echo "EXIT: FAIL ($FAIL_COUNT failures)"
    else
      echo "EXIT: PASS (all $PASS_COUNT tests passed)"
    fi
  } | tee "$REPORT_FILE"
}

# ═══════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════

dim1_registration
log "  [cooldown] 15s before social density..."
sleep 15
dim2_social_density
log "  [cooldown] 5s before FastData read verification..."
sleep 5
dim9_fastdata_reads
log "  [cooldown] 15s before heartbeat..."
sleep 15
dim3_heartbeat
log "  [cooldown] 15s before endorsements..."
sleep 15
dim4_endorsements
log "  [cooldown] 15s before concurrent mutations..."
sleep 15
dim5_concurrent_mutations
dim6_rate_limits
dim7_deregister
dim8_pagination

dim_banner "ALL DIMENSIONS COMPLETE"

generate_report

# Cleanup runs via trap

# Clean up temp dir
rm -rf "$TMP_DIR"

# Exit code
if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
