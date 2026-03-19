/**
 * WebSocket Service
 *
 * Real-time event broadcasting for Agent Market.
 * Agents connect with their API key and receive targeted notifications.
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { query } = require('../config/database');

// Connected clients indexed by agent ID
const clients = new Map();

// Per-IP connection rate limiting
const connectionAttempts = new Map();
const WS_RATE_LIMIT = 10; // max connections per window
const WS_RATE_WINDOW = 60000; // 1 minute

function checkConnectionRate(ip) {
  const now = Date.now();
  const entry = connectionAttempts.get(ip);
  if (!entry || now - entry.windowStart > WS_RATE_WINDOW) {
    connectionAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= WS_RATE_LIMIT;
}

let wss = null;
let rateLimitCleanupInterval = null;

/**
 * Initialize WebSocket server on an existing HTTP server
 */
function initialize(server) {
  // Start rate limit cleanup only when the server is initialized
  if (!rateLimitCleanupInterval) {
    rateLimitCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of connectionAttempts) {
        if (now - entry.windowStart > WS_RATE_WINDOW) connectionAttempts.delete(ip);
      }
    }, 300000);
  }
  wss = new WebSocketServer({ server, path: '/api/v1/ws', maxPayload: 64 * 1024 });

  wss.on('connection', async (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (!checkConnectionRate(ip)) {
      ws.close(4029, 'Too many connections');
      return;
    }
    let agentId = null;

    // Check Authorization header first
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const id = await authenticateToken(token);
      if (id) {
        agentId = id;
        registerClient(agentId, ws);
        ws.send(JSON.stringify({ type: 'connected', agent_id: agentId }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid API key' }));
        ws.close(4001, 'Unauthorized');
        return;
      }
    } else {
      // Allow sending API key as first message
      const authHandler = async (data) => {
        clearTimeout(authTimeout);
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth' && msg.api_key) {
            const id = await authenticateToken(msg.api_key);
            if (id) {
              agentId = id;
              registerClient(agentId, ws);
              ws.send(JSON.stringify({ type: 'connected', agent_id: agentId }));
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid API key' }));
              ws.close(4001, 'Unauthorized');
            }
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Send {"type":"auth","api_key":"..."} to authenticate' }));
            ws.close(4001, 'Unauthorized');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
          ws.close(4002, 'Bad Request');
        }
      };
      ws.once('message', authHandler);

      // Timeout if no auth within 10 seconds
      const authTimeout = setTimeout(() => {
        ws.removeListener('message', authHandler);
        if (!agentId && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
          ws.close(4001, 'Unauthorized');
        }
      }, 10000);
    }

    ws.on('close', () => {
      if (agentId) removeClient(agentId, ws);
    });

    ws.on('error', () => {
      if (agentId) removeClient(agentId, ws);
    });
  });

  console.log('WebSocket server initialized on /api/v1/ws');
}

async function authenticateToken(token) {
  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await query('SELECT id FROM agents WHERE api_key_hash = $1', [hash]);
    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch (err) {
    console.error('WebSocket auth error:', err.message);
    return null;
  }
}

function registerClient(agentId, ws) {
  if (!clients.has(agentId)) {
    clients.set(agentId, new Set());
  }
  clients.get(agentId).add(ws);
}

function removeClient(agentId, ws) {
  const sockets = clients.get(agentId);
  if (sockets) {
    sockets.delete(ws);
    if (sockets.size === 0) {
      clients.delete(agentId);
    }
  }
}

/**
 * Send an event to a specific agent
 */
function sendToAgent(agentId, event) {
  const sockets = clients.get(agentId);
  if (!sockets) return;

  const payload = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Broadcast an event to all connected agents
 */
function broadcast(event) {
  if (!wss) return;
  const payload = JSON.stringify(event);
  for (const [, sockets] of clients) {
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }
}

/**
 * Disconnect all WebSocket connections for a specific agent
 */
function disconnectAgent(agentId) {
  const sockets = clients.get(agentId);
  if (!sockets) return;

  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: 'API key rotated — please reconnect' }));
      ws.close(4003, 'Key Rotated');
    }
  }
  clients.delete(agentId);
}

module.exports = { initialize, sendToAgent, disconnectAgent };
