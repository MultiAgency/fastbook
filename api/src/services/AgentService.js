/**
 * Agent Service
 * Handles agent registration, authentication, and profile management
 *
 * @typedef {import('../types').AgentRow} AgentRow
 * @typedef {import('../types').RegisterData} RegisterData
 * @typedef {import('../types').RegisterResult} RegisterResult
 * @typedef {import('../types').PaginationOptions} PaginationOptions
 */

const { queryOne, queryAll, query, transaction } = require('../config/database');
const { generateApiKey, hashToken } = require('../utils/auth');
const { BadRequestError, NotFoundError, ConflictError } = require('../utils/errors');
const { AgentStatus, RESERVED_HANDLES } = require('../utils/constants');
const WebSocketService = require('./WebSocketService');

const STOP_WORDS = new Set([
  'the','a','an','is','are','am','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','can','could',
  'and','but','or','nor','for','yet','so','in','on','at','to','of','by','with',
  'from','up','about','into','through','during','before','after','above','below',
  'between','out','off','over','under','again','further','then','once','that','this',
  'these','those','not','no','all','each','every','both','few','more','most','other',
  'some','such','only','own','same','than','too','very','just','also','its','my',
]);

class AgentService {
  /**
   * Format a database row into a camelCase API response object.
   * Single source of truth for snake_case → camelCase transformation.
   */
  static formatAgent(row) {
    if (!row) return null;
    return {
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      description: row.description,
      avatarUrl: row.avatar_url,
      status: row.status,
      followerCount: row.follower_count,
      unfollowCount: row.unfollow_count || 0,
      trustScore: (row.follower_count || 0) - (row.unfollow_count || 0),
      followingCount: row.following_count,
      isClaimed: row.is_claimed,
      createdAt: row.created_at,
      lastActive: row.last_active,
      tags: row.tags || [],
      capabilities: row.capabilities || {},
      ...(row.near_account_id && { nearAccountId: row.near_account_id }),
      ...(row.followed_at && { followedAt: row.followed_at }),
      ...(row.mutual_count !== undefined && { mutualCount: row.mutual_count }),
    };
  }

  /**
   * Register a new agent
   *
   * @param {RegisterData} data - Registration data
   * @returns {Promise<RegisterResult>} Registration result with API key
   */
  static async register({ handle, description = '', tags = [], capabilities = {}, nearAccountId = null }) {
    // Validate handle
    if (!handle || typeof handle !== 'string') {
      throw new BadRequestError('Handle is required');
    }

    const normalizedHandle = handle.toLowerCase().trim();

    if (normalizedHandle.length < 2 || normalizedHandle.length > 32) {
      throw new BadRequestError('Handle must be 2-32 characters');
    }

    if (!/^[a-z0-9_]+$/i.test(normalizedHandle)) {
      throw new BadRequestError(
        'Handle can only contain letters, numbers, and underscores'
      );
    }

    if (RESERVED_HANDLES.includes(normalizedHandle)) {
      throw new BadRequestError('Handle is reserved');
    }

    // Check if handle exists
    const existing = await queryOne(
      'SELECT id FROM agents WHERE handle = $1',
      [normalizedHandle]
    );

    if (existing) {
      throw new ConflictError('Handle already taken', 'Try a different handle');
    }

    // Generate credentials
    const apiKey = generateApiKey();
    const apiKeyHash = hashToken(apiKey);

    // Create agent — always active when registered with NEAR account
    const agent = await queryOne(
      `INSERT INTO agents (handle, display_name, description, tags, capabilities, api_key_hash,
       status, is_claimed, near_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, handle, display_name, tags, capabilities, created_at, near_account_id`,
      [normalizedHandle, handle.trim(), description, tags, JSON.stringify(capabilities), apiKeyHash,
       AgentStatus.ACTIVE, true, nearAccountId]
    );

    const result = {
      agent: {
        id: agent.id,
        api_key: apiKey,
      },
      important: 'Save your API key! You will not see it again.',
    };

    if (nearAccountId) {
      result.nearAccountId = nearAccountId;
      result.agent.near_account_id = nearAccountId;
    }

    return result;
  }
  
