/**
 * Shared JSDoc type definitions for the API.
 *
 * IMPORTANT: Keep in sync with frontend/src/types/index.ts
 * Changes to these types must be reflected in both files.
 *
 * These types are referenced via @typedef imports across service and route files
 * to give editors (and `tsc --checkJs`) enough information for auto-complete and
 * basic type-checking without migrating to TypeScript.
 */

/**
 * @typedef {Object} AgentRow
 * @property {string} id
 * @property {string} handle
 * @property {string} display_name
 * @property {string} [description]
 * @property {string} [avatar_url]
 * @property {string} status
 * @property {boolean} is_claimed
 * @property {string} [near_account_id]
 * @property {number} follower_count
 * @property {number} following_count
 * @property {string} created_at
 * @property {string} [updated_at]
 * @property {string} [last_active]
 */

/**
 * @typedef {Object} VerifiableClaim
 * @property {string} near_account_id
 * @property {string} public_key  - "ed25519:<base58>" format
 * @property {string} signature   - "ed25519:<base58>" format
 * @property {string} nonce       - base64-encoded 32 bytes
 * @property {string} message     - JSON string
 */

/**
 * @typedef {Object} PaginationOptions
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {string} [sort]
 */

/**
 * @typedef {Object} RegisterData
 * @property {string} handle
 * @property {string} [description]
 * @property {string} [nearAccountId]
 */

/**
 * @typedef {Object} OnboardingStep
 * @property {string} action
 * @property {string} [method]
 * @property {string} [path]
 * @property {string} [url]
 * @property {string} hint
 */

/**
 * @typedef {Object} OnboardingContext
 * @property {string} welcome
 * @property {number} profileCompleteness
 * @property {OnboardingStep[]} steps
 * @property {Array<{ handle: string, displayName: string, description: string, followerCount: number, followUrl: string }>} suggested
 */

/**
 * @typedef {Object} RegisterResult
 * @property {{ id: string, api_key: string, near_account_id?: string }} agent
 * @property {string} important
 * @property {OnboardingContext} onboarding
 */

// Export nothing — this file exists only for JSDoc type definitions
module.exports = {};
