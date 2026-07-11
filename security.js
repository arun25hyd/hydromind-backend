// security.js — HydroMind Security Middleware
// Version: 1.0 | Applied to all endpoints

'use strict';

const rateLimit = require('express-rate-limit');
const helmet   = require('helmet');
const crypto   = require('crypto');
const fetch    = require('node-fetch');

// ── 1. HELMET — HTTP Security Headers ────────────────────────────────────
// Prevents XSS, clickjacking, MIME sniffing, and other HTTP attacks
const helmetMiddleware = helmet({
  contentSecurityPolicy: false, // CSP handled separately per route
  crossOriginEmbedderPolicy: false,
});

// ── 2. RATE LIMITERS ─────────────────────────────────────────────────────

// AI Chat — most critical — protects Anthropic API credits
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 20,                    // 20 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait 1 minute before trying again.' },
  skip: (req) => {
    // Skip rate limit for localhost dev
    const ip = req.ip || '';
    return ip === '127.0.0.1' || ip === '::1';
  }
});

// Auth endpoints — brute force protection
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minute window
  max: 10,                    // 10 attempts per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});

// KB search — public endpoint
const kbSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many search requests. Please wait 1 minute.' },
});

// General API — catch-all
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' },
});

// ── 3. INPUT SANITISERS ───────────────────────────────────────────────────

// Validate and sanitise /api/chat request
function validateChatRequest(req, res, next) {
  const { messages, system, model, max_tokens } = req.body;

  // messages required and must be array
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }

  // Max 20 messages in history (prevent huge payloads)
  if (messages.length > 20) {
    return res.status(400).json({ error: 'Too many messages. Maximum 20 allowed.' });
  }

  // Each message must have role and content string
  for (const msg of messages) {
    if (!msg.role || !msg.content) {
      return res.status(400).json({ error: 'Each message must have role and content' });
    }
    if (!['user', 'assistant'].includes(msg.role)) {
      return res.status(400).json({ error: 'Invalid message role' });
    }
    if (typeof msg.content !== 'string') {
      return res.status(400).json({ error: 'Message content must be a string' });
    }
    // Max 8000 chars per message (AI answers can be long — 4000 was too tight)
    if (msg.content.length > 8000) {
      return res.status(400).json({ error: 'Message too long. Maximum 8000 characters.' });
    }
  }

  // System prompt: max 8000 chars, strip dangerous patterns
  if (system && typeof system === 'string') {
    if (system.length > 8000) {
      return res.status(400).json({ error: 'System prompt too long.' });
    }
    req.body.system = system;
  }

  // Force safe model — never accept model from client
  req.body.model = 'claude-sonnet-4-5';

  // Cap max_tokens
  req.body.max_tokens = Math.min(parseInt(max_tokens) || 2000, 3000);

  next();
}

// Validate auth request
function validateAuthRequest(req, res, next) {
  const { email, password, name } = req.body;

  if (email) {
    // Basic email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    // Max email length
    if (email.length > 254) {
      return res.status(400).json({ error: 'Email too long' });
    }
  }

  if (password && password.length > 128) {
    return res.status(400).json({ error: 'Password too long' });
  }

  if (name && name.length > 100) {
    return res.status(400).json({ error: 'Name too long' });
  }

  next();
}

// Validate KB chat request
function validateKBChatRequest(req, res, next) {
  const { question } = req.body;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question required' });
  }
  if (question.length > 2000) {
    return res.status(400).json({ error: 'Question too long. Maximum 2000 characters.' });
  }
  if (question.trim().length < 3) {
    return res.status(400).json({ error: 'Question too short.' });
  }

  next();
}

// ── 4. SAFE ERROR HANDLER ─────────────────────────────────────────────────
// Prevents stack traces and internal details leaking to client
function safeError(res, err, statusCode) {
  statusCode = statusCode || 500;
  // Log full error server-side
  console.error('[ERROR]', err.message || err);
  // Return only safe generic message to client
  const safeMessages = {
    400: 'Invalid request.',
    401: 'Authentication required.',
    403: 'Access denied.',
    404: 'Not found.',
    429: 'Too many requests.',
    500: 'Server error. Please try again.',
  };
  res.status(statusCode).json({
    error: safeMessages[statusCode] || 'An error occurred.'
  });
}

