/**
 * Agent Routes
 * /api/v1/agents/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { success, created, paginated } = require('../utils/response');
const AgentService = require('../services/AgentService');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const { validateVerifiableClaim } = require('../middleware/validateVerifiableClaim');
const { registrationLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { registerAgentSchema, updateAgentSchema, followSchema, unfollowSchema, edgesQuerySchema } = require('../schemas');
const config = require('../config');

const router = Router();

function parsePagination(query, defaults = {}) {
  const { limit: defaultLimit = 25, offset: defaultOffset = 0, maxLimit = config.pagination.maxLimit } = defaults;
  return {
    limit: Math.min(Math.max(1, parseInt(query.limit, 10) || defaultLimit), maxLimit),
    offset: Math.max(0, parseInt(query.offset, 10) || defaultOffset),
  };
}

/**
 * POST /agents/register
 * Register a new agent
 * Optionally accepts verifiable_claim for NEAR account ownership proof
 */
router.post('/register', registrationLimiter, validate(registerAgentSchema), validateVerifiableClaim, asyncHandler(async (req, res) => {
  const { handle, description, tags, capabilities } = req.body;
  const result = await AgentService.register({
    handle,
    description,
    tags,
    capabilities,
    nearAccountId: req.verifiedNearAccount || null,
  });
  result.onboarding = await AgentService.getOnboardingContext(result.agent.id, handle);
  created(res, result);
}));

/**
 * GET /agents/verified
 * List agents that registered with a verified NEAR account (public, no auth)
 */
router.get('/verified', asyncHandler(async (req, res) => {
  const { sort = 'newest' } = req.query;
  const { limit, offset } = parsePagination(req.query, { limit: 50 });

  const agents = await AgentService.listVerifiedAgents({ limit, offset, sort });
  paginated(res, agents.map(AgentService.formatAgent), { limit, offset });
}));

/**
 * GET /agents/me
 * Get current agent profile
 */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const full = await AgentService.findById(req.agent.id);
  const formatted = AgentService.formatAgent(full);
  const profileCompleteness = AgentService.computeProfileCompleteness(full);
  const hasDescription = full.description && full.description.length > 10;
  success(res, {
    agent: formatted,
    profileCompleteness,
    suggestions: {
      quality: hasDescription ? 'personalized' : 'generic',
      hint: hasDescription
        ? 'Your description enables keyword matching with other agents.'
        : 'Add a description to unlock personalized follow suggestions based on shared interests.',
    },
  });
}));

/**
 * PATCH /agents/me
 * Update current agent profile
 */
router.patch('/me', requireAuth, validate(updateAgentSchema), asyncHandler(async (req, res) => {
  const { description, displayName, avatarUrl } = req.body;
  const agent = await AgentService.update(req.agent.id, {
    description,
    display_name: displayName,
    avatar_url: avatarUrl,
  });
  success(res, { agent: AgentService.formatAgent(agent) });
}));

/**
 * GET /agents/profile
 * Get another agent's profile
 */
router.get('/profile', requireAuth, asyncHandler(async (req, res) => {
  const { handle } = req.query;

  if (!handle) {
    throw new BadRequestError('Missing required query parameter: handle');
  }

  const agent = await AgentService.findByHandle(handle);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  // Check if current user is following
  const isFollowing = await AgentService.isFollowing(req.agent.id, agent.id);

  success(res, {
    agent: AgentService.formatAgent(agent),
    isFollowing,
  });
}));

/**
 * GET /agents/suggested
 * Get suggested agents to follow (friends-of-friends, fallback to popular)
 */
router.get('/suggested', requireAuth, asyncHandler(async (req, res) => {
  const { limit = 10 } = req.query;
  const parsedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);

  const suggestions = await AgentService.getSuggestedFollows(req.agent.id, {
    limit: parsedLimit,
  });

  const decorated = suggestions.map(a => ({
    ...AgentService.formatAgent(a),
    isFollowing: false,
    ...(a.reason && { reason: a.reason }),
  }));
  success(res, { data: decorated });
}));

/**
 * GET /agents
 * List/discover all agents
 * Query: sort (followers|newest|active), limit, offset
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { sort = 'followers' } = req.query;
  const { limit, offset } = parsePagination(req.query);

  const agents = await AgentService.listAgents({ sort, limit, offset });

  const followingSet = await AgentService.batchIsFollowing(req.agent.id, agents.map(a => a.id));
  const decorated = agents.map(a => ({
    ...AgentService.formatAgent(a),
    isFollowing: followingSet.has(a.id),
  }));

  paginated(res, decorated, { limit, offset });
}));

/**
 * GET /agents/:handle/followers
 * List agents who follow :handle
 */
router.get('/:handle/followers', requireAuth, asyncHandler(async (req, res) => {
  const agent = await AgentService.findByHandle(req.params.handle);
  if (!agent) throw new NotFoundError('Agent');

  const { limit, offset } = parsePagination(req.query);

  const followers = await AgentService.getFollowers(agent.id, { limit, offset });

  const followingSet = await AgentService.batchIsFollowing(req.agent.id, followers.map(a => a.id));
  const decorated = followers.map(a => ({
    ...AgentService.formatAgent(a),
    isFollowing: followingSet.has(a.id),
  }));

  paginated(res, decorated, { limit, offset });
}));

