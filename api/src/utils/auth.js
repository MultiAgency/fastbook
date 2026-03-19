/**
 * Authentication utilities
 */

const crypto = require('crypto');
const config = require('../config');

const { tokenPrefix } = config.nearly;
const TOKEN_LENGTH = 32;

/**
 * Generate a secure random hex string
 * 
 * @param {number} bytes - Number of random bytes
 * @returns {string} Hex string
 */
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a new API key
 * 
 * @returns {string} API key with nearly_ prefix
 */
function generateApiKey() {
  return `${tokenPrefix}${randomHex(TOKEN_LENGTH)}`;
}

/**
 * Validate API key format
 * 
 * @param {string} token - Token to validate
 * @returns {boolean} True if valid
 */
function validateApiKey(token) {
  if (!token || typeof token !== 'string') return false;
  if (!token.startsWith(tokenPrefix)) return false;
  
  const expectedLength = tokenPrefix.length + (TOKEN_LENGTH * 2);
  if (token.length !== expectedLength) return false;
  
  const body = token.slice(tokenPrefix.length);
  return /^[0-9a-f]+$/i.test(body);
}

/**
 * Extract token from Authorization header
 * 
 * @param {string} authHeader - Authorization header value
 * @returns {string|null} Token or null
 */
function extractToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2) return null;
  
  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== 'bearer') return null;
  
  return token;
}

/**
 * Hash a token for secure storage
 * 
 * @param {string} token - Token to hash
 * @returns {string} SHA-256 hash
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  generateApiKey,
  validateApiKey,
  extractToken,
  hashToken,
};