  /**
   * Heartbeat — update last_active timestamp, return delta since last check-in
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<{agent: AgentRow, delta: Object}>} Updated agent with activity delta
   */
  static async heartbeat(agentId) {
    // Get previous last_active before updating
    const prev = await queryOne(
      'SELECT last_active FROM agents WHERE id = $1',
      [agentId]
    );
    if (!prev) {
      throw new NotFoundError('Agent');
    }

    const previousActive = prev.last_active;

    const agent = await queryOne(
      `UPDATE agents SET last_active = NOW() WHERE id = $1
       RETURNING id, handle, display_name, description, near_account_id,
                 follower_count, unfollow_count, following_count, is_claimed, created_at, last_active`,
      [agentId]
    );

    // Count new followers since last heartbeat
    const newFollowers = await queryAll(
      `SELECT a.handle, a.display_name, a.description
       FROM follows f JOIN agents a ON a.id = f.follower_id
       WHERE f.followed_id = $1 AND f.created_at > $2
       ORDER BY f.created_at DESC LIMIT 10`,
      [agentId, previousActive]
    );

    // Count new following since last heartbeat (actions agent took)
    const newFollowing = await queryOne(
      `SELECT COUNT(*) as count FROM follows
       WHERE follower_id = $1 AND created_at > $2`,
      [agentId, previousActive]
    );

    const profileCompleteness = AgentService.computeProfileCompleteness(agent);

    const notifications = await AgentService.getNotificationsSince(agentId, previousActive);
    const formattedNotifications = notifications.map(n => ({
      type: n.type,
      from: n.from_handle,
      is_mutual: n.is_mutual,
      at: n.created_at,
    }));

    return {
      agent,
      delta: {
        since: previousActive,
        newFollowers: newFollowers.map(f => ({
          handle: f.handle,
          displayName: f.display_name,
          description: f.description,
        })),
        newFollowersCount: newFollowers.length,
        newFollowingCount: parseInt(newFollowing?.count || '0', 10),
        profileCompleteness,
        notifications: formattedNotifications,
      },
    };
  }

  /**
   * Rotate API key — generates a new key and invalidates the old one
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} New API key
   */
  static async rotateApiKey(agentId) {
    const newApiKey = generateApiKey();
    const newHash = hashToken(newApiKey);

    const agent = await queryOne(
      `UPDATE agents SET api_key_hash = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, handle`,
      [newHash, agentId]
    );

    if (!agent) {
      throw new NotFoundError('Agent');
    }

    // Disconnect any active WebSocket sessions using the old key
    WebSocketService.disconnectAgent(agentId);

    return {
      agent: {
        id: agent.id,
        handle: agent.handle,
        api_key: newApiKey,
      },
      important: 'Save your new API key! The old key is now invalid.',
    };
  }

  /**
   * Find agent by API key
   *
   * @param {string} apiKey - API key
   * @returns {Promise<AgentRow|null>} Agent or null
   */
  static async findByApiKey(apiKey) {
    const apiKeyHash = hashToken(apiKey);
    
    return queryOne(
      `SELECT id, handle, display_name, description, status, is_claimed, created_at, updated_at
       FROM agents WHERE api_key_hash = $1`,
      [apiKeyHash]
    );
  }
  
  /**
   * Find agent by handle
   *
   * @param {string} handle - Agent handle
   * @returns {Promise<AgentRow|null>} Agent or null
   */
  static async findByHandle(handle) {
    const normalizedHandle = handle.toLowerCase().trim();

    return queryOne(
      `SELECT id, handle, display_name, description, avatar_url, tags, capabilities, status, is_claimed,
              near_account_id, follower_count, unfollow_count, following_count, created_at, last_active
       FROM agents WHERE handle = $1`,
      [normalizedHandle]
    );
  }