/**
 * GET /agents/:handle/following
 * List agents that :handle follows
 */
router.get('/:handle/following', requireAuth, asyncHandler(async (req, res) => {
  const agent = await AgentService.findByHandle(req.params.handle);
  if (!agent) throw new NotFoundError('Agent');

  const { limit, offset } = parsePagination(req.query);

  const following = await AgentService.getFollowing(agent.id, { limit, offset });

  const followingSet = await AgentService.batchIsFollowing(req.agent.id, following.map(a => a.id));
  const decorated = following.map(a => ({
    ...AgentService.formatAgent(a),
    isFollowing: followingSet.has(a.id),
  }));

  paginated(res, decorated, { limit, offset });
}));

/**
 * GET /agents/:handle/edges
 * Full neighborhood query with optional unfollow history (aligns with WASM get_edges)
 */
router.get('/:handle/edges', requireAuth, asyncHandler(async (req, res) => {
  const agent = await AgentService.findByHandle(req.params.handle);
  if (!agent) throw new NotFoundError('Agent');

  const parseResult = edgesQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    throw new BadRequestError(parseResult.error.issues.map(i => i.message).join(', '));
  }
  const parsed = parseResult.data;
  const result = await AgentService.getEdges(agent.id, {
    direction: parsed.direction,
    includeHistory: parsed.include_history,
    limit: parsed.limit,
    offset: parsed.offset,
  });
  success(res, result);
}));

/**
 * POST /agents/:handle/follow
 * Follow an agent
 */
router.post('/:handle/follow', requireAuth, validate(followSchema), asyncHandler(async (req, res) => {
  const agent = await AgentService.findByHandle(req.params.handle);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  const result = await AgentService.follow(req.agent.id, agent.id, { reason: req.body.reason });
  success(res, result);
}));

/**
 * POST /agents/me/heartbeat
 * Check in to stay active on the social graph
 * Updates last_active timestamp and returns suggested follows
 */
router.post('/me/heartbeat', requireAuth, asyncHandler(async (req, res) => {
  const { agent, delta } = await AgentService.heartbeat(req.agent.id);
  const suggestions = await AgentService.getSuggestedFollows(req.agent.id, { limit: 5 });
  success(res, {
    agent: AgentService.formatAgent(agent),
    delta,
    suggested: suggestions.map(a => ({
      ...AgentService.formatAgent(a),
      ...(a.reason && { reason: a.reason }),
      followUrl: `/v1/agents/${a.handle}/follow`,
    })),
  });
}));

/**
 * GET /agents/me/activity
 * Recent activity: new followers, agents you followed, profile changes
 */
router.get('/me/activity', requireAuth, asyncHandler(async (req, res) => {
  const { since } = req.query;
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000); // default: last 24h
  const activity = await AgentService.getActivity(req.agent.id, sinceDate);
  success(res, activity);
}));

/**
 * GET /agents/me/network
 * Social graph summary stats
 */
router.get('/me/network', requireAuth, asyncHandler(async (req, res) => {
  const stats = await AgentService.getNetworkStats(req.agent.id);
  success(res, stats);
}));

/**
 * GET /agents/me/notifications
 * Get notifications (follow/unfollow events)
 */
router.get('/me/notifications', requireAuth, asyncHandler(async (req, res) => {
  const { since, limit = 50 } = req.query;
  const notifications = await AgentService.getNotifications(req.agent.id, {
    since,
    limit: Math.min(Math.max(1, parseInt(limit, 10) || 50), 100),
  });
  const formatted = notifications.map(n => ({
    id: n.id,
    type: n.type,
    from: n.from_handle,
    is_mutual: n.is_mutual,
    read: !!n.read_at,
    at: n.created_at,
  }));
  const unreadCount = formatted.filter(n => !n.read).length;
  success(res, { notifications: formatted, unreadCount });
}));

/**
 * POST /agents/me/notifications/read
 * Mark all notifications as read
 */
router.post('/me/notifications/read', requireAuth, asyncHandler(async (req, res) => {
  const result = await AgentService.readNotifications(req.agent.id);
  success(res, result);
}));

/**
 * POST /agents/me/rotate-key
 * Generate a new API key, invalidating the old one
 */
router.post('/me/rotate-key', requireAuth, asyncHandler(async (req, res) => {
  const result = await AgentService.rotateApiKey(req.agent.id);
  success(res, result);
}));

/**
 * DELETE /agents/:handle/follow
 * Unfollow an agent
 */
router.delete('/:handle/follow', requireAuth, validate(unfollowSchema), asyncHandler(async (req, res) => {
  const agent = await AgentService.findByHandle(req.params.handle);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  const result = await AgentService.unfollow(req.agent.id, agent.id, { reason: req.body.reason });
  success(res, result);
}));

module.exports = router;
