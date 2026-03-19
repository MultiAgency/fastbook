# Demo Script — Bring Your Own NEAR Account

> Open this on a second screen during the demo. Each section is a phase.

---

## Setup (before they join)

```bash
cd ~/Desktop/near-agency/frontend
npm run dev
```

Open `http://localhost:3001/demo` in a clean browser tab (or incognito to avoid cached sessionStorage state).

**Quick pre-check:** Click "Create Wallet" once to confirm OutLayer is responding. If it works, click "Start Over" to reset. If it fails, the flow still works with mock data — just note the amber "Mock response" badge.

---

## Phase 1: The Problem (30 seconds)

> Don't show the screen yet. Set up the problem verbally.

**Say:**

"Today, when an agent registers on the NEAR AI Agent Market, the Market assigns it a brand new NEAR account. If that agent already has a NEAR account — with on-chain history, token balances, reputation — it loses all of that. It gets a disposable identity.

We think that's wrong. An agent's NEAR account IS its identity. Registration should verify ownership, not replace it."

---

## Phase 2: The Solution (30 seconds)

**Say:**

"We're proposing a simple extension to the Market's registration endpoint. Instead of always minting a new account, let the agent submit a `verifiable_claim` — a signed proof that it owns an existing NEAR account. If the proof checks out, the Market uses that account instead of creating a new one."

---

## Phase 3: Live Demo (2-3 minutes)

> Now show the screen. You're on `/demo`.

### Step 1 — Create OutLayer Wallet

**Click "Create Wallet"**

**Say:** "First, the agent gets a NEAR account through OutLayer's custody wallet API. This is a single POST request, no auth required. OutLayer gives back an account ID and an API key."

**Point out:**

- The real NEAR account ID displayed in the green box
- Click "View raw request / response" to show the JSON
- The green "Live API call" indicator — this is hitting the real OutLayer API right now

### Step 2 — Sign Registration Message

**Click "Sign Message"**

**Say:** "Now the agent proves it owns that account by signing a message using NEP-413. The message says 'I want to register on nearly.social' with a timestamp. OutLayer signs it with the account's private key."

**Point out:**

- The message preview (action, domain, version, timestamp)
- The real signature and public key in the response
- Expand the JSON viewer — show that the response shape IS the verifiable_claim

**Key line:** "This response — account_id, public_key, signature, nonce — maps directly to the `verifiable_claim` field we're proposing. No transformation needed."

### Step 3 — Register on Market

**Type a handle** (e.g., `demo_agent`)

**Click "Register Agent"**

**Say:** "This step is mocked — the Market doesn't support this endpoint yet. That's the whole point of this prototype. But look at the request body..."

**Expand the JSON viewer for Step 3.**

**Say:** "The `verifiable_claim` in the request body is exactly the signed proof from Step 2. The Market verifies the signature, confirms the public key belongs to the claimed account, and registers the agent with its existing identity. Same account, no new one created."

**Point out:**

- The "Proposed API — not yet implemented" badge
- The amber "Mock response" indicator
- In the response: `near_account_id` matches Step 1 — **this is the whole argument**

### Summary Card

**Say:** "After registration, the agent has both its OutLayer custody key and its Market API key, both tied to the same NEAR account."

**Point out:**

- Click reveal on the masked keys
- The "Fund wallet via OutLayer" link

---

## Phase 4: The Spec (1 minute)

> Switch to the README or scroll to it.

**Open `README.md`** and scroll to "Proposed Market API Extension"

**Say:** "This section is the actual proposal — the spec you'd hand to the Market team. It defines the `verifiable_claim` field, the NEP-413 message format, the verification steps for the backend, and why OutLayer makes it trivially implementable for any agent."

**Point out:**

- The 3 verification steps (validate message, verify ed25519 signature, register)
- The curl examples — two HTTP calls, no SDK needed
- "Any agent with an OutLayer custody wallet — or any NEP-413-compatible signer — can bring its existing NEAR identity to Market in seconds."

---

## Anticipated Questions

**Q: Why not just use NEAR wallet connect / MyNearWallet?**
A: Those are browser-based wallets for humans. Agents don't have browsers. OutLayer provides programmatic custody wallets designed for AI agents — sign via API, no UI needed.

**Q: What stops someone from claiming an account they don't own?**
A: The signature verification. The Market checks that the public key in the claim is actually an access key on the claimed account (via NEAR RPC `query/access_key`). You can't forge an ed25519 signature.

**Q: Why NEP-413 specifically?**
A: It's NEAR's standard for off-chain message signing. It includes a recipient field (anti-replay across domains) and the message is human-readable JSON (auditable). It's already implemented by wallets and OutLayer.

**Q: How hard is this to implement on the Market side?**
A: Five lines of verification logic (we spec them in the README). The endpoint shape doesn't change — you're just adding an optional field to the existing registration request.

**Q: What if OutLayer is down?**
A: The prototype falls back to mock data so the flow is always demonstrable. In production, the agent would retry or use any other NEP-413 signer — OutLayer is convenient but not required.

**Q: Is this production-ready?**
A: This is a prototype to demonstrate the concept and proposed API shape. The OutLayer integration is real. The Market integration is mocked because that endpoint doesn't exist yet — building it is what we're proposing.

**Q: Why is the NEAR account ID a long hex string instead of something like `agent.near`?**
A: OutLayer's trial wallets create implicit NEAR accounts (derived from the public key). In production, agents would typically use named accounts like `my-agent.near`. The verification flow is identical regardless — it's the same ed25519 signature check.

**Q: Why does this matter? What's wrong with the current flow?**
A: Every agent that registers on Market today gets a throwaway identity. If that agent already has tokens, reputation, or on-chain history on NEAR, all of that is orphaned. This proposal fixes that with zero breaking changes — it's an optional field on an existing endpoint.

**Q: How much work is this for the Market team to implement?**
A: Three steps: validate the signed message, verify the ed25519 signature, register. The signature verification is the only crypto — standard ed25519 over a sha256'd Borsh payload. The endpoint shape doesn't change — you're adding one optional field.

---

## If Things Go Wrong

| Problem                        | What happens                               | What to say                                                                                              |
| ------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| OutLayer API is down           | Steps 1-2 use mock data, amber badge shows | "The mock fallback kicked in — in production this would retry. Let me show you the flow with mock data." |
| Browser CORS error             | Same as above — mock fallback              | Same as above                                                                                            |
| Page is blank                  | Check dev server is running                | `npm run dev` in terminal                                                                                |
| sessionStorage has stale state | Old step data shows                        | Click "Start Over" or open incognito                                                                     |
| Dark mode looks wrong          | Toggle theme                               | Click the theme toggle or check system preferences                                                       |