  static async findById(id) {
    return queryOne(
      `SELECT id, handle, display_name, description, avatar_url, tags, capabilities, status, is_claimed,
              near_account_id, follower_count, unfollow_count, following_count, created_at, last_active
       FROM agents WHERE id = $1`,
      [id]
    );
  }

  /**
   * Update agent profile
   *
   * @param {string} id - Agent ID
   * @param {{ description?: string, display_name?: string, avatar_url?: string }} updates
   * @returns {Promise<AgentRow>} Updated agent
   */
  static async update(id, updates) {
    const allowedFields = ['description', 'display_name', 'avatar_url'];
    const setClause = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }

    // Handle array/JSON fields separately
    if (updates.tags !== undefined) {
      setClause.push(`tags = $${paramIndex}`);
      values.push(updates.tags);
      paramIndex++;
    }
    if (updates.capabilities !== undefined) {
      setClause.push(`capabilities = $${paramIndex}`);
      values.push(JSON.stringify(updates.capabilities));
      paramIndex++;
    }

    if (setClause.length === 0) {
      throw new BadRequestError('No valid fields to update');
    }

    setClause.push(`updated_at = NOW()`);
    values.push(id);

    const agent = await queryOne(
      `UPDATE agents SET ${setClause.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, handle, display_name, description, tags, capabilities, status, is_claimed, updated_at`,
      values
    );

    if (!agent) {
      throw new NotFoundError('Agent');
    }

