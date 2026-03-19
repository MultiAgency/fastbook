/**
 * Database connection and query helpers
 */

const crypto = require('crypto');
const { Pool } = require('pg');
const config = require('./index');

let pool = null;

// In-memory store for development without PostgreSQL
const memoryStore = {
  agents: [],
  follows: [],
  used_nonces: [],

  query(text, params) {
    const normalized = text.replace(/\s+/g, ' ').trim().toUpperCase();

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith('INSERT INTO AGENTS'))   return this._handleAgentInsert(text, params);
    if (normalized.includes('UPDATE AGENTS'))           return this._handleAgentUpdate(normalized, text, params);
    if (normalized.includes('FROM AGENTS'))             return this._handleAgentSelect(normalized, params);
    if (normalized.startsWith('INSERT INTO FOLLOWS'))   return this._handleFollowInsert(params);
    if (normalized.includes('DELETE FROM FOLLOWS'))     return this._handleFollowDelete(normalized, params);
    if (normalized.includes('FROM FOLLOWS'))            return this._handleFollowSelect(normalized, params);
    if (normalized.includes('FROM USED_NONCES') || normalized.startsWith('INSERT INTO USED_NONCES') || normalized.includes('DELETE FROM USED_NONCES'))
      return this._handleNonce(normalized, params);

    console.warn('In-memory store: unrecognized query pattern:', text.substring(0, 80));
    return { rows: [], rowCount: 0 };
  },

  _handleAgentInsert(text, params) {
    const id = crypto.randomUUID();
    const agent = { id, follower_count: 0, following_count: 0 };
    const colMatch = text.match(/\(([^)]+)\)\s*VALUES/i);
    if (colMatch) {
      const cols = colMatch[1].split(',').map(c => c.trim());
      cols.forEach((col, i) => { agent[col] = params[i]; });
    }
    agent.created_at = new Date().toISOString();
    agent.last_active = agent.created_at;
    this.agents.push(agent);
    return { rows: [agent], rowCount: 1 };
  },

  _handleAgentUpdate(normalized, text, params) {
    if (!normalized.includes('WHERE ID =')) return { rows: [], rowCount: 0 };
    const whereMatch = text.match(/WHERE\s+id\s*=\s*\$(\d+)/i);
    const idParamIndex = whereMatch ? parseInt(whereMatch[1], 10) - 1 : params.length - 1;
    const id = params[idParamIndex];
    const agent = this.agents.find(a => a.id === id);
    if (!agent) return { rows: [], rowCount: 0 };

    if (normalized.includes('FOLLOWER_COUNT = FOLLOWER_COUNT +'))       agent.follower_count = (agent.follower_count || 0) + 1;
    else if (normalized.includes('FOLLOWER_COUNT = FOLLOWER_COUNT -'))  agent.follower_count = Math.max(0, (agent.follower_count || 0) - 1);
    else if (normalized.includes('FOLLOWING_COUNT = FOLLOWING_COUNT +')) agent.following_count = (agent.following_count || 0) + 1;
    else if (normalized.includes('FOLLOWING_COUNT = FOLLOWING_COUNT -')) agent.following_count = Math.max(0, (agent.following_count || 0) - 1);
    else {
      // Generic SET field = $N support (e.g. api_key_hash, last_active, description)
      const setMatches = [...text.matchAll(/(\w+)\s*=\s*\$(\d+)/gi)];
      for (const m of setMatches) {
        const col = m[1].toLowerCase();
        if (col === 'id') continue; // skip WHERE id = $N
        const paramIdx = parseInt(m[2], 10) - 1;
        agent[col] = params[paramIdx];
      }
    }

    agent.updated_at = new Date().toISOString();
    return { rows: [agent], rowCount: 1 };
  },

  _handleAgentSelect(normalized, params) {
    // Verified agents
    if (normalized.includes('NEAR_ACCOUNT_ID IS NOT NULL')) {
      const verified = this.agents.filter(a => a.near_account_id != null);
      verified.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const limit = parseInt(params[0], 10) || 50;
      const offset = parseInt(params[1], 10) || 0;
      const sliced = verified.slice(offset, offset + limit);
      return { rows: sliced, rowCount: sliced.length };
    }

    // Unfiltered listing with ORDER BY
    if (normalized.includes('ORDER BY') && !normalized.includes('WHERE')) {
      let sorted = [...this.agents];
      if (normalized.includes('ORDER BY FOLLOWER_COUNT'))   sorted.sort((a, b) => (b.follower_count || 0) - (a.follower_count || 0));
      else if (normalized.includes('ORDER BY CREATED_AT'))  sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      else if (normalized.includes('ORDER BY LAST_ACTIVE')) sorted.sort((a, b) => new Date(b.last_active || 0) - new Date(a.last_active || 0));
      const limit = parseInt(params[0], 10) || 25;
      const offset = parseInt(params[1], 10) || 0;
      const sliced = sorted.slice(offset, offset + limit);
      return { rows: sliced, rowCount: sliced.length };
    }

    // Popular agents fallback (for suggested follows)
    if (normalized.includes('WHERE ID !=') && normalized.includes('ORDER BY FOLLOWER_COUNT')) {
      const agentId = params[0];
      const limit = parseInt(params[1], 10) || 10;
      const myFollowedIds = new Set(this.follows.filter(f => f.follower_id === agentId).map(f => f.followed_id));
      const candidates = this.agents
        .filter(a => a.id !== agentId && !myFollowedIds.has(a.id))
        .sort((a, b) => (b.follower_count || 0) - (a.follower_count || 0))
        .slice(0, limit)
        .map(a => ({ ...a, mutual_count: 0 }));
      return { rows: candidates, rowCount: candidates.length };
    }

    // Lookup by specific field
    if (normalized.includes('WHERE ID ='))               return this._findAgent(a => a.id === params[0]);
    if (normalized.includes('WHERE HANDLE'))              return this._findAgent(a => a.handle === params[0]);
    if (normalized.includes('WHERE NEAR_ACCOUNT_ID'))     return this._findAgent(a => a.near_account_id === params[0]);
    if (normalized.includes('WHERE API_KEY_HASH'))        return this._findAgent(a => a.api_key_hash === params[0]);

    return { rows: [], rowCount: 0 };
  },

  _findAgent(predicate) {
    const found = this.agents.find(predicate);
    return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
  },

  _handleFollowInsert(params) {
    const existing = this.follows.find(f => f.follower_id === params[0] && f.followed_id === params[1]);
    if (existing) return { rows: [], rowCount: 0 };
    const id = crypto.randomUUID();
    const follow = { id, follower_id: params[0], followed_id: params[1], created_at: new Date().toISOString() };
    this.follows.push(follow);
    return { rows: [follow], rowCount: 1 };
  },

  _handleFollowDelete(normalized, params) {
    if (!normalized.includes('FOLLOWER_ID') || !normalized.includes('FOLLOWED_ID')) return { rows: [], rowCount: 0 };
    const idx = this.follows.findIndex(f => f.follower_id === params[0] && f.followed_id === params[1]);
    if (idx >= 0) {
      const removed = this.follows.splice(idx, 1)[0];
      return { rows: [removed], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },

  _handleFollowSelect(normalized, params) {
    // isFollowing check (no JOIN)
    if (normalized.includes('FOLLOWER_ID') && normalized.includes('FOLLOWED_ID') && !normalized.includes('JOIN')) {
      if (normalized.includes('ANY')) {
        const ids = Array.isArray(params[1]) ? params[1] : [];
        const found = this.follows.filter(f => f.follower_id === params[0] && ids.includes(f.followed_id));
        return { rows: found, rowCount: found.length };
      }
      const found = this.follows.find(f => f.follower_id === params[0] && f.followed_id === params[1]);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    // Friends-of-friends (suggested follows)
    if (normalized.includes('FROM FOLLOWS F1') || (normalized.includes('FROM FOLLOWS') && normalized.includes('JOIN FOLLOWS'))) {
      const agentId = params[0];
      const limit = parseInt(params[1], 10) || 10;
      const myFollowedIds = new Set(this.follows.filter(f => f.follower_id === agentId).map(f => f.followed_id));
      const candidates = {};
      for (const fId of myFollowedIds) {
        for (const f of this.follows.filter(f2 => f2.follower_id === fId)) {
          if (f.followed_id !== agentId && !myFollowedIds.has(f.followed_id)) {
            candidates[f.followed_id] = (candidates[f.followed_id] || 0) + 1;
          }
        }
      }
      const sorted = Object.entries(candidates)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
      const rows = sorted.map(([id, count]) => {
        const agent = this.agents.find(a => a.id === id);
        return agent ? { ...agent, mutual_count: count } : null;
      }).filter(Boolean);
      return { rows, rowCount: rows.length };
    }

    // Followers/following with JOIN
    if (normalized.includes('JOIN AGENTS')) {
      const agentId = params[0];
      const limit = parseInt(params[1], 10) || 25;
      const offset = parseInt(params[2], 10) || 0;
      const isGetFollowers = normalized.includes('WHERE F.FOLLOWED_ID');

      const filtered = this.follows
        .filter(f => isGetFollowers ? f.followed_id === agentId : f.follower_id === agentId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const sliced = filtered.slice(offset, offset + limit);
      const rows = sliced.map(f => {
        const agent = this.agents.find(a => a.id === (isGetFollowers ? f.follower_id : f.followed_id));
        return agent ? { ...agent, followed_at: f.created_at } : null;
      }).filter(Boolean);
      return { rows, rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  },

  _handleNonce(normalized, params) {
    if (normalized.includes('FROM USED_NONCES') && normalized.includes('WHERE NONCE')) {
      const found = this.used_nonces.find(n => n.nonce === params[0]);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }
    if (normalized.startsWith('INSERT INTO USED_NONCES')) {
      const existing = this.used_nonces.find(n => n.nonce === params[0]);
      if (!existing) this.used_nonces.push({ nonce: params[0], used_at: new Date().toISOString() });
      return { rows: [], rowCount: existing ? 0 : 1 };
    }
    if (normalized.includes('DELETE FROM USED_NONCES')) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      this.used_nonces = this.used_nonces.filter(n => new Date(n.used_at).getTime() > cutoff);
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  },
};

/**
 * Initialize database connection pool
 */
function initializePool() {
  if (pool) return pool;

  if (!config.database.url) {
    if (process.env.USE_MEMORY_STORE === 'true') {
      console.warn('DATABASE_URL not set, using in-memory store (USE_MEMORY_STORE=true)');
      return null;
    }
    throw new Error(
      'DATABASE_URL is required. Run `docker compose up -d` and copy api/.env.example to api/.env, ' +
      'or set USE_MEMORY_STORE=true for development without PostgreSQL.'
    );
  }

  pool = new Pool({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
  });

  pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
  });

  return pool;
}

/**
 * Execute a query
 * 
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function query(text, params) {
  const db = initializePool();

  if (!db) {
    // Use in-memory store when no database is configured
    const result = memoryStore.query(text, params);
    if (config.nodeEnv === 'development') {
      console.log('In-memory query', { text: text.substring(0, 50), rows: result.rowCount });
    }
    return result;
  }

  const start = Date.now();
  const result = await db.query(text, params);
  const duration = Date.now() - start;

  if (config.nodeEnv === 'development') {
    console.log('Query executed', { text: text.substring(0, 50), duration, rows: result.rowCount });
  }

  return result;
}

/**
 * Execute a query and return first row
 * 
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object|null>} First row or null
 */
async function queryOne(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

/**
 * Execute a query and return all rows
 * 
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} All rows
 */
async function queryAll(text, params) {
  const result = await query(text, params);
  return result.rows;
}

/**
 * Execute multiple queries in a transaction
 * 
 * @param {Function} callback - Function receiving client
 * @returns {Promise<any>} Transaction result
 */
async function transaction(callback) {
  const db = initializePool();

  if (!db) {
    // In-memory mode: just run the callback with a mock client
    return callback({ query: (text, params) => memoryStore.query(text, params) });
  }
  
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Check database connection
 * 
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  try {
    const db = initializePool();
    if (!db) return false;
    
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Close database connections
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initializePool,
  query,
  queryOne,
  queryAll,
  transaction,
  healthCheck,
  close,
  getPool: () => pool
};
