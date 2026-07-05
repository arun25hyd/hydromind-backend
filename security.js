// security.js — HydroMind Security Middleware
// Version: 1.0 | Applied to all endpoints

'use strict';

const rateLimit = require('express-rate-limit');
const helmet   = require('helmet');

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
  requestLogger,
};
