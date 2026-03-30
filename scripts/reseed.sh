#!/usr/bin/env bash
# reseed.sh — Tear down clique, seed asymmetric graph, let suggestions drive follows
set -euo pipefail

NEARLY_API="${NEARLY_API:-https://nearly.social/api/v1}"
OUTLAYER_API="${OUTLAYER_API:-https://api.outlayer.fastnear.com}"
CREDS_FILE="$HOME/.config/nearly/credentials.json"

if [[ ! -f "$CREDS_FILE" ]]; then
  echo "ERROR: Credentials file not found at $CREDS_FILE" >&2
  exit 1
fi

account_for_handle() {
  local handle="$1"
  jq -r --arg h "$handle" \
    '.accounts | to_entries[] | select(.value.platforms.social.handle == $h) | .key // empty' \
    "$CREDS_FILE" | head -1
}

api_call() {
  local method="$1" path="$2" action="$3" handle="$4" extra_body="${5:-}"
  local account_id api_key
  account_id=$(account_for_handle "$handle")
  if [[ -z "$account_id" ]]; then
    echo "ERROR: No account found for handle '$handle'" >&2
    return 1
  fi
  api_key=$(jq -r --arg id "$account_id" '.accounts[$id].api_key' "$CREDS_FILE")
  if [[ -z "$api_key" || "$api_key" == "null" ]]; then
    echo "ERROR: No api_key for account '$account_id'" >&2
    return 1
  fi

  if [[ "$method" == "GET" ]]; then
    # GET requests: proxy doesn't parse bodies, so use Bearer token auth
    curl -s -X GET -H "Authorization: Bearer $api_key" "${NEARLY_API}${path}"
    return
  fi

  local timestamp message sign_resp
  timestamp=$(($(date +%s) * 1000))
  message=$(jq -n -c --arg acct "$account_id" --argjson ts "$timestamp" --arg action "$action" \
    '{action:$action,domain:"nearly.social",account_id:$acct,version:1,timestamp:$ts}')
  sign_resp=$(curl -s -X POST "${OUTLAYER_API}/wallet/v1/sign-message" \
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
  curl -s -X "$method" -H "Content-Type: application/json" -d "$body" "${NEARLY_API}${path}"
}

ALL=(jlwaugh professor dog alice_bot bob_agent carol_agent)

# --- Step 1: Unfollow all ---
# (Already done — skip if re-running)
if [[ "${SKIP_UNFOLLOW:-}" != "1" ]]; then
  echo "=== Step 1: Unfollowing all ==="
  for from in "${ALL[@]}"; do
    for to in "${ALL[@]}"; do
      [[ "$from" == "$to" ]] && continue
      resp=$(api_call DELETE "/agents/${to}/follow" "unfollow" "$from")
      action=$(echo "$resp" | jq -r '.data.action // empty')
      [[ "$action" == "unfollowed" ]] && echo "  @$from ⊘ @$to"
    done
    sleep 6  # follow/unfollow rate limit: 10 per 60s
  done
else
  echo "=== Step 1: Skipped (SKIP_UNFOLLOW=1) ==="
fi

# --- Step 2: Seed — asymmetric follows ---
if [[ "${SKIP_SEED:-}" != "1" ]]; then
  echo ""
  echo "=== Step 2: Seeding asymmetric graph ==="
  # jlwaugh follows alice_bot + bob_agent
  # professor follows bob_agent + carol_agent
  # (bob_agent gets 2 followers = most popular, alice/carol get 1 each, dog gets 0)
  SEEDS=("jlwaugh:alice_bot" "jlwaugh:bob_agent" "professor:bob_agent" "professor:carol_agent")
  for pair in "${SEEDS[@]}"; do
    from="${pair%%:*}" to="${pair##*:}"
    resp=$(api_call POST "/agents/${to}/follow" "follow" "$from")
    action=$(echo "$resp" | jq -r '.data.action // .error // "failed"')
    next=$(echo "$resp" | jq -r '.data.next_suggestion.handle // "-"')
    echo "  @$from → @$to: $action (next_suggestion: $next)"
    sleep 6  # follow/unfollow rate limit: 10 per 60s
  done
else
  echo "=== Step 2: Skipped (SKIP_SEED=1) ==="
fi

# --- Step 3: Staggered heartbeats ---
echo ""
echo "=== Step 3: Staggered heartbeats (updating last_active) ==="
for h in dog carol_agent alice_bot bob_agent professor jlwaugh; do
  resp=$(api_call POST "/agents/me/heartbeat" "heartbeat" "$h")
  new=$(echo "$resp" | jq -r '.data.delta.new_followers_count // 0')
  echo "  @$h heartbeat — $new new followers"
  sleep 6  # stagger so last_active differs; heartbeat rate limit: 5 per 60s
done

# --- Step 4: Suggestion-driven follows ---
echo ""
echo "=== Step 4: Suggestion-driven follows ==="
for h in dog alice_bot bob_agent carol_agent; do
  echo "[$h]"
  suggestions=$(api_call GET "/agents/suggested?limit=5" "get_suggested" "$h")

  # Show suggestions with reasons
  echo "$suggestions" | jq -r '.data.agents[]? | "    \(.handle) — \(.reason // "no reason")"' 2>/dev/null || echo "    (no suggestions or parse error)"

  # Follow top 2-3
  targets=$(echo "$suggestions" | jq -r '.data.agents[].handle' 2>/dev/null | head -3)
  for target in $targets; do
    resp=$(api_call POST "/agents/${target}/follow" "follow" "$h")
    action=$(echo "$resp" | jq -r '.data.action // .error // "failed"')
    next=$(echo "$resp" | jq -r '.data.next_suggestion.handle // "-"')
    echo "  → @$target: $action (next: $next)"
    sleep 2
  done
  echo ""
done

# --- Step 5: Verify different suggestion lists ---
echo "=== Step 5: Verify different suggestions per agent ==="
for h in "${ALL[@]}"; do
  suggestions=$(api_call GET "/agents/suggested?limit=5" "get_suggested" "$h")
  list=$(echo "$suggestions" | jq -r '[.data.agents[]?.handle] | join(", ")' 2>/dev/null) || list="(parse error)"
  echo "  @$h sees: [$list]"
  sleep 2
done

# --- Final state ---
echo ""
echo "=== Final graph ==="
for h in "${ALL[@]}"; do
  curl -s "${NEARLY_API}/agents/${h}" | jq -c '{h: .data.agent.handle, in: .data.agent.follower_count, out: .data.agent.following_count}'
done
