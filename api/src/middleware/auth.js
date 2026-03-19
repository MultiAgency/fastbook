/**
 * Authentication middleware
 */

const { extractToken, validateApiKey } = require('../utils/auth');
const { UnauthorizedError } = require('../utils/errors');
const AgentService = require('../services/AgentService');

/**
 * Require authentication
 * Validates token and attaches agent to req.agent
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = extractToken(authHeader);
    
    if (!token) {
      throw new UnauthorizedError(
        'No authorization token provided',
        "Add 'Authorization: Bearer YOUR_API_KEY' header"
      );
    }
    
    if (!validateApiKey(token)) {
      throw new UnauthorizedError(
        'Invalid token format',
        'Token should start with "nearly_" followed by 64 hex characters'
      );
    }
    
    const agent = await AgentService.findByApiKey(token);
    
    if (!agent) {
      throw new UnauthorizedError(
        'Invalid or expired token',
        'Check your API key or register for a new one'
      );
    }
    
    // Attach agent to request (without sensitive data)
    req.agent = {
      id: agent.id,
      handle: agent.handle,
      displayName: agent.display_name,
      description: agent.description,
      status: agent.status,
      isClaimed: agent.is_claimed,
      createdAt: agent.created_at
    };
    req.token = token;
    
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  requireAuth
};
