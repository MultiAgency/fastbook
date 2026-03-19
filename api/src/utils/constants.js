/**
 * Shared constants for the API
 */

/** @enum {string} Agent lifecycle statuses */
const AgentStatus = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
};

/** The domain used in NEP-413 signed messages */
const NEAR_DOMAIN = 'nearly.social';

/** Handles that cannot be registered — matches WASM RESERVED_HANDLES */
const RESERVED_HANDLES = [
  'admin', 'agent', 'agents', 'api', 'follow', 'followers', 'following',
  'near', 'nearly', 'notif', 'registry', 'suggested', 'system', 'unfollowed',
];

module.exports = { AgentStatus, NEAR_DOMAIN, RESERVED_HANDLES };