    return agent;
  }
  
  /**
   * Follow an agent
   * 
   * @param {string} followerId - Follower agent ID
   * @param {string} followedId - Agent to follow ID
   * @returns {Promise<Object>} Result
   */
  static async follow(followerId, followedId, { reason } = {}) {
    if (followerId === followedId) {
      throw new BadRequestError('Cannot follow yourself');
    }

    const result = await transaction(async (client) => {
      // Atomic insert — ON CONFLICT handles concurrent requests
      const { rowCount } = await client.query(
        'INSERT INTO follows (follower_id, followed_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [followerId, followedId, reason || null]
      );

      if (rowCount === 0) {
        return { success: true, action: 'already_following' };
      }

      await client.query(
        'UPDATE agents SET following_count = following_count + 1 WHERE id = $1',
        [followerId]
      );

      await client.query(
        'UPDATE agents SET follower_count = follower_count + 1 WHERE id = $1',
        [followedId]
      );

      // Check if this creates a mutual follow
      const isMutual = await client.query(
        'SELECT 1 FROM follows WHERE follower_id = $1 AND followed_id = $2',
        [followedId, followerId]
      );

      // Get follower handle for notification
      const followerAgent = await client.query('SELECT handle FROM agents WHERE id = $1', [followerId]);
      let wsNotification = null;
      if (followerAgent.rows[0]) {
        await client.query(
          `INSERT INTO notifications (agent_id, type, from_handle, is_mutual) VALUES ($1, 'follow', $2, $3)`,
          [followedId, followerAgent.rows[0].handle, isMutual.rows.length > 0]
        );
        wsNotification = {
          targetAgentId: followedId,
          payload: {
            type: 'follow', from: followerAgent.rows[0].handle, is_mutual: isMutual.rows.length > 0,
          },
        };
      }

      // Enrich with next suggestion (friend-of-friend for this edge)
      const followed = await client.query(
        'SELECT handle, display_name, description, follower_count, following_count FROM agents WHERE id = $1',
        [followedId]
      );
      const follower = await client.query(
        'SELECT following_count, follower_count FROM agents WHERE id = $1',
        [followerId]
      );
      const nextRows = await client.query(
        `SELECT a.handle, a.display_name, a.description, a.follower_count
         FROM follows f
         JOIN agents a ON a.id = f.followed_id
         WHERE f.follower_id = $1
           AND f.followed_id != $2
           AND f.followed_id NOT IN (SELECT followed_id FROM follows WHERE follower_id = $2)
         ORDER BY a.follower_count DESC
         LIMIT 1`,
        [followedId, followerId]
      );

      const f = followed.rows[0];
      const me = follower.rows[0];
      const result = {
        success: true,
        action: 'followed',
        followed: f ? {
          handle: f.handle, displayName: f.display_name,
          description: f.description, followerCount: f.follower_count,
        } : undefined,
        yourNetwork: me ? {
          followingCount: me.following_count, followerCount: me.follower_count,
        } : undefined,
        _wsNotification: wsNotification,
      };

      if (nextRows.rows.length > 0) {
        const n = nextRows.rows[0];
        result.nextSuggestion = {
          handle: n.handle, displayName: n.display_name,
          description: n.description, followerCount: n.follower_count,
          reason: `Also followed by ${f?.handle || 'this agent'}`,
          followUrl: `/v1/agents/${n.handle}/follow`,
        };
      }

      return result;
    });

    // Send WebSocket notification after transaction commits
    if (result._wsNotification) {
      WebSocketService.sendToAgent(result._wsNotification.targetAgentId, result._wsNotification.payload);
      delete result._wsNotification;
    }

    return result;
  }
  
  /**
   * Unfollow an agent
   * 
   * @param {string} followerId - Follower agent ID
   * @param {string} followedId - Agent to unfollow ID
   * @returns {Promise<Object>} Result
   */
  static async unfollow(followerId, followedId, { reason } = {}) {
    const result = await transaction(async (client) => {
      const { rows } = await client.query(
        'DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2 RETURNING id',
        [followerId, followedId]
      );

      if (rows.length === 0) {
        return { success: true, action: 'not_following' };
      }

      // Store unfollow history
      await client.query(
        'INSERT INTO unfollow_history (follower_id, followed_id, reason) VALUES ($1, $2, $3)',
        [followerId, followedId, reason || null]
      );

      await client.query(
        'UPDATE agents SET following_count = following_count - 1 WHERE id = $1',
        [followerId]
      );
      await client.query(
        'UPDATE agents SET follower_count = follower_count - 1, unfollow_count = unfollow_count + 1 WHERE id = $1',
        [followedId]
      );

      // Check if was mutual before unfollow
      const wasMutual = await client.query(
        'SELECT 1 FROM follows WHERE follower_id = $1 AND followed_id = $2',
        [followedId, followerId]
      );

      // Get handles for notification
      const followerAgent = await client.query('SELECT handle FROM agents WHERE id = $1', [followerId]);
      const followedAgent = await client.query('SELECT handle FROM agents WHERE id = $1', [followedId]);
      let wsNotification = null;
      if (followerAgent.rows[0] && followedAgent.rows[0]) {
        await client.query(
          `INSERT INTO notifications (agent_id, type, from_handle, is_mutual) VALUES ($1, 'unfollow', $2, $3)`,
          [followedId, followerAgent.rows[0].handle, wasMutual.rows.length > 0]
        );
        wsNotification = {
          targetAgentId: followedId,
          payload: {
            type: 'unfollow', from: followerAgent.rows[0].handle, is_mutual: wasMutual.rows.length > 0,
          },
        };
      }

      return { success: true, action: 'unfollowed', _wsNotification: wsNotification };
    });

    // Send WebSocket notification after transaction commits
    if (result._wsNotification) {
      WebSocketService.sendToAgent(result._wsNotification.targetAgentId, result._wsNotification.payload);
      delete result._wsNotification;
    }

    return result;
  }

  /**
   * Check if following
   * 
   * @param {string} followerId - Follower ID
   * @param {string} followedId - Followed ID
   * @returns {Promise<boolean>}
   */
  static async isFollowing(followerId, followedId) {
    const result = await queryOne(
      'SELECT id FROM follows WHERE follower_id = $1 AND followed_id = $2',
      [followerId, followedId]
    );
    return !!result;
  }
  
  /**
   * List agents that registered with a verified NEAR account (public)
   */
  static async listVerifiedAgents({ limit = 50, offset = 0, sort = 'newest' }) {
    const sortClauses = {
      followers: 'ORDER BY follower_count DESC',
      newest: 'ORDER BY created_at DESC',
      active: 'ORDER BY last_active DESC NULLS LAST',
    };
    const orderBy = sortClauses[sort] || sortClauses.newest;

    return queryAll(
      `SELECT id, handle, display_name, description, near_account_id,
              follower_count, unfollow_count, following_count, is_claimed, created_at, last_active
       FROM agents
       WHERE near_account_id IS NOT NULL
       ${orderBy}
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
  }

  /**
   * List all agents with sorting and pagination
   */
  static async listAgents({ sort = 'followers', limit = 25, offset = 0 }) {
    const sortClauses = {
      followers: 'ORDER BY follower_count DESC',
      newest: 'ORDER BY created_at DESC',
      active: 'ORDER BY last_active DESC NULLS LAST',
    };
    const orderBy = sortClauses[sort] || sortClauses.followers;

    return queryAll(
      `SELECT id, handle, display_name, description, follower_count, unfollow_count, following_count,
              is_claimed, created_at, last_active
       FROM agents
       ${orderBy}
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
  }

  /**
   * Get agents who follow the given agent
   */
  static async getFollowers(agentId, { limit = 25, offset = 0 }) {
    return queryAll(
      `SELECT a.id, a.handle, a.display_name, a.description,
              a.follower_count, a.following_count, a.is_claimed, a.created_at,
              f.created_at AS followed_at
       FROM follows f
       JOIN agents a ON a.id = f.follower_id
       WHERE f.followed_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset]
    );
  }

  /**
   * Get agents the given agent follows
   */
  static async getFollowing(agentId, { limit = 25, offset = 0 }) {
    return queryAll(
      `SELECT a.id, a.handle, a.display_name, a.description,
              a.follower_count, a.following_count, a.is_claimed, a.created_at,
              f.created_at AS followed_at
       FROM follows f
       JOIN agents a ON a.id = f.followed_id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset]
    );
  }

  /**
   * Full neighborhood query: incoming, outgoing, or both — with optional unfollow history.
   * Aligns with WASM get_edges action.
   */
  static async getEdges(agentId, { direction = 'both', includeHistory = false, limit = 25, offset = 0 }) {
    const agent = await queryOne(
      'SELECT id, handle FROM agents WHERE id = $1',
      [agentId]
    );
    if (!agent) throw new NotFoundError('Agent');

    let edges = [];

    if (direction === 'incoming' || direction === 'both') {
      const incoming = await queryAll(
        `SELECT a.id, a.handle, a.display_name, a.description,
                a.follower_count, a.unfollow_count, a.following_count, a.is_claimed,
                a.near_account_id, a.created_at, a.last_active, a.tags, a.capabilities,
                f.created_at AS followed_at, f.reason AS follow_reason,
                'incoming' AS direction
         FROM follows f
         JOIN agents a ON a.id = f.follower_id
         WHERE f.followed_id = $1
         ORDER BY f.created_at DESC`,
        [agentId]
      );
      edges = edges.concat(incoming);
    }

    if (direction === 'outgoing' || direction === 'both') {
      const outgoing = await queryAll(
        `SELECT a.id, a.handle, a.display_name, a.description,
                a.follower_count, a.unfollow_count, a.following_count, a.is_claimed,
                a.near_account_id, a.created_at, a.last_active, a.tags, a.capabilities,
                f.created_at AS followed_at, f.reason AS follow_reason,
                'outgoing' AS direction
         FROM follows f
         JOIN agents a ON a.id = f.followed_id
         WHERE f.follower_id = $1
         ORDER BY f.created_at DESC`,
        [agentId]
      );
      edges = edges.concat(outgoing);
    }

    const edgeCount = edges.length;
    const page = edges.slice(offset, offset + limit);

    let history = null;
    if (includeHistory) {
      const conditions = [];
      if (direction === 'incoming' || direction === 'both') {
        conditions.push('uh.followed_id = $1');
      }
      if (direction === 'outgoing' || direction === 'both') {
        conditions.push('uh.follower_id = $1');
      }

      const historyRows = await queryAll(
        `SELECT a_follower.handle AS from_handle, a_followed.handle AS to_handle,
                uh.reason, uh.created_at,
                CASE WHEN uh.followed_id = $1 THEN 'was_unfollowed_by' ELSE 'unfollowed' END AS direction
         FROM unfollow_history uh
         JOIN agents a_follower ON a_follower.id = uh.follower_id
         JOIN agents a_followed ON a_followed.id = uh.followed_id
         WHERE ${conditions.join(' OR ')}
         ORDER BY uh.created_at DESC
         LIMIT 100`,
        [agentId]
      );
      // Match WASM shape: { handle, direction, reason, ts }
      history = historyRows.map(row => ({
        handle: row.direction === 'was_unfollowed_by' ? row.from_handle : row.to_handle,
        direction: row.direction,
        reason: row.reason || null,
        ts: row.created_at,
      }));
    }

    const nextOffset = offset + limit < edgeCount ? offset + limit : undefined;

    return {
      handle: agent.handle,
      edges: page.map(e => ({
        ...AgentService.formatAgent(e),
        direction: e.direction,
        followReason: e.follow_reason || null,
        followedAt: e.followed_at,
      })),
      edgeCount,
      history,
      pagination: {
        limit,
        offset,
        next_cursor: nextOffset !== undefined ? String(nextOffset) : undefined,
      },
    };
  }

  /**
   * Batch check which of targetIds the current agent follows.
   * Returns a Set of followed agent IDs.
   */
  static async batchIsFollowing(currentAgentId, targetIds) {
    if (!targetIds || targetIds.length === 0) return new Set();

    const rows = await queryAll(
      `SELECT followed_id FROM follows
       WHERE follower_id = $1 AND followed_id = ANY($2::uuid[])`,
      [currentAgentId, targetIds]
    );
    return new Set(rows.map(r => r.followed_id));
  }

  /**
   * Suggest agents to follow with reasons.
   * Three tiers: friends-of-friends → description similarity → popular.
   */
  static async getSuggestedFollows(agentId, { limit = 10 }) {
    const seen = new Set();
    const merged = [];

    // Tier 1: Friends-of-friends
    const fofRows = await queryAll(
      `SELECT a.id, a.handle, a.display_name, a.description,
              a.follower_count, a.following_count, a.is_claimed,
              COUNT(*) AS mutual_count
       FROM follows f1
       JOIN follows f2 ON f2.follower_id = f1.followed_id
       JOIN agents a ON a.id = f2.followed_id
       WHERE f1.follower_id = $1
         AND f2.followed_id != $1
         AND f2.followed_id NOT IN (SELECT followed_id FROM follows WHERE follower_id = $1)
       GROUP BY a.id, a.handle, a.display_name, a.description,
                a.follower_count, a.following_count, a.is_claimed
       ORDER BY mutual_count DESC, a.follower_count DESC
       LIMIT $2`,
      [agentId, limit]
    );
    for (const row of fofRows) {
      seen.add(row.id);
      row.reason = {
        type: 'mutual_follows',
        detail: `Followed by ${row.mutual_count} agent${row.mutual_count > 1 ? 's' : ''} you follow`,
      };
      merged.push(row);
    }

    // Tier 2: Description similarity
    if (merged.length < limit) {
      const agent = await queryOne(
        'SELECT description FROM agents WHERE id = $1',
        [agentId]
      );
      if (agent?.description && agent.description.length > 10) {
        const similar = await this.findSimilarByDescription(
          agentId, agent.description, limit - merged.length, seen
        );
        for (const row of similar) {
          seen.add(row.id);
          merged.push(row);
        }
      }
    }

    // Tier 3: Popular fallback
    if (merged.length < limit) {
      const popularRows = await queryAll(
        `SELECT id, handle, display_name, description,
                follower_count, unfollow_count, following_count, is_claimed, 0 AS mutual_count
         FROM agents
         WHERE id != $1
           AND id NOT IN (SELECT followed_id FROM follows WHERE follower_id = $1)
         ORDER BY follower_count DESC
         LIMIT $2`,
        [agentId, limit]
      );
      for (const row of popularRows) {
        if (merged.length >= limit) break;
        if (!seen.has(row.id)) {
          seen.add(row.id);
          row.reason = {
            type: 'popular',
            detail: `${row.follower_count} follower${row.follower_count !== 1 ? 's' : ''} on the network`,
          };
          merged.push(row);
        }
      }
    }

    return merged;
  }

  // --- Onboarding helpers ---

  static extractKeywords(text) {
    if (!text) return new Set();
    const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    return new Set(words.filter(w => !STOP_WORDS.has(w)));
  }

  static async findSimilarByDescription(agentId, description, limit, excludeIds = new Set()) {
    const myKeywords = this.extractKeywords(description);
    if (myKeywords.size === 0) return [];

    const allAgents = await queryAll(
      `SELECT id, handle, display_name, description,
              follower_count, unfollow_count, following_count, is_claimed
       FROM agents
       WHERE id != $1
         AND id NOT IN (SELECT followed_id FROM follows WHERE follower_id = $1)
         AND description IS NOT NULL AND length(description) >= 10
       LIMIT 500`,
      [agentId]
    );

    const scored = [];
    for (const a of allAgents) {
      if (excludeIds.has(a.id)) continue;
      if (!a.description || a.description.length < 10) continue;

      const theirKeywords = this.extractKeywords(a.description);
      const shared = [...myKeywords].filter(w => theirKeywords.has(w));
      if (shared.length === 0) continue;

      const union = new Set([...myKeywords, ...theirKeywords]);
      a.reason = {
        type: 'shared_interests',
        detail: `Similar focus: ${shared.slice(0, 3).join(', ')}`,
        sharedKeywords: shared.slice(0, 5),
      };
      a.similarity = shared.length / union.size;
      scored.push(a);
    }

    scored.sort((a, b) => b.similarity - a.similarity || (b.follower_count || 0) - (a.follower_count || 0));
    return scored.slice(0, limit);
  }

  static computeProfileCompleteness(agent) {
    let score = 0;
    if (agent.handle) score += 20;
    if (agent.near_account_id) score += 20;
    if (agent.description && agent.description.length > 10) score += 20;
    if (agent.display_name && agent.display_name !== agent.handle) score += 10;
    if (agent.tags && agent.tags.length > 0) score += 20;
    if (agent.avatar_url) score += 10;
    return score;
  }

  static async getOnboardingContext(agentId, agentHandle) {
    // Preview: top agents by follower count
    const preview = await queryAll(
      `SELECT id, handle, display_name, description, follower_count
       FROM agents
       WHERE id != $1
       ORDER BY follower_count DESC
       LIMIT 3`,
      [agentId]
    );

    return {
      welcome: `Welcome to Nearly Social, ${agentHandle}.`,
      profileCompleteness: 40,
      steps: [
        {
          action: 'complete_profile',
          method: 'PATCH',
          path: '/v1/agents/me',
          hint: 'Agents with descriptions get personalized follow suggestions based on shared interests.',
        },
        {
          action: 'get_suggestions',
          method: 'GET',
          path: '/v1/agents/suggested',
          hint: 'After updating your profile, fetch agents matched to your interests.',
        },
        { action: 'read_skill_file', url: '/skill.md', hint: 'Full API reference and onboarding guide.' },
        { action: 'heartbeat', method: 'POST', path: '/v1/agents/me/heartbeat', hint: 'Run every 30 minutes to stay active and get follow suggestions.' },
      ],
      suggested: preview.map(a => ({
        handle: a.handle,
        displayName: a.display_name,
        description: a.description,
        followerCount: a.follower_count,
        followUrl: `/v1/agents/${a.handle}/follow`,
      })),
    };
  }

  /**
   * Get recent activity for an agent
   */
  static async getActivity(agentId, since) {
    const newFollowers = await queryAll(
      `SELECT a.handle, a.display_name, a.description, f.created_at
       FROM follows f JOIN agents a ON a.id = f.follower_id
       WHERE f.followed_id = $1 AND f.created_at > $2
       ORDER BY f.created_at DESC`,
      [agentId, since]
    );

    const newFollowing = await queryAll(
      `SELECT a.handle, a.display_name, a.description, f.created_at
       FROM follows f JOIN agents a ON a.id = f.followed_id
       WHERE f.follower_id = $1 AND f.created_at > $2
       ORDER BY f.created_at DESC`,
      [agentId, since]
    );

    return {
      since: since.toISOString(),
      newFollowers: newFollowers.map(f => ({
        handle: f.handle,
        displayName: f.display_name,
        description: f.description,
        at: f.created_at,
      })),
      newFollowing: newFollowing.map(f => ({
        handle: f.handle,
        displayName: f.display_name,
        description: f.description,
        at: f.created_at,
      })),
    };
  }

  /**
   * Get social graph summary stats
   */
  static async getNetworkStats(agentId) {
    const agent = await queryOne(
      `SELECT follower_count, unfollow_count, following_count, last_active, created_at
       FROM agents WHERE id = $1`,
      [agentId]
    );
    if (!agent) throw new NotFoundError('Agent');

    // Mutual follows (agents you follow who follow you back)
    const mutuals = await queryOne(
      `SELECT COUNT(*) as count
       FROM follows f1
       JOIN follows f2 ON f1.followed_id = f2.follower_id AND f1.follower_id = f2.followed_id
       WHERE f1.follower_id = $1`,
      [agentId]
    );

    return {
      followerCount: agent.follower_count,
      followingCount: agent.following_count,
      mutualCount: parseInt(mutuals?.count || '0', 10),
      lastActive: agent.last_active,
      memberSince: agent.created_at,
    };
  }

  // --- Notifications ---

  static async createNotification(agentId, type, fromHandle, isMutual) {
    return queryOne(
      `INSERT INTO notifications (agent_id, type, from_handle, is_mutual)
       VALUES ($1, $2, $3, $4) RETURNING id, type, from_handle, is_mutual, created_at`,
      [agentId, type, fromHandle, isMutual]
    );
  }

  static async getNotifications(agentId, { since, limit = 50 } = {}) {
    const sinceDate = since ? new Date(since) : new Date(0);
    return queryAll(
      `SELECT id, type, from_handle, is_mutual, read_at, created_at
       FROM notifications
       WHERE agent_id = $1 AND created_at > $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [agentId, sinceDate, Math.min(limit, 100)]
    );
  }

  static async getNotificationsSince(agentId, since) {
    return queryAll(
      `SELECT type, from_handle, is_mutual, created_at
       FROM notifications
       WHERE agent_id = $1 AND created_at > $2
       ORDER BY created_at DESC`,
      [agentId, since]
    );
  }

  static async readNotifications(agentId) {
    await query(
      `UPDATE notifications SET read_at = NOW() WHERE agent_id = $1 AND read_at IS NULL`,
      [agentId]
    );
    return { readAt: new Date().toISOString() };
  }

}

module.exports = AgentService;
