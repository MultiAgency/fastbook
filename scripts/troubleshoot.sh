#!/usr/bin/env bash
# troubleshoot.sh — Diagnose nearly.social infrastructure layer by layer.
#
# Checks each component in the request path independently so you can
# pinpoint which layer is broken without running the full stress test.
#
# Usage:
#   ./scripts/troubleshoot.sh              # Run all probes
#   ./scripts/troubleshoot.sh --register   # Include a live registration round-trip
#   ./scripts/troubleshoot.sh --verbose    # Print full response bodies

set -euo pipefail

NEARLY_API="https://nearly.social/api/v1"
OUTLAYER_API="https://api.outlayer.fastnear.com"
FASTDATA_KV_URL="${FASTDATA_KV_URL:-https://kv.main.fastnear.com}"
FASTDATA_NS="${FASTDATA_NS:-contextual.near}"
CREDS_FILE="$HOME/.config/nearly/stress-credentials.json"
REGISTER=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --register) REGISTER=true ;;
    --verbose)  VERBOSE=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ═══════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════

PASS=0
FAIL=0
WARN=0

pass() { printf '\033[32m  [PASS]\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '\033[31m  [FAIL]\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
warn() { printf '\033[33m  [WARN]\033[0m %s\n' "$1"; WARN=$((WARN + 1)); }
info() { printf '  [INFO] %s\n' "$1"; }
banner() { echo ""; echo "═══════════════════════════════════════════"; echo "  $1"; echo "═══════════════════════════════════════════"; }
vlog() { $VERBOSE && echo "  $1" || true; }

timed_curl() {
  local url="$1"; shift
  curl -s --max-time 15 -w '\n{"_http_code":%{http_code},"_time_ms":%{time_total}}' "$@" "$url"
}

extract_timing() {
  local raw="$1"
  echo "$raw" | tail -1 | jq -r '._time_ms' 2>/dev/null | awk '{printf "%.0f", $1 * 1000}'
}

extract_code() {
  local raw="$1"
  echo "$raw" | tail -1 | jq -r '._http_code' 2>/dev/null
}

extract_body() {
  local raw="$1"
  echo "$raw" | sed '$d'
}

now_ms() { echo $(( $(date +%s) * 1000 )); }

# ═══════════════════════════════════════════════════════════════════════
banner "LAYER 1: DNS & TLS Connectivity"
# ═══════════════════════════════════════════════════════════════════════

for endpoint in "$NEARLY_API" "$OUTLAYER_API" "$FASTDATA_KV_URL"; do
  host=$(echo "$endpoint" | sed -E 's|https?://([^/]+).*|\1|')
  if host "$host" > /dev/null 2>&1; then
    pass "DNS resolves: $host"
  else
    fail "DNS failed: $host"
  fi
done

for endpoint in "$NEARLY_API" "$OUTLAYER_API" "$FASTDATA_KV_URL"; do
  host=$(echo "$endpoint" | sed -E 's|https?://([^/]+).*|\1|')
  tls_ok=$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | grep -c "Verify return code: 0" || true)
  if [[ "$tls_ok" -ge 1 ]]; then
    pass "TLS valid: $host"
  else
    warn "TLS issue: $host (may still work)"
  fi
done

# ═══════════════════════════════════════════════════════════════════════
banner "LAYER 2: API Health (Nearly Social)"
# ═══════════════════════════════════════════════════════════════════════

raw=$(timed_curl "${NEARLY_API}/health")
body=$(extract_body "$raw")
code=$(extract_code "$raw")
ms=$(extract_timing "$raw")

vlog "Response: $body"

if [[ "$code" == "200" ]]; then
  pass "GET /health → 200 (${ms}ms)"
else
  fail "GET /health → $code (${ms}ms)"
fi

agent_count=$(echo "$body" | jq -r '.data.agent_count // "null"' 2>/dev/null)
status=$(echo "$body" | jq -r '.data.status // "null"' 2>/dev/null)
if [[ "$status" == "ok" ]]; then
  pass "Health status: ok"
else
  fail "Health status: $status"
fi
info "Agent count (from FastData KV): $agent_count"

# Check if API returns proper CORS
cors=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X OPTIONS \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" \
  "${NEARLY_API}/health")
if [[ "$cors" == "204" || "$cors" == "200" ]]; then
  pass "CORS preflight → $cors"
else
  warn "CORS preflight → $cors"
fi

# ═══════════════════════════════════════════════════════════════════════
banner "LAYER 3: FastData KV Direct"
# ═══════════════════════════════════════════════════════════════════════

# 3a: meta/agent_count (all predecessors)
raw=$(timed_curl "${FASTDATA_KV_URL}/v0/latest/${FASTDATA_NS}" \
  -X POST -H "Content-Type: application/json" -d '{"key":"meta/agent_count"}')
body=$(extract_body "$raw")
code=$(extract_code "$raw")
ms=$(extract_timing "$raw")

vlog "Response: $body"

if [[ "$code" == "200" ]]; then
  pass "FastData KV reachable (${ms}ms)"
else
  fail "FastData KV unreachable: HTTP $code (${ms}ms)"
fi

kv_count=$(echo "$body" | jq -r '.entries[0].value // "empty"' 2>/dev/null)
info "meta/agent_count in KV: $kv_count"
if [[ "$kv_count" == "empty" || "$kv_count" == "null" ]]; then
  warn "FastData KV has no agent_count — sync may have never run"
fi

# 3b: prefix scan for agents (all predecessors)
raw=$(timed_curl "${FASTDATA_KV_URL}/v0/latest/${FASTDATA_NS}" \
  -X POST -H "Content-Type: application/json" -d '{"key":"sorted/followers","limit":5}')
body=$(extract_body "$raw")
agent_list_count=$(echo "$body" | jq '.entries | length' 2>/dev/null || echo "0")
ms=$(extract_timing "$raw")
info "Agents in KV prefix scan: $agent_list_count (${ms}ms)"

# 3c: tag_counts (all predecessors)
raw=$(timed_curl "${FASTDATA_KV_URL}/v0/latest/${FASTDATA_NS}" \
  -X POST -H "Content-Type: application/json" -d '{"key":"tag_counts"}')
body=$(extract_body "$raw")
tag_count=$(echo "$body" | jq '.entries[0].value | length // 0' 2>/dev/null || echo "0")
ms=$(extract_timing "$raw")
info "Tag count entries in KV: $tag_count (${ms}ms)"

# 3d: block recency — check how fresh the latest KV data is
if [[ "$agent_list_count" -gt 0 ]]; then
  last_block=$(echo "$body" | jq '.entries[0].block_height // 0' 2>/dev/null)
  last_ts=$(echo "$body" | jq '.entries[0].block_timestamp // 0' 2>/dev/null)
  if [[ "$last_ts" -gt 0 ]]; then
    # block_timestamp is in nanoseconds
    last_secs=$((last_ts / 1000000000))
    now_secs=$(date +%s)
    age_secs=$((now_secs - last_secs))
    if [[ "$age_secs" -lt 300 ]]; then
      pass "Latest KV entry is ${age_secs}s old (block $last_block)"
    elif [[ "$age_secs" -lt 3600 ]]; then
      warn "Latest KV entry is ${age_secs}s old (block $last_block) — may be stale"
    else
      fail "Latest KV entry is ${age_secs}s old (block $last_block) — very stale"
    fi
  fi
else
  info "No KV entries to check freshness"
fi

# ═══════════════════════════════════════════════════════════════════════
banner "LAYER 4: OutLayer WASM Execution"
# ═══════════════════════════════════════════════════════════════════════

# 4a: Public read via WASM fallback — hit a nonexistent agent to test the path
raw=$(timed_curl "${NEARLY_API}/agents/__probe_nonexistent")
body=$(extract_body "$raw")
code=$(extract_code "$raw")
ms=$(extract_timing "$raw")

vlog "Response: $body"

if [[ "$code" == "404" ]]; then
  pass "Public read path works — 404 for missing agent (${ms}ms)"
elif [[ "$code" == "503" ]]; then
  fail "Public read path returned 503 — FastData KV down and WASM fallback failed (${ms}ms)"
elif [[ "$code" == "200" ]]; then
  warn "Probe agent __probe_nonexistent unexpectedly exists (${ms}ms)"
else
  fail "Public read path returned HTTP $code (${ms}ms)"
fi

# 4b: Unauthenticated mutation — should get 401
raw=$(timed_curl "${NEARLY_API}/agents/me/heartbeat" -X POST -H "Content-Type: application/json" -d '{}')
body=$(extract_body "$raw")
code=$(extract_code "$raw")
ms=$(extract_timing "$raw")

if [[ "$code" == "401" ]]; then
  pass "Auth gate works — 401 for unauthenticated heartbeat (${ms}ms)"
else
  fail "Auth gate unexpected: HTTP $code for unauthenticated heartbeat (${ms}ms)"
fi

# 4c: Check if OutLayer WASM project is reachable
raw=$(timed_curl "${OUTLAYER_API}/projects" -H "Content-Type: application/json")
code=$(extract_code "$raw")
ms=$(extract_timing "$raw")

if [[ "$code" -lt 500 ]]; then
  pass "OutLayer API reachable (${ms}ms)"
else
  fail "OutLayer API returned $code (${ms}ms)"
fi

# ═══════════════════════════════════════════════════════════════════════
banner "LAYER 5: OutLayer Wallet & Signing"
# ═══════════════════════════════════════════════════════════════════════

# 5a: Create a throwaway wallet
raw=$(timed_curl "${OUTLAYER_API}/register" -X POST)
body=$(extract_body "$raw")
code=$(extract_code "$raw")
ms=$(extract_timing "$raw")

vlog "Response: $(echo "$body" | jq -c '{api_key: .api_key[0:8], near_account_id, wallet_id}' 2>/dev/null || echo "$body")"

probe_key=$(echo "$body" | jq -r '.api_key // empty' 2>/dev/null)
probe_acct=$(echo "$body" | jq -r '.near_account_id // empty' 2>/dev/null)

if [[ -n "$probe_key" && "$probe_key" != "null" ]]; then
  pass "Wallet creation works (${ms}ms) — account: $probe_acct"
else
  fail "Wallet creation failed: HTTP $code (${ms}ms)"
  # Can't continue signing tests
  probe_key=""
fi

# 5b: Sign a message
if [[ -n "$probe_key" ]]; then
  sign_msg=$(jq -n -c --arg acct "$probe_acct" --argjson ts "$(now_ms)" \
    '{action:"probe",domain:"nearly.social",account_id:$acct,version:1,timestamp:$ts}')

  raw=$(timed_curl "${OUTLAYER_API}/wallet/v1/sign-message" \
    -X POST -H "Authorization: Bearer $probe_key" -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$sign_msg" '{message:$msg,recipient:"nearly.social"}')")
  body=$(extract_body "$raw")
  code=$(extract_code "$raw")
  ms=$(extract_timing "$raw")

  sig=$(echo "$body" | jq -r '.signature // empty' 2>/dev/null)
  if [[ -n "$sig" && "$sig" != "null" ]]; then
    pass "NEP-413 signing works (${ms}ms)"
  else
    fail "NEP-413 signing failed: HTTP $code (${ms}ms)"
    vlog "Response: $body"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════
banner "LAYER 6: NEAR RPC & FastData Write Path"
# ═══════════════════════════════════════════════════════════════════════

# 6a: NEAR RPC reachable
raw=$(timed_curl "https://rpc.mainnet.near.org/status")
code=$(extract_code "$raw")
ms=$(extract_timing "$raw")
if [[ "$code" == "200" ]]; then
  body=$(extract_body "$raw")
  latest_block=$(echo "$body" | jq -r '.sync_info.latest_block_height // "unknown"' 2>/dev/null)
  pass "NEAR RPC reachable (${ms}ms, block $latest_block)"
else
  fail "NEAR RPC unreachable: HTTP $code (${ms}ms)"
fi

# 6b: Check for any writes to the FastData namespace (all predecessors).
# Each agent writes via their own custody wallet, so we query across all predecessors.
# The namespace (e.g. nearly.hack.near) doesn't need to exist on-chain.
raw=$(timed_curl "${FASTDATA_KV_URL}/v0/latest/${FASTDATA_NS}" \
  -X POST -H "Content-Type: application/json" -d '{"limit":5}')
body=$(extract_body "$raw")
ms=$(extract_timing "$raw")
any_entries=$(echo "$body" | jq '.entries | length' 2>/dev/null || echo "0")
if [[ "$any_entries" -gt 0 ]]; then
  preds=$(echo "$body" | jq -r '[.entries[].predecessor_id] | unique | join(", ")' 2>/dev/null)
  pass "FastData KV has $any_entries entries for ${FASTDATA_NS} (${ms}ms)"
  info "Predecessors: $preds"
else
  warn "FastData KV has no entries for ${FASTDATA_NS} (${ms}ms) — no agent has synced yet"
fi

# ═══════════════════════════════════════════════════════════════════════
banner "LAYER 7: End-to-End Latency Profile"
# ═══════════════════════════════════════════════════════════════════════

info "Measuring 5 sequential reads to profile latency distribution..."
read_times=()
for i in 1 2 3 4 5; do
  raw=$(timed_curl "${NEARLY_API}/health")
  ms=$(extract_timing "$raw")
  read_times+=("$ms")
done
read_summary=$(printf '%s\n' "${read_times[@]}" | sort -n)
read_min=$(echo "$read_summary" | head -1)
read_max=$(echo "$read_summary" | tail -1)
info "Read latencies: ${read_times[*]}ms  (min=${read_min}ms max=${read_max}ms)"

if [[ "$read_max" -gt 5000 ]]; then
  fail "Read latency exceeds 5s (max=${read_max}ms)"
elif [[ "$read_max" -gt 2000 ]]; then
  warn "Read latency high (max=${read_max}ms)"
else
  pass "Read latency acceptable (max=${read_max}ms)"
fi

# ═══════════════════════════════════════════════════════════════════════
# Optional: Live registration round-trip
# ═══════════════════════════════════════════════════════════════════════

if $REGISTER && [[ -n "$probe_key" ]]; then
  banner "LAYER 8: Live Registration Round-Trip"

  probe_handle="diag$(printf '%04d' $((RANDOM % 10000)))"
  info "Registering probe agent: $probe_handle"

  # Sign registration claim
  reg_ts=$(now_ms)
  reg_msg=$(jq -n -c --arg acct "$probe_acct" --argjson ts "$reg_ts" \
    '{action:"register",domain:"nearly.social",account_id:$acct,version:1,timestamp:$ts}')

  sign_raw=$(timed_curl "${OUTLAYER_API}/wallet/v1/sign-message" \
    -X POST -H "Authorization: Bearer $probe_key" -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$reg_msg" '{message:$msg,recipient:"nearly.social"}')")
  sign_body=$(extract_body "$sign_raw")
  sign_ms=$(extract_timing "$sign_raw")
  info "Signing: ${sign_ms}ms"

  reg_body=$(jq -n \
    --arg handle "$probe_handle" \
    --arg desc "Troubleshoot probe $(date +%H:%M:%S)" \
    --argjson tags '["probe"]' \
    --argjson caps '{}' \
    --arg acct "$probe_acct" \
    --arg pk "$(echo "$sign_body" | jq -r .public_key)" \
    --arg sig "$(echo "$sign_body" | jq -r .signature)" \
    --arg nonce "$(echo "$sign_body" | jq -r .nonce)" \
    --arg msg "$reg_msg" \
    '{handle:$handle,description:$desc,tags:$tags,capabilities:$caps,
      verifiable_claim:{near_account_id:$acct,public_key:$pk,
        signature:$sig,nonce:$nonce,message:$msg}}')

  # Register
  raw=$(timed_curl "${NEARLY_API}/agents/register" \
    -X POST -H "Content-Type: application/json" -d "$reg_body")
  body=$(extract_body "$raw")
  code=$(extract_code "$raw")
  ms=$(extract_timing "$raw")

  reg_success=$(echo "$body" | jq -r '.success // false' 2>/dev/null)
  if [[ "$reg_success" == "true" ]]; then
    pass "Registration succeeded (${ms}ms)"
  else
    reg_error=$(echo "$body" | jq -r '.error // "unknown"' 2>/dev/null)
    reg_code=$(echo "$body" | jq -r '.code // "unknown"' 2>/dev/null)
    fail "Registration failed: $reg_error [$reg_code] (${ms}ms)"
    vlog "Response: $body"
  fi

  # Immediate read via API (FastData KV path)
  sleep 1
  raw=$(timed_curl "${NEARLY_API}/agents/${probe_handle}")
  body=$(extract_body "$raw")
  code=$(extract_code "$raw")
  ms=$(extract_timing "$raw")

  if [[ "$code" == "200" ]]; then
    pass "Immediate GET after register → 200 (${ms}ms)"
  else
    warn "Immediate GET after register → $code (${ms}ms) — expected if no sync on register"
  fi

  # Direct FastData KV read
  raw=$(timed_curl "${FASTDATA_KV_URL}/v0/latest/${FASTDATA_NS}" \
    -X POST -H "Content-Type: application/json" -d "{\"key\":\"handle/${probe_handle}\"}")
  body=$(extract_body "$raw")
  kv_val=$(echo "$body" | jq -r '.entries[0].predecessor_id // empty' 2>/dev/null)
  ms=$(extract_timing "$raw")

  if [[ -n "$kv_val" ]]; then
    pass "Agent in FastData KV immediately after register (${ms}ms)"
  else
    warn "Agent NOT in FastData KV after register (${ms}ms) — needs heartbeat to sync"
  fi

  # Heartbeat to trigger sync
  if [[ "$reg_success" == "true" ]]; then
    info "Sending heartbeat to trigger FastData sync..."

    hb_ts=$(now_ms)
    hb_msg=$(jq -n -c --arg acct "$probe_acct" --argjson ts "$hb_ts" \
      '{action:"heartbeat",domain:"nearly.social",account_id:$acct,version:1,timestamp:$ts}')

    hb_sign_raw=$(timed_curl "${OUTLAYER_API}/wallet/v1/sign-message" \
      -X POST -H "Authorization: Bearer $probe_key" -H "Content-Type: application/json" \
      -d "$(jq -n --arg msg "$hb_msg" '{message:$msg,recipient:"nearly.social"}')")
    hb_sign_body=$(extract_body "$hb_sign_raw")

    hb_body=$(jq -n \
      --arg acct "$probe_acct" \
      --arg pk "$(echo "$hb_sign_body" | jq -r .public_key)" \
      --arg sig "$(echo "$hb_sign_body" | jq -r .signature)" \
      --arg nonce "$(echo "$hb_sign_body" | jq -r .nonce)" \
      --arg msg "$hb_msg" \
      '{verifiable_claim:{near_account_id:$acct,public_key:$pk,
        signature:$sig,nonce:$nonce,message:$msg}}')

    raw=$(timed_curl "${NEARLY_API}/agents/me/heartbeat" \
      -X POST -H "Content-Type: application/json" -d "$hb_body")
    body=$(extract_body "$raw")
    code=$(extract_code "$raw")
    ms=$(extract_timing "$raw")

    hb_success=$(echo "$body" | jq -r '.success // false' 2>/dev/null)
    if [[ "$hb_success" == "true" ]]; then
      pass "Heartbeat succeeded (${ms}ms)"

      # Check FastData KV after sync
      sleep 3
      raw=$(timed_curl "${FASTDATA_KV_URL}/v0/latest/${FASTDATA_NS}" \
    -X POST -H "Content-Type: application/json" -d "{\"key\":\"handle/${probe_handle}\"}")
      body=$(extract_body "$raw")
      kv_val=$(echo "$body" | jq -r '.entries[0].predecessor_id // empty' 2>/dev/null)
      ms=$(extract_timing "$raw")

      if [[ -n "$kv_val" ]]; then
        pass "Agent synced to FastData KV after heartbeat (${ms}ms)"
      else
        fail "Agent NOT in FastData KV after heartbeat (${ms}ms) — sync broken"
      fi

      # GET via API should work now
      raw=$(timed_curl "${NEARLY_API}/agents/${probe_handle}")
      code=$(extract_code "$raw")
      ms=$(extract_timing "$raw")
      if [[ "$code" == "200" ]]; then
        pass "GET via API works after heartbeat sync (${ms}ms)"
      else
        fail "GET via API still fails after heartbeat (HTTP $code, ${ms}ms)"
      fi
    else
      hb_error=$(echo "$body" | jq -r '.error // "unknown"' 2>/dev/null)
      fail "Heartbeat failed: $hb_error (${ms}ms)"
      vlog "Response: $body"
    fi

    # Cleanup: deregister
    info "Cleaning up probe agent..."
    dereg_ts=$(now_ms)
    dereg_msg=$(jq -n -c --arg acct "$probe_acct" --argjson ts "$dereg_ts" \
      '{action:"deregister",domain:"nearly.social",account_id:$acct,version:1,timestamp:$ts}')

    dereg_sign_raw=$(timed_curl "${OUTLAYER_API}/wallet/v1/sign-message" \
      -X POST -H "Authorization: Bearer $probe_key" -H "Content-Type: application/json" \
      -d "$(jq -n --arg msg "$dereg_msg" '{message:$msg,recipient:"nearly.social"}')")
    dereg_sign_body=$(extract_body "$dereg_sign_raw")

    dereg_body=$(jq -n \
      --arg acct "$probe_acct" \
      --arg pk "$(echo "$dereg_sign_body" | jq -r .public_key)" \
      --arg sig "$(echo "$dereg_sign_body" | jq -r .signature)" \
      --arg nonce "$(echo "$dereg_sign_body" | jq -r .nonce)" \
      --arg msg "$dereg_msg" \
      '{verifiable_claim:{near_account_id:$acct,public_key:$pk,
        signature:$sig,nonce:$nonce,message:$msg}}')

    raw=$(timed_curl "${NEARLY_API}/agents/me" \
      -X DELETE -H "Content-Type: application/json" -d "$dereg_body")
    body=$(extract_body "$raw")
    code=$(extract_code "$raw")
    ms=$(extract_timing "$raw")
    dereg_ok=$(echo "$body" | jq -r '.success // false' 2>/dev/null)
    if [[ "$dereg_ok" == "true" ]]; then
      pass "Probe agent deregistered (${ms}ms)"
    else
      warn "Probe deregister returned $code (${ms}ms) — may need manual cleanup: $probe_handle"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════
banner "SUMMARY"
# ═══════════════════════════════════════════════════════════════════════

echo ""
printf "  \033[32m%d passed\033[0m" "$PASS"
[[ "$WARN" -gt 0 ]] && printf "  \033[33m%d warnings\033[0m" "$WARN"
[[ "$FAIL" -gt 0 ]] && printf "  \033[31m%d failed\033[0m" "$FAIL"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "  Troubleshooting guide:"
  echo "  ─────────────────────"
  echo "  Layer 1 fails → DNS/network issue, check connectivity"
  echo "  Layer 2 fails → Next.js app is down, check Vercel/hosting"
  echo "  Layer 3 fails → FastData KV is down or empty"
  echo "  Layer 4 fails → OutLayer WASM execution broken"
  echo "  Layer 5 fails → OutLayer wallet/signing service down"
  echo "  Layer 6 fails → NEAR RPC unreachable (blocks FastData sync)"
  echo "  Layer 7 fails → High latency, possible overload"
  echo "  Layer 8 fails → End-to-end registration/sync flow broken"
  echo ""
  exit 1
fi

if ! $REGISTER; then
  echo ""
  echo "  Tip: run with --register to test full registration round-trip"
fi

echo ""
exit 0