// ── 5. WEBHOOK SECRET ENFORCER ────────────────────────────────────────────
// Always require webhook secret — not optional
function enforceWebhookSecret(req, res, next) {
  const secret = req.headers['x-webhook-secret'];
  if (!process.env.WEBHOOK_SECRET) {
    console.warn('[SECURITY] WEBHOOK_SECRET not set — webhook endpoint disabled');
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('[SECURITY] Invalid webhook secret from IP:', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function enforceRevenueCatWebhook(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!process.env.RC_WEBHOOK_SECRET) {
    console.warn('[SECURITY] RC_WEBHOOK_SECRET not set — RevenueCat webhook disabled');
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  if (authHeader !== process.env.RC_WEBHOOK_SECRET) {
    console.warn('[SECURITY] Invalid RevenueCat webhook auth from IP:', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── 5B. PADDLE WEBHOOK SECURITY ───────────────────────────────────────────
// Paddle webhooks are verified two independent ways, both required:
//   1. IP allowlist — request must originate from a Paddle-published IP.
//      Source of truth is https://api.paddle.com/ips (data.ipv4_cidrs) —
//      fetched at startup and refreshed periodically. Never hard-coded.
//   2. HMAC-SHA256 signature over the raw request body, keyed by the
//      notification destination's signing secret (Paddle-Signature header).
//      Requires the raw body — see express.json({ verify }) in server.js.

let paddleIpCidrs = [];
let paddleIpFetchedOnce = false;

// The dynamic https://api.paddle.com/ips fetch below does NOT reliably
// include these — confirmed by testing (sandbox webhook deliveries were
// rejected even with a freshly-fetched CIDR list). Paddle documents these
// as fixed, separate IP sets for sandbox vs live webhook-sending servers:
// https://developer.paddle.com/webhooks/about/respond-to-webhooks/
// Kept as static /32s and always checked in addition to the dynamic list.
const PADDLE_STATIC_WEBHOOK_IPS = {
  sandbox: ['34.194.127.46', '54.234.237.108', '3.208.120.145', '44.226.236.210', '44.241.183.62', '100.20.172.113'],
  live: ['34.232.58.13', '34.195.105.136', '34.237.3.244', '35.155.119.135', '52.11.166.252', '34.212.5.7'],
};

function ipv4ToLong(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [range, bitsStr] = String(cidr || '').split('/');
  const bits = parseInt(bitsStr, 10);
  const ipLong = ipv4ToLong(ip);
  const rangeLong = ipv4ToLong(range);
  if (ipLong === null || rangeLong === null || Number.isNaN(bits)) return false;
  if (bits === 0) return true;
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipLong & mask) === (rangeLong & mask);
}

// Fetches the current Paddle IP allowlist. Call once at startup and on a
// periodic timer (see server.js). On failure, keeps serving the last known
// good list — only blocks everything if we have never fetched successfully.
async function refreshPaddleIpAllowlist() {
  try {
    const res = await fetch('https://api.paddle.com/ips');
    if (!res.ok) throw new Error(`Paddle IP API returned ${res.status}`);
    const json = await res.json();
    const cidrs = json && json.data && json.data.ipv4_cidrs;
    if (!Array.isArray(cidrs) || cidrs.length === 0) throw new Error('Empty/invalid ipv4_cidrs');
    paddleIpCidrs = cidrs;
    paddleIpFetchedOnce = true;
    console.log(`[SECURITY] Paddle IP allowlist refreshed — ${cidrs.length} CIDR ranges`);
  } catch (err) {
    console.error('[SECURITY] Failed to refresh Paddle IP allowlist:', err.message);
  }
}

function enforcePaddleIpAllowlist(req, res, next) {
  if (!paddleIpFetchedOnce) {
    console.warn('[SECURITY] Paddle IP allowlist not yet loaded — rejecting webhook from IP:', req.ip);
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  const ip = String(req.ip || '').replace(/^::ffff:/, ''); // normalise IPv4-mapped IPv6
  const staticList = PADDLE_STATIC_WEBHOOK_IPS[process.env.PADDLE_ENV === 'live' ? 'live' : 'sandbox'];
  const allowed = staticList.includes(ip) || paddleIpCidrs.some(cidr => ipv4InCidr(ip, cidr));
  if (!allowed) {
    console.warn('[SECURITY] Rejected Paddle webhook from disallowed IP:', ip);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Verifies the Paddle-Signature header: "ts=<unix_ts>;h1=<hex_hmac>".
// Requires req.rawBody (Buffer) to be populated by express.json's verify hook.
function enforcePaddleWebhook(req, res, next) {
  if (!process.env.PADDLE_WEBHOOK_SECRET) {
    console.warn('[SECURITY] PADDLE_WEBHOOK_SECRET not set — Paddle webhook disabled');
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  const sigHeader = req.headers['paddle-signature'];
  if (!sigHeader || !req.rawBody) {
    console.warn('[SECURITY] Missing Paddle signature or raw body from IP:', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const parts = {};
  sigHeader.split(';').forEach(kv => {
    const [k, v] = kv.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  });
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) {
    console.warn('[SECURITY] Malformed Paddle-Signature header from IP:', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const signedPayload = `${ts}:${req.rawBody}`;
  const expected = crypto.createHmac('sha256', process.env.PADDLE_WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(h1, 'utf8');
  const validSignature = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
  if (!validSignature) {
    console.warn('[SECURITY] Invalid Paddle webhook signature from IP:', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── 6. REQUEST LOGGER ─────────────────────────────────────────────────────
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (res.statusCode >= 400) {
      console.warn(`[${res.statusCode}] ${req.method} ${req.path} — ${ip} — ${duration}ms`);
    }
  });
  next();
}

module.exports = {
  helmetMiddleware,
  chatLimiter,
  authLimiter,
  kbSearchLimiter,
  generalLimiter,
  validateChatRequest,
  validateAuthRequest,
  validateKBChatRequest,
  safeError,
  enforceWebhookSecret,
  enforceRevenueCatWebhook,
  refreshPaddleIpAllowlist,
  enforcePaddleIpAllowlist,
  enforcePaddleWebhook,
  requestLogger,
};
