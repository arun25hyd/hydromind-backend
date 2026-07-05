const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const { helmetMiddleware, chatLimiter, authLimiter, kbSearchLimiter, generalLimiter, validateChatRequest, validateAuthRequest, validateKBChatRequest, safeError, enforceWebhookSecret, enforceRevenueCatWebhook, requestLogger } = require("./security");

const app = express();
const PORT = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── ZOHO SMTP TRANSPORTER ──────────────────────────────────────────────────
const zohoTransporter = nodemailer.createTransport({
  host: 'smtp.zoho.com',
  port: 465,
  secure: true, // SSL
  auth: {
    user: process.env.ZOHO_USER, // e.g. support@hydromindai.com
    pass: process.env.ZOHO_PASS  // Zoho app password
  }
});

async function sendEmail({ to, subject, html, replyTo }) {
  if (!process.env.ZOHO_USER || !process.env.ZOHO_PASS) {
    console.warn('[EMAIL] ZOHO_USER or ZOHO_PASS not set — skipping email send');
    return false;
  }
  try {
    await zohoTransporter.sendMail({
      from: `"HydroMind AI" <${process.env.ZOHO_USER}>`,
      to,
      subject,
      html,
      replyTo: replyTo || process.env.ZOHO_USER
    });
    return true;
  } catch (err) {
    console.error('[EMAIL] Zoho SMTP error:', err.message);
    return false;
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    db: { schema: 'public' },
    global: { headers: { 'x-connection-encrypted': 'true' } },
    auth: { persistSession: false }
  }
);

// ── KB QUERY CACHE (in-memory LRU) ─────────────────────────────────────────
// Reduces Supabase egress/API calls significantly.
// TTL: 10 minutes. Max: 200 entries. Keyed by normalised question string.
const KB_CACHE = new Map();
const KB_CACHE_TTL  = 60 * 60 * 1000; // 60 min — Supabase Pro, no egress concern
const KB_CACHE_MAX  = 500;             // Increased from 200 — more headroom on Pro

const HYDROMIND_ADVISOR_SYSTEM = `
You are HydroMind AI, a senior marine/offshore crane hydraulic specialist.

NON-NEGOTIABLE ANSWER RULES:
1. Answer the user's exact question only. Do not expand into adjacent overhaul, cylinder, gearbox, electrical, PLC, CAN-bus, or unrelated maintenance topics.
2. Work strictly in hydraulic, mechanical, winch, crane, deck machinery, HPU, pump, motor, valve, brake, accumulator, filtration, and fluid power scope.
3. Start technical answers with safety: LOTO, stored hydraulic pressure, accumulators, suspended load/line pull hazards, hot oil, and test area barricading when relevant.
4. If KB context is provided, use only the parts that directly match the user's question. Ignore unrelated KB chunks even if they are included.
5. If KB context is weak or absent, say: "No exact KB match found. Answering from hydraulic engineering practice." Then answer from first principles without inventing an OEM manual.
6. Never claim a specific brand, manual, model, pressure, capacity, or acceptance value unless the user supplied it or it appears in the relevant KB context. Otherwise say "per OEM manual/test procedure" or "typical range only, verify OEM value."
7. BRAND GATE: If the user did not name a manufacturer or exact model, do not mention any manufacturer, model, manual title, example model, or brand-specific capacity from KB context. Convert useful KB details into a generic engineering answer.
8. For procedure questions, use this format: Safety controls -> Objective -> Required setup -> Step-by-step procedure -> Acceptance checks -> Stop-test conditions -> Records/DPR.
9. Keep the response practical and field-ready. Avoid long textbook sections and avoid formulas unless the user specifically asks for calculation.
`;

const KB_STOP_WORDS = new Set([
  'the','and','for','with','after','before','how','what','why','when','where','which','who',
  'can','could','would','should','shall','please','perform','procedure','test','service',
  'serviced','workshop','make','made','does','into','from','this','that','then','than',
]);

const KB_DOMAIN_TERMS = new Set([
  'winch','hoist','luff','luffing','slew','slewing','crane','stall','load','pull','brake',
  'motor','pump','hydraulic','pressure','flow','case','drain','pilot','counterbalance','cbv',
  'relief','hpu','drum','rope','gearbox','charge','closed','open','loop','valve','filter',
]);

const KB_BRAND_TERMS = [
  'braden','paccar','favco','favelle','liebherr','macgregor','seatrax','nov','amclyde',
  'rexroth','bosch','danfoss','parker','eaton','vickers','kawasaki','oilgear','hagglunds',
  'palfinger','mitsubishi','pusnes','aker','cargotec',
];

function detectUserBrandTerms(question) {
  const q = String(question || '').toLowerCase();
  return KB_BRAND_TERMS.filter(brand => q.includes(brand));
}

function hasExplicitModel(question) {
  const q = String(question || '').toLowerCase();
  // Strip ordinal suffixes (1st, 2nd, 3rd, 4th...) first — these read as
  // digit+letters but are not model numbers.
  const qNoOrdinals = q.replace(/\b(\d{1,3})(st|nd|rd|th)\b/g, '$1');
  // Model-style tokens: letters and digits touching directly, or hyphen-joined
  // (CH150A, WE6, 175A, CH-150A, A4VG, 4WE6). Deliberately does NOT allow a bare
  // space between a word and a number — "is 10 years", "after 2 hours" etc. are
  // not model numbers and must stay generic.
  return /\b([a-z]{1,5}-?\d{1,5}[a-z0-9-]*|\d{1,5}-?[a-z]{1,5}\d?[a-z0-9-]*)\b/.test(qNoOrdinals);
}

function isGenericQuestion(question) {
  return detectUserBrandTerms(question).length === 0 && !hasExplicitModel(question);
}

function sanitizeGenericKbText(text) {
  return String(text || '')
    .replace(/\bBraden\b/gi, 'the winch manufacturer')
    .replace(/\bPACCAR\b/gi, 'the winch manufacturer')
    .replace(/\bFavelle\s+Favco\b/gi, 'the crane manufacturer')
    .replace(/\bFavco\b/gi, 'the crane manufacturer')
    .replace(/\bLiebherr\b/gi, 'the crane manufacturer')
    .replace(/\bMacGregor\b/gi, 'the deck machinery manufacturer')
    .replace(/\bSeatrax\b/gi, 'the crane manufacturer')
    .replace(/\bRexroth\b/gi, 'the component manufacturer')
    .replace(/\bDanfoss\b/gi, 'the component manufacturer')
    .replace(/\bParker\b/gi, 'the component manufacturer')
    .replace(/\bEaton\b/gi, 'the component manufacturer')
    .replace(/\bVickers\b/gi, 'the component manufacturer')
    .replace(/\bKawasaki\b/gi, 'the component manufacturer')
    .replace(/\bOilgear\b/gi, 'the component manufacturer')
    .replace(/\bCH\s?(?:150A|164A|165A|175A|185A|230A|series)\b/gi, 'the applicable winch model')
    .replace(/\b(?:150A|164A|165A|175A|185A|230A)\b/g, 'the applicable model')
    .replace(/\b\d{1,3},?\d{3}\s?(?:lbs|lb|kg|t)\b/gi, 'the rated line pull/load');
}

function genericKbTitle(chunk) {
  const category = chunk.category || 'KB';
  const component = chunk.component_type || 'winch/hydraulic reference';
  return `${category} — ${component}`;
}

function tokenizeTechnicalTerms(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !KB_STOP_WORDS.has(w));
}

function scoreKbChunkRelevance(question, chunk) {
  const qTerms = tokenizeTechnicalTerms(question);
  const text = [
    chunk.doc_name,
    chunk.category,
    chunk.brand,
    chunk.component_type,
    chunk.tags,
    chunk.searchable_text,
  ].join(' ').toLowerCase();

  let exactMatches = 0;
  let domainMatches = 0;
  for (const term of qTerms) {
    if (text.includes(term)) {
      exactMatches += 1;
      if (KB_DOMAIN_TERMS.has(term)) domainMatches += 1;
    }
  }

  let score = exactMatches + domainMatches * 2;
  const q = String(question || '').toLowerCase();

  if (q.includes('stall') && text.includes('stall')) score += 6;
  if (q.includes('winch') && text.includes('winch')) score += 6;
  if (q.includes('workshop') && /(workshop|test stand|bench|commission|acceptance|load test)/.test(text)) score += 4;
  if (q.includes('brake') && text.includes('brake')) score += 3;

  if (q.includes('stall') && !text.includes('stall')) score -= 8;
  if (q.includes('winch') && !text.includes('winch') && !text.includes('hoist')) score -= 6;
  if (q.includes('workshop') && /(rod straightness|piston seal|cylinder barrel|surface finish)/.test(text)) score -= 10;

  return score;
}

function filterRelevantKbChunks(question, chunks) {
  const generic = isGenericQuestion(question);
  const scored = (chunks || [])
    .map(chunk => {
      const brandSpecific = [
        chunk.doc_name,
        chunk.brand,
        chunk.searchable_text,
      ].join(' ').toLowerCase();
      const hasBrand = KB_BRAND_TERMS.some(brand => brandSpecific.includes(brand));
      const baseScore = scoreKbChunkRelevance(question, chunk);
      return {
        ...chunk,
        brandSpecific: hasBrand,
        relevanceScore: generic && hasBrand ? Math.max(0, baseScore - 4) : baseScore,
      };
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  const q = String(question || '').toLowerCase();
  const threshold = q.includes('stall') || q.includes('workshop') ? 8 : 5;
  const relevant = scored.filter(chunk => chunk.relevanceScore >= threshold);

  return {
    chunks: relevant.slice(0, 4),
    found: relevant.length > 0,
    bestScore: scored[0]?.relevanceScore || 0,
    generic,
  };
}

function kbCacheGet(key) {
  const entry = KB_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > KB_CACHE_TTL) { KB_CACHE.delete(key); return null; }
  return entry.value;
}
function kbCacheSet(key, value) {
  if (KB_CACHE.size >= KB_CACHE_MAX) {
    // Evict oldest entry
    KB_CACHE.delete(KB_CACHE.keys().next().value);
  }
  KB_CACHE.set(key, { value, ts: Date.now() });
}
function kbCacheKey(question) {
  return question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// ── CORS ───────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://hydromindai.com',
  'https://www.hydromindai.com',
  'http://localhost:3000',
  'http://localhost:8080',
];
app.set('trust proxy', 1); // Required on Render — ensures req.ip reflects real client IP, not load-balancer IP, so rate limiting works correctly
app.use(helmetMiddleware);
app.use(requestLogger);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);  // allow server-to-server
    if (
      ALLOWED_ORIGINS.includes(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.netlify.app') ||
      origin === process.env.FRONTEND_URL
    ) return cb(null, true);
    cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));
app.use(generalLimiter);

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "HydroMind AI v5.2 Online", kb: "Supabase Vector DB Active", build: "text-only-v7.0" }));

// ── KB CACHE STATS (admin — protected by webhook secret) ──────────────────
app.get("/api/cache/stats", enforceWebhookSecret, (req, res) => {
  res.json({ entries: KB_CACHE.size, maxEntries: KB_CACHE_MAX, ttlMs: KB_CACHE_TTL });
});
app.post("/api/cache/clear", enforceWebhookSecret, (req, res) => {
  KB_CACHE.clear();
  res.json({ ok: true, message: "KB cache cleared" });
});

// ── KEEP-ALIVE SELF-PING — prevents Render free tier from sleeping ──────────
// Pings the server every 10 minutes so it never goes idle
setInterval(async () => {
  try {
    await fetch('https://hydromind-backend.onrender.com/');
    console.log('[keep-alive] ping sent');
  } catch (e) {
    console.log('[keep-alive] ping failed:', e.message);
  }
}, 10 * 60 * 1000); // every 10 minutes

// ══════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });

  // Path 1: backend's own JWT (web platform — unchanged behavior)
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    // fall through to Path 2
  }

  // Path 2: Supabase access token (mobile app — Supabase Auth session)
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) throw error || new Error("No Supabase user");
    req.user = { id: data.user.id, email: data.user.email, source: "supabase" };
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// SOFT IDENTITY — identifies the caller for rate-limiting without requiring
// login. Logged-in users are tracked by account id (stable, accurate).
// Anonymous users are tracked by a client-supplied browser fingerprint hash
// (X-Client-Fingerprint header) — best-effort, not cryptographically robust,
// but far better than IP alone on shared office/vessel networks.
// ══════════════════════════════════════════════════════════════════════════
async function getLivePlan(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('is_premium, is_admin')
    .eq('id', userId)
    .single();

  if (error || !data) return { plan: "Free", isAdmin: false };
  if (data.is_admin) return { plan: "Admin", isAdmin: true };
  return { plan: data.is_premium ? "Pro" : "Free", isAdmin: false };
}

const softIdentify = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.identity = { id: decoded.id || decoded.sub, type: "user" };
      const { plan, isAdmin } = await getLivePlan(decoded.id);
      req.user = { id: decoded.id, email: decoded.email, isAdmin, plan };
      return next();
    } catch { /* fall through to Supabase token check */ }
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        req.identity = { id: data.user.id, type: "user" };
        const { plan, isAdmin } = await getLivePlan(data.user.id);
        req.user = { id: data.user.id, email: data.user.email, isAdmin, plan };
        return next();
      }
    } catch { /* fall through to anonymous */ }
  }
  const fp = req.headers["x-client-fingerprint"];
  if (fp && typeof fp === "string" && fp.length >= 8 && fp.length <= 128) {
    req.identity = { id: fp, type: "fingerprint" };
  } else {
    req.identity = { id: "unknown-no-fingerprint", type: "fingerprint" };
  }
  next();
};

const FREE_DAILY_QUERY_LIMIT = 10;

// Read-only check — does NOT increment. Blocks the request with 429 if
// today's count is already at the limit; otherwise attaches the current
// (pre-increment) count to req and proceeds. The actual increment only
// happens on a successful response via incrementDailyQueryUsage(), so a
// failed/errored Claude call never costs the user one of their daily queries.
// Pro/Enterprise/Admin users are exempt entirely.
const checkDailyQueryLimit = async (req, res, next) => {
  try {
    if (req.user && (req.user.isAdmin || req.user.plan === "Pro" || req.user.plan === "Enterprise" || req.user.plan === "Admin")) {
      return next();
    }
    const today = new Date().toISOString().slice(0, 10); // UTC date, YYYY-MM-DD
    const { id } = req.identity;

    const { data: existing, error: selErr } = await supabase
      .from("query_usage")
      .select("query_count")
      .eq("identifier", id)
      .eq("usage_date", today)
      .maybeSingle();
    if (selErr) throw selErr;

    const currentCount = existing?.query_count || 0;
    if (currentCount >= FREE_DAILY_QUERY_LIMIT) {
      return res.status(429).json({
        error: "Daily free query limit reached",
        limit: FREE_DAILY_QUERY_LIMIT,
        resetsAt: "midnight UTC",
        kbUsed: false
      });
    }

    req._dailyCurrentCount = currentCount; // pre-increment count, used by incrementDailyQueryUsage
    req.queriesRemainingToday = FREE_DAILY_QUERY_LIMIT - currentCount;
    next();
  } catch (err) {
    console.error("checkDailyQueryLimit error:", err.message);
    // Fail open: a usage-tracking outage shouldn't take down the whole advisor.
    next();
  }
};

// Call only after a successful response is ready to send. Atomically bumps
// today's row for this identity by 1. Best-effort: logs on failure but never
// throws, since a tracking-table hiccup shouldn't break an answer the user
// already received.
const incrementDailyQueryUsage = async (req) => {
  try {
    if (req.user && (req.user.isAdmin || req.user.plan === "Pro" || req.user.plan === "Enterprise" || req.user.plan === "Admin")) {
      return; // exempt, nothing to track
    }
    if (typeof req._dailyCurrentCount !== "number" || !req.identity) return;
    const today = new Date().toISOString().slice(0, 10);
    const { id, type } = req.identity;
    const newCount = req._dailyCurrentCount + 1;
    const { error: upsertErr } = await supabase
      .from("query_usage")
      .upsert({
        identifier: id,
        identifier_type: type,
        usage_date: today,
        query_count: newCount,
        updated_at: new Date().toISOString()
      }, { onConflict: "identifier,usage_date" });
    if (upsertErr) throw upsertErr;
    req.queriesRemainingToday = FREE_DAILY_QUERY_LIMIT - newCount;
  } catch (err) {
    console.error("incrementDailyQueryUsage error:", err.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/auth/register", authLimiter, validateAuthRequest, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const { data: existing } = await supabase.from("users").select("id").eq("email", email.toLowerCase()).single();
    if (existing) return res.status(400).json({ error: "Email already registered" });
    const hash = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase.from("users")
      .insert({ name, email: email.toLowerCase(), password_hash: hash, is_premium: false })
      .select("id, name, email, is_premium").single();
    if (error) throw error;
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, isPremium: user.is_premium }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, isPremium: user.is_premium } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", authLimiter, validateAuthRequest, async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user } = await supabase.from("users").select("*").eq("email", email.toLowerCase()).single();
    if (!user) return res.status(400).json({ error: "Invalid email or password" });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: "Invalid email or password" });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, isPremium: user.is_premium }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, isPremium: user.is_premium } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// AI CHAT PROXY
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/chat", chatLimiter, validateChatRequest, async (req, res) => {
  try {
    const { model, max_tokens, system, messages, tools } = req.body;
    if (!messages) return res.status(400).json({ error: "messages required" });
    const body = { model: model || "claude-sonnet-4-5", max_tokens: max_tokens || 2000, messages };
    if (system) body.system = system;
    if (tools) body.tools = tools;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ══════════════════════════════════════════════════════════════════════════
// PASSWORD RESET — send reset link via Supabase Auth email
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    // Check user exists
    const { data: users } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", email.toLowerCase().trim())
      .limit(1);

    if (!users || users.length === 0) {
      // Don't reveal if email exists — security best practice
      return res.json({ success: true, message: "If this email is registered, a reset link has been sent." });
    }

    // Generate a reset token (random hex, expires 1 hour)
    const crypto = require("crypto");
    const resetToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    // Store token in users table (add reset_token, reset_expires columns if not exist)
    await supabase.from("users").update({
      reset_token: resetToken,
      reset_expires: expires
    }).eq("email", email.toLowerCase().trim());

    // Build reset link pointing to frontend
    const frontendUrl = process.env.FRONTEND_URL || 'https://www.hydromindai.com';
    const resetLink = `${frontendUrl}?reset=${resetToken}`;

    // Send password reset email via Zoho SMTP
    await sendEmail({
      to: email,
      subject: 'HydroMind AI — Password Reset',
      html: `
        <div style="font-family:Arial,sans-serif;background:#060d11;color:#e8f4ff;padding:32px;max-width:520px;margin:0 auto;border:1px solid #1b2d40;border-radius:10px;">
          <h2 style="color:#22d3ee;margin:0 0 20px;font-size:22px;">HydroMind<span style="color:#fff">.AI</span></h2>
          <p style="font-size:15px;line-height:1.6;color:#b4c2cc;">You requested a password reset for your HydroMind AI account.</p>
          <p style="font-size:15px;line-height:1.6;color:#b4c2cc;">Click the button below to reset your password. This link expires in <strong style="color:#fff;">1 hour</strong>.</p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${resetLink}" style="display:inline-block;background:#06b6d4;color:#03171c;padding:14px 32px;border-radius:9px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.03em;">Reset Password →</a>
          </div>
          <p style="font-size:12px;color:#4a5568;line-height:1.5;">If you did not request this, ignore this email — your password will not change.</p>
          <p style="font-size:11px;color:#374151;margin-top:16px;word-break:break-all;">Link: ${resetLink}</p>
          <hr style="border:none;border-top:1px solid #1b2d40;margin:20px 0;">
          <p style="font-size:11px;color:#374151;">HydroMind.AI — Hydraulic Intelligence for Industry</p>
        </div>
      `
    });

    res.json({ success: true, message: "If this email is registered, a reset link has been sent." });
  } catch (e) {
    console.error("Forgot password error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "Token and new password required" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    // Find user with this token
    const { data: users } = await supabase
      .from("users")
      .select("id, email, reset_expires")
      .eq("reset_token", token)
      .limit(1);

    if (!users || users.length === 0) return res.status(400).json({ error: "Invalid or expired reset link" });

    const user = users[0];
    if (new Date(user.reset_expires) < new Date()) {
      return res.status(400).json({ error: "Reset link has expired. Please request a new one." });
    }

    // Hash new password and clear token
    const bcrypt = require("bcryptjs");
    const hashed = await bcrypt.hash(newPassword, 10);
    await supabase.from("users").update({
      password_hash: hashed,
      reset_token: null,
      reset_expires: null
    }).eq("id", user.id);

    res.json({ success: true, message: "Password reset successfully. You can now sign in." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════
function chunkText(text, chunkSize = 500, overlap = 50) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (chunk.trim().length > 50) chunks.push(chunk);
    i += chunkSize - overlap;
  }
  return chunks;
}

async function getEmbedding(text) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      system: "Return ONLY a JSON array of 384 numbers between -1 and 1 representing the semantic embedding of the input text. No explanation, no markdown.",
      messages: [{ role: "user", content: `Embed this text: "${text.substring(0, 1000)}"` }]
    })
  });
  const data = await response.json();
  try {
    const raw = data.content[0].text.replace(/```json|```/g, "").trim();
    return JSON.parse(raw);
  } catch {
    const vec = new Array(384).fill(0);
    for (let i = 0; i < text.length; i++) vec[i % 384] += text.charCodeAt(i) / 1000;
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  }
}

// ── MODEL → KB ID DIRECT LOOKUP MAP ──────────────────────────────────────────
const MODEL_MAP = [
  { patterns: ['a4vg','a4vg56','a4vg90','a4vg125','a4vg180'], kbIds: ['KB116','KB117'] },
  { patterns: ['a10v','a10vso','a10vo'],          kbIds: ['KB134'] },
  { patterns: ['a4vso'],                          kbIds: ['KB130'] },
  { patterns: ['a20vlo'],                         kbIds: ['KB128'] },
  { patterns: ['a4csg'],                          kbIds: ['KB135'] },
  { patterns: ['a2fo'],                           kbIds: ['KB129'] },
  { patterns: ['a6vm'],                           kbIds: ['KB151'] },
  { patterns: ['mrt','mre'],                      kbIds: ['KB153'] },
  // Sauer Danfoss Series 90 — MORE SPECIFIC patterns first
  { patterns: ['series 90 motor','serie 90 motor','danfoss 90 motor','s90 motor','90 motor datasheet'],kbIds: ['KB154'] },
  { patterns: ['series 90 pump','serie 90 pump','danfoss 90 pump','s90 pump','danfoss pump serie 90'], kbIds: ['KB141','KB119'] },
  { patterns: ['series 90','serie 90','danfoss 90','s90'],                                            kbIds: ['KB141','KB119','KB154'] },
  // Sauer Danfoss Series 45 / Series 40 / M45
  { patterns: ['series 45','serie 45','danfoss 45','s45'],                                            kbIds: ['KB142'] },
  { patterns: ['series 40','serie 40','m45 pump','danfoss 40'],                                       kbIds: ['KB140'] },
  { patterns: ['f11','f12','parker f11'],         kbIds: ['KB124'] },
  { patterns: ['pvg32','pvg 32'],                 kbIds: ['KB196'] },
  { patterns: ['pvg120','pvg 120'],               kbIds: ['KB167','KB312'] },
  { patterns: ['rexroth we','we6 dcv','we dcv'],  kbIds: ['KB189'] },
  { patterns: ['counterbalance','cbv','vickers cbv','eaton cbv'], kbIds: ['KB201'] },
  { patterns: ['favco','favelle'],                kbIds: ['KB115'] },
  { patterns: ['seatrax'],                        kbIds: ['KB110'] },
  { patterns: ['macgregor','hmc2201'],            kbIds: ['KB109'] },
  { patterns: ['nov ahc','knuckle boom'],         kbIds: ['KB114'] },
  { patterns: ['amclyde','model 52'],             kbIds: ['KB102'] },
  { patterns: ['braden winch','braden ch'],       kbIds: ['KB103','KB274'] },
  { patterns: ['vt-hacd','vt hacd'],              kbIds: ['KB317'] },
  { patterns: ['vtvpcd'],                         kbIds: ['KB318'] },
  { patterns: ['vt-varp','vt varp','varp1'],      kbIds: ['KB309'] },
  { patterns: ['pvres','pvrel'],                  kbIds: ['KB311'] },
  { patterns: ['danfoss pvg','pvg proportional'], kbIds: ['KB196','KB167','KB312'] },
  { patterns: ['rexroth a4vg'],                   kbIds: ['KB116','KB117'] },
  { patterns: ['kawasaki k3vl'],                  kbIds: ['KB121'] },
  { patterns: ['oilgear','pvm-62','pvm62'],       kbIds: ['KB123','KB144'] },
];

// ── CLEAN searchKBInternal — keyword search + scoring only ────────────────────
async function searchKBInternal(question, topK) {
  topK = topK || 5;
  try {
    const qWords = question.toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 6);

    if (qWords.length === 0) return { chunks: [], found: false };

    const conditions = [];
    for (const w of qWords) {
      conditions.push(`doc_name.ilike.%${w}%`);
      conditions.push(`searchable_text.ilike.%${w}%`);
      conditions.push(`brand.ilike.%${w}%`);
    }
    const orFilter = conditions.join(',');

    const { data: allRows, error } = await supabase
      .from("kb_chunks")
      .select("id, kb_id, doc_name, category, brand, component_type, searchable_text, schematic_ids, schematic_count, tags")
      .or(orFilter)
      .limit(20);

    if (error) { console.error('KB search error:', error.message); return { chunks: [], found: false }; }
    if (!allRows || allRows.length === 0) return { chunks: [], found: false };

    // Score each chunk
    const scored = allRows.map(chunk => {
      const text  = (chunk.searchable_text || "").toLowerCase();
      const title = (chunk.doc_name || "").toLowerCase();
      const comp  = (chunk.component_type || "").toLowerCase();
      const cat   = (chunk.category || "").toLowerCase();
      let score = 0;
      for (const word of qWords) {
        score += (text.match(new RegExp(word, "g")) || []).length;
        score += (title.match(new RegExp(word, "g")) || []).length * 4;
        if (comp.includes(word)) score += 20;
        if (cat.includes(word)) score += 5;
      }
      const phrase = question.toLowerCase().replace(/[^a-z0-9 ]/g," ").trim();
      if (title.includes(phrase.substring(0, 20))) score += 30;
      if (title.includes("troubleshooting guide") && !phrase.includes("troubleshooting guide")) score = Math.max(0, score - 10);
      if (title.includes("industrial hydraulics") && qWords.length > 2) score = Math.max(0, score - 8);
      return { ...chunk, score };
    });

    const top = scored.sort((a,b) => b.score - a.score).slice(0, topK).filter(c => c.score > 0);
    console.log(`KB search: "${question.slice(0,50)}" — candidates: ${allRows.length}, matched: ${top.length}, top: ${top[0]?.doc_name?.slice(0,30)}`);
    return { chunks: top, found: top.length > 0 };
  } catch (e) {
    console.error("searchKBInternal error:", e.message);
    return { chunks: [], found: false };
  }
}



// ══════════════════════════════════════════════════════════════════════════
// DOCUMENT UPLOAD
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/kb/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    const { category, description } = req.body;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (req.file.mimetype !== "application/pdf") return res.status(400).json({ error: "Only PDF files accepted" });
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text.replace(/\s+/g, " ").trim();
    if (text.length < 100) return res.status(400).json({ error: "PDF appears empty or unreadable" });
    const docName = req.file.originalname.replace(".pdf", "");
    // kb_documents.uploaded_by has a FK to public.users.id (web-platform custom auth table).
    // Supabase-Auth-authenticated requests (mobile) carry an auth.users UUID instead, which
    // does not exist in public.users and would violate the FK. Only attribute uploads made
    // via the custom JWT path; leave it NULL for Supabase Auth sessions.
    const uploadedBy = req.user.source === "supabase" ? null : req.user.id;
    const { data: doc, error: docErr } = await supabase.from("kb_documents")
      .insert({ name: docName, category: category || "General", description: description || "", uploaded_by: uploadedBy, page_count: pdfData.numpages, char_count: text.length, status: "processing" })
      .select("id").single();
    if (docErr) throw docErr;
    res.json({ success: true, docId: doc.id, message: "Document received. Processing in background." });
    (async () => {
      try {
        const chunks = chunkText(text);
        let processed = 0;
        for (const chunk of chunks) {
          const embedding = await getEmbedding(chunk);
          await supabase.from("kb_chunks").insert({ doc_id: doc.id, doc_name: docName, category: category || "General", content: chunk, searchable_text: chunk, embedding: JSON.stringify(embedding), chunk_index: processed });
          processed++;
          await new Promise(r => setTimeout(r, 200));
        }
        await supabase.from("kb_documents").update({ status: "ready", chunk_count: processed }).eq("id", doc.id);
      } catch (bgErr) {
        await supabase.from("kb_documents").update({ status: "error" }).eq("id", doc.id);
        console.error("Background processing error:", bgErr.message);
      }
    })();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get all documents
app.get("/api/kb/documents", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from("kb_documents")
      .select("id, name, category, description, page_count, chunk_count, status, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Public, read-only KB stats/list for the knowledge_base.html page.
// Source of truth is kb_chunks (the SKILL.md-curated KB100+ system, NOT the
// legacy kb_documents PDF-upload table). Dedupes by kb_id across ALL rows —
// do not filter to chunk_index=0, since ~25 documents (KB332+) don't have a
// zero-indexed chunk and would be silently dropped.
app.get("/api/kb/public-stats", async (req, res) => {
  try {
    let allRows = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("kb_chunks")
        .select("kb_id, doc_name, category, brand, component_type, source_file, schematic_count, added_date, tags")
        .not("kb_id", "is", null)
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allRows = allRows.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    const chunkCounts = {};
    allRows.forEach(r => { chunkCounts[r.kb_id] = (chunkCounts[r.kb_id] || 0) + 1; });

    const seen = new Map();
    allRows.forEach(r => { if (!seen.has(r.kb_id)) seen.set(r.kb_id, r); });
    const entries = [...seen.values()];

    const categories = {};
    entries.forEach(e => {
      const cat = e.component_type || e.category || "uncategorized";
      categories[cat] = (categories[cat] || 0) + 1;
    });
    const brands = new Set(entries.map(e => e.brand).filter(Boolean));

    res.json({
      entries: entries
        .sort((a, b) => parseInt(a.kb_id.replace("KB","")) - parseInt(b.kb_id.replace("KB","")))
        .map(e => ({
          num: e.kb_id,
          title: e.doc_name,
          cat: e.component_type || e.category,
          brand: e.brand,
          sourceFile: e.source_file,
          schematicCount: e.schematic_count || 0,
          chunkCount: chunkCounts[e.kb_id] || 1,
          addedDate: e.added_date,
          tags: e.tags || []
        })),
      stats: {
        totalDocuments: entries.length,
        totalChunks: allRows.length,
        categories,
        manufacturers: brands.size
      }
    });
  } catch (e) {
    console.error("[KB public-stats]", e);
    res.status(500).json({ error: "Failed to load knowledge base stats" });
  }
});

// ── Get a single document's processing status (for upload-progress polling)
app.get("/api/kb/documents/:id/status", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from("kb_documents")
      .select("id, name, status, chunk_count, page_count")
      .eq("id", req.params.id)
      .single();
    if (error) return res.status(404).json({ error: "Document not found" });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Delete document
app.delete("/api/kb/documents/:id", authMiddleware, async (req, res) => {
  try {
    await supabase.from("kb_chunks").delete().eq("doc_id", req.params.id);
    await supabase.from("kb_documents").delete().eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KB Search endpoint (HTTP)
app.post("/api/kb/search", kbSearchLimiter, async (req, res) => {
  try {
    const { question, topK = 5 } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });
    const result = await searchKBInternal(question, topK);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// KB-ENHANCED CHAT — TEXT-ONLY, DEEP-THINK REASONING
// No schematic images. The AI answers using KB context + engineering logic.
// Users who want documents/schematics are directed to the Knowledge Base page.
// ══════════════════════════════════════════════════════════════════════════

// ── SMART KB ROUTING MAP ──────────────────────────────────────────────────────
// When user mentions a specific component/model, fetch those KB docs directly
// so the AI has the RIGHT technical data to answer with
const KB_ROUTE_MAP = [
  // Rexroth pumps
  { p: ['a4vg','a4vg56','a4vg71','a4vg90','a4vg125','a4vg180'],  k: ['KB116','KB117'] },
  { p: ['a10v','a10vso','a10vo'],                                  k: ['KB134'] },
  { p: ['a4vso'],                                                  k: ['KB130'] },
  { p: ['a20vlo'],                                                 k: ['KB128'] },
  { p: ['a4csg'],                                                  k: ['KB135'] },
  { p: ['a2fo'],                                                   k: ['KB129'] },
  // Rexroth motors
  { p: ['a6vm'],                                                   k: ['KB151'] },
  { p: ['mrt motor','mre motor','rexroth mrt','rexroth mre'],      k: ['KB153'] },
  // Danfoss pumps — specific first
  { p: ['series 90 motor','serie 90 motor','danfoss 90 motor'],    k: ['KB154'] },
  { p: ['series 90 pump','serie 90 pump','danfoss 90 pump'],       k: ['KB141','KB119'] },
  { p: ['series 90','serie 90','danfoss series 90','s90'],         k: ['KB141','KB119','KB154'] },
  { p: ['series 45','serie 45','danfoss 45','s45','m45'],          k: ['KB142'] },
  { p: ['series 40','serie 40','danfoss 40'],                      k: ['KB140'] },
  // Parker
  { p: ['parker f11','parker f12','f11 motor','f12 motor'],        k: ['KB124'] },
  { p: ['kawasaki k3vl'],                                          k: ['KB121'] },
  // Danfoss valves
  { p: ['pvg32','pvg 32'],                                         k: ['KB196'] },
  { p: ['pvg120','pvg 120'],                                       k: ['KB312','KB167'] },
  { p: ['pvg100','pvg 100'],                                       k: ['KB168'] },
  { p: ['pvg','danfoss pvg proportional'],                         k: ['KB196','KB312'] },
  { p: ['pve series','danfoss pve'],                               k: ['KB320'] },
  { p: ['pvres','pvrel','danfoss joystick'],                       k: ['KB311'] },
  // Rexroth valves & controls
  { p: ['rexroth we','we6 dcv','we dcv'],                         k: ['KB189'] },
  { p: ['vt-hacd','vt hacd'],                                      k: ['KB317'] },
  { p: ['vtvpcd'],                                                 k: ['KB318'] },
  { p: ['vt-varp','vt varp','varp1'],                              k: ['KB309'] },
  // Eaton / Vickers
  { p: ['counterbalance valve','cbv','vickers cbv','eaton cbv'],   k: ['KB201'] },
  // Crane manuals
  { p: ['favco','favelle'],                                        k: ['KB115'] },
  { p: ['seatrax'],                                                k: ['KB110'] },
  { p: ['macgregor','hmc2201'],                                    k: ['KB109'] },
  { p: ['nov ahc','knuckle boom'],                                 k: ['KB114'] },
  { p: ['amclyde','model 52'],                                     k: ['KB102'] },
  { p: ['braden winch','braden ch'],                               k: ['KB103','KB274'] },
  // Troubleshooting docs
  { p: ['how to solve','solve hydraulic','prevent hydraulic'],     k: ['KB281','KB282'] },
  { p: ['hydraulic troubleshooting','troubleshooting hydraulic'],  k: ['KB286','KB298'] },
  { p: ['logical troubleshooting'],                                k: ['KB108'] },
  { p: ['load sensing service','ls service manual'],               k: ['KB296'] },
  // Circuit books
  { p: ['hydraulic circuit book','circuit manual'],                k: ['KB283','KB105'] },

  // KB70 — IFPS Hydraulic Specialist Study Guide
  { p: ['hydraulic formula','pump flow formula','motor speed formula','cylinder force formula','horsepower formula','Cv formula valve','Barlow formula','tubing wall thickness','safety factor tubing','conductor velocity','inlet line velocity','return line velocity','pressure line velocity','suction line rule','accumulator sizing','isothermal accumulator','general gas law accumulator','intensifier pressure','reservoir heat','seal compatibility','nitrile seal','viton seal','polyurethane seal','silicone seal','neoprene seal','amplifier card','enable signal','command signal','ramp generator','dither generator','gain adjustment','null adjustment','proportional solenoid','viscosity too high','viscosity too low','viscosity index mobile','IFPS formula'],
    k: ['KB70'] },

  // KB69 — Zappe Valve Selection Handbook
  { p: ['valve selection','Cv Kv','flow coefficient valve','resistance coefficient valve','zeta valve','cavitation valve','cavitation index','waterhammer','water hammer','Joukowsky','valve closure pressure','check valve selection','swing check','tilting disc check','lift check','check valve closing','pressure relief valve','safety relief valve','PRV sizing','pilot operated relief','set pressure','overpressure','blowdown','built-up back pressure','3% inlet loss','discharge piping relief','balanced bellows','conventional relief valve','relief valve terminology','rupture disc'],
    k: ['KB69'] },

  // KB68 — Cundiff Fluid Power Circuits and Controls
  { p: ['ISO 4406 cleanliness','target cleanliness','cleanliness code','ISO cleanliness chart','beta ratio filter','filter efficiency','multipass filter','pressure line filter','return line filter','offline filter','non-bypass filter','filter placement','filter sizing','charge pump sizing','charge pump flow','cross port relief','shuttle valve hydrostatic','multipurpose valve','counterbalance setting','CBV setting','proportional valve dither','servo valve cleanliness','spool silting','silting valve','contamination gear pump','contamination vane pump','contamination piston pump'],
    k: ['KB68'] },

  // KB67 — Bloch Improving Machinery Reliability
  { p: ['bearing failure causes','bearing lubrication','L10 life','bearing life','anti-friction bearing','rolling element bearing','water in oil bearing','minimum viscosity bearing','ISO VG bearing','oil mist lubrication','automatic grease','manual grease','bearing temperature limit','pump condition monitor','vibration transducer','proximity probe','velocity transducer','accelerometer pump','pipe stress nozzle','piping load equipment','hot alignment','thermal growth','predictive maintenance statistics','MTBF pump','run to failure','bearing contamination','SKF bearing failure'],
    k: ['KB67'] },

  // KB66 — Vickers Logical Troubleshooting
  { p: ['logical troubleshooting','flow pressure direction','8 step procedure','algorithm test','algo test','pump cavitation FCR','aeration FCR','case drain measurement','case drain flow','pressure gauge installation','multi-symptom','common cause','multi-point selector','quick release test point','systematic fault','hit and miss','circuit diagram analysis','vickers logical','hydraulic fault isolation'],
    k: ['KB66'] },

  // KB65 — Vickers Hydraulic Hints
  { p: ['chart noise','chart heat','chart pressure','chart flow','faulty operation','pump noisy','pump heated','motor heated','fluid heated','relief valve noisy','no flow','no pressure','low pressure','erratic pressure','slow movement','no movement','erratic movement','aeration causes','seal material','viton nitrile polyurethane','hydraulic formula','pipe schedule','tubing velocity','125 psi valve setting','contamination effects','vickers hints'],
    k: ['KB65'] },

  // KB64 — Mobley Root Cause Failure Analysis
  { p: ['root cause','RCFA','fault tree','fishbone','failure mode analysis','FMEA','5 why','sequence of events','incident report','equipment failure investigation','cavitation pump','pump runout','total system head','seal failure','gearbox failure','control valve failure','packing failure','mechanical seal','why did it fail','repeat failure','recurring fault'],
    k: ['KB64'] },

  // KB63 — Cameron Hydraulic Data
  { p: ['NPSH','net positive suction','suction head','affinity law','pump speed change','impeller trim','pump power','hydraulic horsepower','brake horsepower','unit conversion hydraulic','psi to bar','bar to psi','gpm to lpm','lpm to gpm','velocity head','reynolds pump','pump head pressure','cameron hydraulic','head calculation'],
    k: ['KB63'] },

  // KB62 — Mobley Predictive Maintenance
  { p: ['oil analysis','oil sample','wear particle','ferrograph','spectrograph','vibration analysis','vibration monitoring','case drain temperature','case drain flow','bearing frequency','gear mesh frequency','vane pass','imbalance','misalignment vibration','thermography','infrared hydraulic','P-F curve','predictive maintenance','condition monitoring','BPFO','BPFI','TAN','TBN','ISO 4406 hydraulic','iron content oil','silicon content oil','copper oil','rubbing wear','cutting wear','rolling fatigue','oil sampling','lube oil','hydraulic oil analysis'],
    k: ['KB62'] },

  // KB61 — Albers Motion Control Offshore and Dredging
  { p: ['heave compensation','heave compensator','AHC','PHC','passive heave','active heave','riser tensioner','drill pipe compensator','secondary drive','primary drive','open loop winch','closed loop winch','winch motor free fall','winch runaway','subsea hydraulic','subsea drive','nitrogen accumulator','crane gas spring','motion reference unit','MRU','feed forward control','CETOP sizing','CBV setting 130','pilot ratio','asymmetric spool','offshore winch','offshore drive design','motion control offshore'],
    k: ['KB61'] },

  // KB60 — Hehn Fluid Power Troubleshooting
  { p: ['system inoperative','no flow','erratic operation','operates slowly','system slow','no drive','pump no pressure','pump dead','valve sticking','spool stuck','relief chattering','water hammer','milky oil','oil foaming','aeration','air in system','contamination fault','filter bypass','troubleshooting guide','servo valve fault','proportional fault','dither','gain setting'],
    k: ['KB60'] },

  // KB58 — Idelchik Hydraulic Resistance Handbook
  { p: ['pressure drop','pressure loss','idelchik','hydraulic resistance','friction factor','pipe sizing','orifice sizing','discharge coefficient','resistance coefficient','bend loss','elbow loss','pipe loss','fitting loss','manifold pressure','tee resistance','valve resistance coefficient','darcy','weisbach','reynolds number','flow velocity','pipe bore','line sizing'],
    k: ['KB58'] },

  // KB71-75 — Rexroth Hydraulic Trainer Vol.1-4, Vol.6
  { p: ['rexroth trainer','hydraulic trainer vol','basic principles hydraulic','hydrostatics hydrodynamics','pascal law','fluid power fundamentals','hydraulic fundamentals'],
    k: ['KB71'] },
  { p: ['proportional valve technology','servo valve technology','torque motor','flapper nozzle','LVDT spool','proportional amplifier','dither frequency','ramp generator amplifier','enable signal amplifier','gain adjustment amplifier','null adjustment','proportional solenoid','hysteresis valve','valve lap','overlap underlap critical centre'],
    k: ['KB72'] },
  { p: ['hydraulic system design','planning hydraulic','system pressure selection','marine crane pressure','deck crane pressure','heat exchanger sizing','pipe velocity hydraulic','Barlow formula wall thickness','offshore material selection','HVOF cylinder','hard chrome cylinder','pipe bore calculation','noise control hydraulic'],
    k: ['KB73'] },
  { p: ['logic element','cartridge valve','2-way cartridge','DIN 24342','poppet valve','logic element area ratio','control cover','logic element size','logic element flow'],
    k: ['KB74'] },
  { p: ['secondary control','secondary unit','four quadrant motor','impressed pressure rail','energy recovery hydraulic','accumulator winch drive','secondary HST','torque control secondary','speed control secondary'],
    k: ['KB75'] },

  // KB76 — Zhang & Qin Basics of Hydraulic Systems
  { p: ['orifice equation','orifice flow','discharge coefficient','continuity equation','bernoulli hydraulic','corner power','differential extension cylinder','double rod cylinder equal speed','cylinder cushion'],
    k: ['KB76'] },

  // KB77 — Cundiff Fluid Power Circuits
  { p: ['meter in meter out','bleed off circuit','regenerative circuit','pressure intensifier','closed circuit HST fault','flushing valve HST','charge pump closed loop','oil oxidation temperature','water contamination hydraulic','oil analysis program','servo valve null','servo valve bandwidth','proportional closed loop LVDT'],
    k: ['KB77'] },

  // KB78 — Cylinder Calculation Reference
  { p: ['piston rod load capacity','barrel wall thickness','Lame equation','cylinder barrel thickness','oil volume cylinder','cylinder length formula','CK45 piston rod','42CrMo4 cylinder','hard chrome plating thickness','HVOF coating offshore','chrome plating specification','cylinder material selection'],
    k: ['KB78'] },

  // KB79 — Blackburn Fluid Power Control MIT Press
  { p: ['valve flow equation','Kq flow gain','Kc pressure flow coefficient','hydraulic natural frequency','bulk modulus hose','effective bulk modulus','closed loop stability hydraulic','phase margin hydraulic','gain margin hydraulic','velocity constant Kv','leakage formula spool','laminar gap leakage','servo system bandwidth'],
    k: ['KB79'] },

  // KB80 — Verschoof Cranes Design Practice Maintenance
  { p: ['hoisting motor power','slewing motor power','luffing motor power','slewing torque calculation','slew bearing friction','wind load crane','FEM crane classification','FEM 1001','mechanism group','Hagglunds hydraulic drive','crane motor power calculation','slewing resistance'],
    k: ['KB80'] },

  // KB81 — DNVGL-ST-0378 Offshore Cranes
  { p: ['DNV ST 0378','DNVGL-ST-0378','offshore crane standard','dynamic factor offshore crane','MOPS crane','AOPS crane','hydraulic pressure test 1.5','2 second response crane','minimum slewing speed','DNV hydraulic requirements','offshore crane safety','overload protection crane','SWL dynamic factor'],
    k: ['KB81'] },

  // KB82 — ISO 4413
  { p: ['ISO 4413','hydraulic system rules','circuit diagram requirements','reservoir design ISO','seal compatibility ISO','hydraulic colour coding','pressure line colour','return line colour'],
    k: ['KB82'] },

  // KB83 — Shapiro Cranes and Derricks
  { p: ['crane stability','overturning moment','tipping fulcrum','stability ratio','line pull reeving','reeving efficiency','load chart crane','boom compression strut','pivot pin shear','slewing ring loads','sheave minimum diameter','crane load moment','load moment crane'],
    k: ['KB83'] },

  // KB84 — Flitney Seals and Sealing Handbook
  { p: ['NBR seal','FKM seal','Viton seal','EPDM seal','polyurethane seal','nitrile rubber','fluorocarbon seal','seal material compatibility','O-ring selection','O-ring groove','backup ring','extrusion gap','piston seal','rod seal','wiper seal','scraper seal','lip seal rotary','seal surface finish','elastomer temperature'],
    k: ['KB84'] },

  // KB85 — AISI Wire Rope Users Manual
  { p: ['wire rope construction','wire rope design factor','wire rope discard','broken wire discard','wire rope inspection','sheave drum ratio','D/d ratio wire rope','wire rope lubrication','wire rope fatigue','IWRC wire rope','6x19 wire rope','6x37 wire rope','rotation resistant rope','wire rope strength loss','fleet angle drum'],
    k: ['KB85'] },

  // KB86 — Handbook of Rigging
  { p: ['sling angle tension','sling tension formula','choker hitch','basket hitch','rigging sling','dynamic impact load','centre of gravity lift','shackle selection','bow shackle','D shackle','hook inspection','pad eye','lift planning','offshore lift','spreader bar','rigging hardware','grade 8 shackle'],
    k: ['KB86'] },
];

async function getKbContextForQuestion(question, topK, docId) {
  // Scoped mode: restrict entirely to one uploaded document's chunks, bypassing
  // KB_ROUTE_MAP and whole-KB keyword search. Not cached by question text since
  // the scope (docId) is the dominant filter, not the question wording.
  if (docId) {
    const { data, error } = await supabase
      .from("kb_chunks")
      .select("id, doc_id, doc_name, category, brand, component_type, content, searchable_text, tags")
      .eq("doc_id", docId)
      .order("chunk_index", { ascending: true });
    if (error) {
      console.error('KB scoped fetch error:', error.message);
      return { chunks: [], found: false, source: 'scoped' };
    }
    // Fall back to `content` for older rows inserted before searchable_text was populated.
    const normalized = (data || []).map(c => ({
      ...c,
      searchable_text: c.searchable_text || c.content || '',
    }));
    return { chunks: normalized, found: normalized.length > 0, source: 'scoped' };
  }

  const cacheKey = kbCacheKey(question);
  const cached = kbCacheGet(cacheKey);
  if (cached) {
    console.log(`KB cache HIT: "${question.slice(0,50)}"`);
    return cached;
  }

  const q = question.toLowerCase();

  // 1. Try direct KB routing by component/model name
  for (const entry of KB_ROUTE_MAP) {
    if (entry.p.some(p => q.includes(p))) {
      const idFilter = entry.k.map(id => `kb_id.eq.${id}`).join(',');
      const { data } = await supabase
        .from("kb_chunks")
        .select("kb_id, doc_name, category, brand, component_type, searchable_text, schematic_count")
        .or(idFilter);
      if (data && data.length > 0) {
        console.log(`KB route hit: ${entry.p[0]} → ${data.map(d=>d.doc_name.slice(0,25)).join(', ')}`);
        const result = { chunks: data, found: true, source: 'direct' };
        kbCacheSet(cacheKey, result);
        return result;
      }
      break;
    }
  }

  // 2. Fallback: general keyword search
  const result = await searchKBInternal(question, topK);
  kbCacheSet(cacheKey, result);
  return result;
}

app.post("/api/kb/chat", chatLimiter, validateKBChatRequest, softIdentify, checkDailyQueryLimit, async (req, res) => {
  try {
    const { question, history = [], system, answerPolicy = {}, docId } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });

    const q_lower = question.toLowerCase();
    console.log(`Query: "${question.slice(0,70)}"${docId ? ` [scoped to doc ${docId}]` : ''}`);

    // ── FETCH RELEVANT KB CONTEXT ─────────────────────────────────────────
    const kbResult = await getKbContextForQuestion(question, 5, docId);
    // When scoped to a specific user-uploaded document, skip the generic/brand
    // gate entirely — the user explicitly chose this document, so brand-specific
    // content from it is exactly what they're asking for, not a leak.
    const relevance = docId
      ? { chunks: kbResult.chunks || [], found: kbResult.found, generic: false }
      : filterRelevantKbChunks(question, kbResult.chunks || []);
    const chunks = relevance.chunks;
    const found = relevance.found;
    const genericQuestion = relevance.generic;


    let kbContext = "";

    if (found && chunks.length > 0) {
      kbContext = "\n\n--- RELEVANT KNOWLEDGE BASE CONTEXT ---\n";
      if (genericQuestion) {
        kbContext += "\nGENERIC QUESTION BRAND GATE ACTIVE:\n";
        kbContext += "- User did not specify manufacturer/model.\n";
        kbContext += "- Do not mention any brand, model, manual title, example model, or brand-specific load/pressure value from the KB.\n";
        kbContext += "- Use the KB only to shape a brand-neutral engineering procedure.\n";
        kbContext += "- For exact values, tell user to use the applicable OEM test sheet/manual.\n";
      }
      chunks.forEach(c => {
        const rawText = (c.searchable_text || '').substring(0, 1800);
        const text = genericQuestion ? sanitizeGenericKbText(rawText) : rawText;
        const sourceTitle = genericQuestion ? genericKbTitle(c) : `${c.category} — ${c.doc_name}`;
        const brand = genericQuestion ? '' : (c.brand ? ' | Brand: '+c.brand : '');
        kbContext += `\n[${sourceTitle}]${brand} | Relevance: ${c.relevanceScore}\n${text}\n`;
      });

      // Determine answer type and give the AI the right instruction
      const isFaultQ = /\b(why|fault|not working|chattering|slow|leak|noise|hot|overheat|no pressure|low pressure|stuck|not build|not shift|vibrat|alarm|trip|fail|drift|surge|hunt|cavitat)\b/.test(q_lower);
      const isCraneCircuit = /\b(hoist|luffing|slew|slewing|crane circuit|winch circuit)\b/.test(q_lower) && /\b(explain|circuit|how|describe)\b/.test(q_lower);
      const isDatasheet = /\b(datasheet|data sheet|specification|technical data|performance curve|displacement|speed range|torque|pressure rating)\b/.test(q_lower);
      const isProcedureQ = /\b(how|procedure|perform|test|commission|workshop|service|stall|load test|acceptance)\b/.test(q_lower);

      if (isFaultQ) {
        kbContext += `--- END KB CONTEXT ---

FAULT DIAGNOSIS PROTOCOL:
1. State the SINGLE most likely root cause based on symptoms + engineering reasoning
2. Give the physical explanation (why does this cause that symptom?)
3. List 2-3 alternative causes in order of likelihood
4. End with: "Do you want me to walk you through the step-by-step diagnostic procedure?"
DO NOT list every possible cause. Be specific. Be direct.`;
      } else if (isCraneCircuit) {
        kbContext += `--- END KB CONTEXT ---

CRANE CIRCUIT EXPLANATION:
Provide a clear technical explanation of how this crane hydraulic circuit works:
1. Main components (pump type, motor type, DCV, counterbalance valve, brake valve)
2. Flow path for the WORK stroke (e.g. hoisting)
3. Flow path for the RETURN/LOWER stroke
4. Safety functions: CBV setting, brake release sequence
5. Typical operating pressures
Reference the OEM manual in KB if available. Be specific and technical.`;
      } else if (isDatasheet) {
        kbContext += `--- END KB CONTEXT ---

DATASHEET RESPONSE:
Present the key technical specifications from the KB context clearly:
- Displacement range, pressure ratings, speed range
- Control options available
- Key application notes
If the user wants to view full drawings, direct them to the Knowledge Base:
"→ View the full manual in the HydroMind Knowledge Base"`;
      } else if (isProcedureQ) {
        kbContext += `--- END KB CONTEXT ---

PROCEDURE RESPONSE:
Answer only the requested procedure. Do not add unrelated service checks.
If the user did not provide maker/model, keep the answer manufacturer-neutral. Do not mention Braden, CH series, or any other specific maker/model/manual from KB context.
Use this structure:
1. Safety controls
2. Objective of the test
3. Required workshop setup and instruments
4. Step-by-step hydraulic/mechanical procedure
5. Acceptance checks
6. Stop-test conditions
7. Records/DPR entries
If exact OEM values are not present, state that values must be taken from the OEM test sheet/manual.`;
      } else {
        kbContext += `--- END KB CONTEXT ---

Provide a complete, specific technical answer using the KB context above.
Reference OEM model numbers, pressure values, and specific settings where available.
If full document pages are needed, mention: "→ Full manual available in the HydroMind Knowledge Base"`;
      }
    } else {
      // No KB match — use pure engineering knowledge
      kbContext = `\n\n--- NO EXACT KB MATCH ---\nNo exact KB match found. Answering from hydraulic engineering practice.
Do not invent OEM-specific values, model names, manual names, or brand details. If exact values are required, tell the user to verify the OEM manual/test sheet.`;
    }

    const policyContext = `\n\n--- CLIENT ANSWER POLICY ---\nStrict relevance: ${answerPolicy.strictRelevance !== false}\nAllow engineering fallback: ${answerPolicy.allowEngineeringFallback !== false}\nAnswer domain: ${answerPolicy.domain || 'marine_offshore_hydraulics'}\n`;
    const enhancedSystem = [
      HYDROMIND_ADVISOR_SYSTEM,
      system || "",
      policyContext,
      kbContext,
    ].join("\n");
    const messages = [...history, { role: "user", content: question }];

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1200,
        system: enhancedSystem,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Anthropic error:", JSON.stringify(data));
      return res.status(response.status).json({ error: data });
    }

    // Success — now safe to count this as a used query for today.
    await incrementDailyQueryUsage(req);

    // Always return empty schematics — AI Advisor is text-only
    // Full manuals/schematics are available in the Knowledge Base
    res.json({
      ...data,
      kbUsed: found,
      kbChunkCount: chunks.length,
      kbRelevanceScore: relevance.bestScore,
      kbWeakMatch: !found && (kbResult.chunks || []).length > 0,
      schematics: [],
      schematicMode: 'text',
      queriesRemainingToday: (req.user && (req.user.isAdmin || req.user.plan === "Pro" || req.user.plan === "Enterprise" || req.user.plan === "Admin"))
        ? null  // null = unlimited, frontend renders as infinity symbol
        : (typeof req.queriesRemainingToday === "number" ? req.queriesRemainingToday : null)
    });
  } catch (e) {
    console.error("kb/chat error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// CIRCUIT ANALYZE — Real AI explanation of uploaded schematic image
// POST /api/kb/circuit-analyze
// Body (multipart/form-data):
//   schematic   — image file (PNG/JPG/WEBP) — optional
//   equipment   — e.g. "Crane Winch"
//   oem         — e.g. "Liebherr LR 1600"
//   pumpType    — e.g. "LS variable displacement pump"
//   pilotConfig — e.g. "Load-sensing derived"
//   issue       — e.g. "Load drift during hold" (optional)
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/kb/circuit-analyze", generalLimiter, upload.single("schematic"), async (req, res) => {
  try {
    const { equipment, oem, pumpType, pilotConfig, issue } = req.body;
    if (!equipment) {
      return res.status(400).json({ error: "Equipment type is required" });
    }
    if (!req.file && (!pumpType || !pilotConfig)) {
      return res.status(400).json({ error: "Without a schematic image, pump system and pilot configuration are required so the AI has something to analyse." });
    }

    const knownFields = [];
    const pumpTypeKnown = pumpType && !/^(no|none|n\/a|don'?t know|unknown|not sure)$/i.test(pumpType.trim());
    const pilotKnown = pilotConfig && !/^(no|none|n\/a|don'?t know|unknown|not sure)$/i.test(pilotConfig.trim());

    knownFields.push(`Equipment type: ${equipment}`);
    if (oem) knownFields.push(`OEM / Model: ${oem}`);
    knownFields.push(pumpTypeKnown
      ? `Pump system (user-reported): ${pumpType}`
      : `Pump system: NOT SPECIFIED by user — identify from the schematic's ISO symbols.`);
    knownFields.push(pilotKnown
      ? `Pilot circuit configuration (user-reported): ${pilotConfig}`
      : `Pilot circuit configuration: NOT SPECIFIED by user — identify from the schematic's pilot line routing.`);
    if (issue) knownFields.push(`Known issue / symptom: ${issue}`);

    const circuitContext = knownFields.join("\n");

    // Pull relevant KB chunks — only use pump type in the search if the user actually knows it
    const kbQuestion = `${equipment} ${oem || ""} ${pumpTypeKnown ? pumpType : ""} hydraulic circuit pilot system`;
    const kbResult = await getKbContextForQuestion(kbQuestion, 4, null);
    let kbContext = "";
    const kbRefs = [];
    if (kbResult.found && kbResult.chunks.length > 0) {
      kbResult.chunks.forEach(c => {
        kbContext += `\n[${c.category} — ${c.doc_name}] KB-ID: ${c.kb_id}\n${(c.searchable_text || "").substring(0, 1200)}\n`;
        if (c.kb_id) kbRefs.push(c.kb_id);
      });
    }

    // Build Claude message parts
    const userContentParts = [];
    if (req.file) {
      const allowed = ["image/png","image/jpeg","image/jpg","image/webp"];
      if (!allowed.includes(req.file.mimetype)) {
        return res.status(400).json({ error: "Schematic must be PNG, JPG, or WEBP. Convert PDF pages to image first." });
      }
      if (req.file.size > 5 * 1024 * 1024) {
        return res.status(400).json({ error: "Schematic image must be under 5 MB" });
      }
      const mediaType = req.file.mimetype === "image/jpg" ? "image/jpeg" : req.file.mimetype;
      userContentParts.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: req.file.buffer.toString("base64") }
      });
      userContentParts.push({
        type: "text",
        text: `I have uploaded a hydraulic schematic diagram above.\n\nCircuit context:\n${circuitContext}\n\n${kbContext ? "KB Reference context:\n" + kbContext : ""}\n\nPlease analyse the schematic and explain how this circuit works.`
      });
    } else {
      userContentParts.push({
        type: "text",
        text: `No schematic image was uploaded. Based on the circuit details below, explain how this hydraulic circuit works.\n\nCircuit context:\n${circuitContext}\n\n${kbContext ? "KB Reference context:\n" + kbContext : ""}`
      });
    }

    // Pass kbRefs in the user message (not in system schema) to avoid broken template interpolation
    const kbRefsNote = kbRefs.length > 0
      ? '\n\nKB document IDs matched for this query: ' + JSON.stringify(kbRefs) + '. Include these in the "kbRefs" array of your JSON response.'
      : '\n\nNo KB documents matched. Return [] for "kbRefs".';
    if (userContentParts.length > 0) {
      const last = userContentParts[userContentParts.length - 1];
      if (last.type === 'text') last.text += kbRefsNote;
    }

    const systemPrompt = `You are HydroMind AI, a senior marine and offshore hydraulic systems engineer specialising in crane and deck machinery hydraulics.

Your task: analyse the hydraulic circuit and explain clearly and precisely how it works.

WHEN A SCHEMATIC IMAGE IS PROVIDED, your primary job is symbol-level reading of the actual diagram — do not rely on the user's text fields for this. Specifically:
- Count every pump symbol. For each pump, determine fixed vs. variable displacement from its ISO 1219 symbol (variable displacement pumps show a diagonal arrow through the circle; fixed displacement do not).
- Determine whether each variable pump is load-sensing (LS), pressure-compensated, or a simple proportional/manual control, by tracing the pilot/compensator line routing back from the directional control valve(s) to the pump's control piston — not by assuming from the user's text.
- Classify every visible line by function — main pressure/working line, return/tank line, pilot/signal line, drain line — based on standard line-weight/style conventions and where each line actually connects (pump outlet, valve ports, actuator ports, tank).
- If the user's text fields say the pump type or pilot configuration is unknown/not specified, you MUST determine these from the image and report them as "identified from schematic" rather than leaving them blank.
- If a component or line is genuinely ambiguous in the image (poor resolution, obscured, cut off), say so explicitly rather than guessing silently.

Return ONLY a single valid JSON object. No markdown fences, no preamble, no trailing text — your entire response must be parseable JSON:
{
  "circuitName": "Short descriptive name for this circuit",
  "explanation": "Plain-language paragraph explaining what this circuit does, why it exists, and the key design intent",
  "pumpAnalysis": [
    { "pumpLabel": "e.g. P1 or Main Pump", "displacementType": "Fixed | Variable", "controlType": "e.g. Load-sensing (LS) | Pressure-compensated | Manual proportional | Not determinable", "identifiedFrom": "schematic symbol | user input | not specified — assumed typical" }
  ],
  "lineIdentification": [
    { "lineType": "Pressure/Working | Return | Pilot/Signal | Drain", "path": "e.g. Pump P1 outlet to DCV1 port P", "notes": "Anything notable about this line's role" }
  ],
  "pressurePath": [
    { "step": 1, "component": "Component name", "description": "What happens here and why it matters", "typicalPressure": "e.g. 250 bar or per OEM manual" }
  ],
  "normalValues": [
    { "point": "Test point label", "range": "e.g. 40-60 bar", "meaning": "What this pressure indicates about circuit health" }
  ],
  "failureModes": [
    { "symptom": "Observable fault symptom", "cause": "Root cause in the circuit", "diagnosticTest": "Step-by-step field test to confirm this fault" }
  ],
  "safetyNotes": "Critical safety requirements for this circuit: LOTO, accumulator discharge, suspended load hazards, hot oil",
  "kbRefs": []
}

STRICT RULES:
1. If a schematic image is provided: identify ACTUAL components visible, trace REAL flow paths. If a component is unclear in the image, say so in the description. This applies even more strongly to pumpAnalysis and lineIdentification — these must reflect the actual image, not generic assumptions.
2. If no image: answer from engineering knowledge and KB context only, and pumpAnalysis/lineIdentification should note "based on user-reported configuration, no schematic provided".
3. Never invent specific OEM pressure values unless they appear in KB context or the user provided them. Use "per OEM manual" or "typical — verify with OEM".
4. pressurePath: 3-7 steps. normalValues: 3-6 entries. failureModes: 2-5 entries. pumpAnalysis: one entry per distinct pump visible. lineIdentification: cover the main functional lines relevant to explaining the circuit, not every single line segment.
5. Be concise and field-practical — no textbook padding.
6. Copy the kbRefs array provided in the user message into your response.`;

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: "user", content: userContentParts }]
      })
    });

    const claudeData = await claudeResp.json();
    if (!claudeResp.ok) {
      console.error("[circuit-analyze] Claude error:", JSON.stringify(claudeData));
      return res.status(502).json({ error: "AI service error — please retry" });
    }

    let rawText = (claudeData.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();
    // Strip any accidental markdown fences
    rawText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    // If preamble before JSON, extract from first { to last }
    const jsonStart = rawText.indexOf("{");
    const jsonEnd   = rawText.lastIndexOf("}");
    if (jsonStart > 0 && jsonEnd > jsonStart) rawText = rawText.slice(jsonStart, jsonEnd + 1);

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error("[circuit-analyze] JSON parse error:", parseErr.message, rawText.substring(0, 300));
      return res.status(502).json({ error: "AI returned unparseable response — please retry", raw: rawText.substring(0, 300) });
    }

    return res.json({
      ok:            true,
      circuitName:   parsed.circuitName   || "Hydraulic Circuit",
      explanation:   parsed.explanation   || "",
      pumpAnalysis:  parsed.pumpAnalysis  || [],
      lineIdentification: parsed.lineIdentification || [],
      pressurePath:  parsed.pressurePath  || [],
      normalValues:  parsed.normalValues  || [],
      failureModes:  parsed.failureModes  || [],
      safetyNotes:   parsed.safetyNotes   || "",
      kbRefs:        parsed.kbRefs        || kbRefs,
      imageProvided: !!req.file
    });

  } catch (e) {
    console.error("[circuit-analyze] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// CIRCUIT FOLLOW-UP — answer a specific question about a previously-analysed
// circuit. The browser re-sends the SAME schematic image (held in memory
// client-side for the session, never stored server-side) plus the prior
// analysis JSON as context, so the model doesn't have to re-derive the whole
// circuit from scratch for every follow-up question.
// POST /api/kb/circuit-followup
// Body (multipart/form-data):
//   schematic        — the same image file from the original analysis (optional but recommended)
//   previousAnalysis — JSON string of the prior /circuit-analyze response (optional)
//   circuitContext   — JSON string of { equipment, oem, pumpType, pilotConfig } (optional)
//   question         — required, e.g. "How does the main hoist circuit work?"
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/kb/circuit-followup", generalLimiter, upload.single("schematic"), async (req, res) => {
  try {
    const { question, previousAnalysis, circuitContext } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: "question is required" });
    }

    let contextParts = [];
    if (circuitContext) {
      try {
        const ctx = JSON.parse(circuitContext);
        contextParts.push(`Original circuit context: ${JSON.stringify(ctx)}`);
      } catch { /* ignore malformed context, not fatal */ }
    }
    if (previousAnalysis) {
      try {
        const prev = JSON.parse(previousAnalysis);
        contextParts.push(`Prior analysis of this same circuit (for consistency — refer back to this rather than re-deriving from scratch unless the image contradicts it):\n${JSON.stringify(prev, null, 2).substring(0, 3000)}`);
      } catch { /* ignore malformed prior analysis */ }
    }

    const userContentParts = [];
    if (req.file) {
      const allowed = ["image/png","image/jpeg","image/jpg","image/webp"];
      if (!allowed.includes(req.file.mimetype)) {
        return res.status(400).json({ error: "Schematic must be PNG, JPG, or WEBP." });
      }
      if (req.file.size > 5 * 1024 * 1024) {
        return res.status(400).json({ error: "Schematic image must be under 5 MB" });
      }
      const mediaType = req.file.mimetype === "image/jpg" ? "image/jpeg" : req.file.mimetype;
      userContentParts.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: req.file.buffer.toString("base64") }
      });
    }
    userContentParts.push({
      type: "text",
      text: `${contextParts.join("\n\n")}\n\nQuestion about this specific circuit: ${question.trim()}\n\nAnswer directly and specifically about THIS circuit — trace the actual components and lines relevant to the question. If the question asks about a mode/function not clearly shown in the image or prior analysis, say so rather than guessing.`
    });

    const followupSystemPrompt = `You are HydroMind AI, a senior marine and offshore hydraulic systems engineer. You previously analysed a hydraulic schematic for this user. They now have a specific follow-up question about that same circuit.

Answer in plain, field-practical language — not JSON, just a clear direct answer. Reference specific components, valves, and line paths from the schematic/prior analysis where relevant. If the question involves a mode change (e.g. switching from normal to man-lift operation), trace exactly which valve/pilot signal changes and what that does to flow/pressure. If something isn't determinable from what you have, say so plainly rather than inventing detail. Keep it focused — answer the question asked, don't repeat the full circuit walkthrough unless asked to.`;

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        system: followupSystemPrompt,
        messages: [{ role: "user", content: userContentParts }]
      })
    });

    const claudeData = await claudeResp.json();
    if (!claudeResp.ok) {
      console.error("[circuit-followup] Claude error:", JSON.stringify(claudeData));
      return res.status(502).json({ error: "AI service error — please retry" });
    }

    const answer = (claudeData.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    return res.json({ ok: true, answer });
  } catch (e) {
    console.error("[circuit-followup] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── FEEDBACK ENDPOINT ─────────────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  try {
    const { msg_id, vote, question, answer, mode, timestamp } = req.body;
    if (!msg_id || !vote) return res.status(400).json({ error: 'msg_id and vote required' });
    const { error } = await supabase.from('ai_feedback').insert({
      msg_id, vote, question: (question||'').substring(0,500),
      answer: (answer||'').substring(0,500), mode: mode||'hyd',
      created_at: timestamp || new Date().toISOString()
    });
    if (error) { console.error('Feedback insert error:', error.message); }
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false }); // silent — non-critical
  }
});

// ── CONTACT FORM ENDPOINT ─────────────────────────────────────────────────
// Receives feedback form submissions, saves to Supabase + emails via Resend
app.post('/api/contact', generalLimiter, async (req, res) => {
  try {
    const { name, email, role, topic, rating, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email and message are required' });
    }

    // 1. Save to Supabase (always — works even without Resend)
    const { error: dbError } = await supabase.from('contact_submissions').insert({
      name: name.substring(0, 100),
      email: email.toLowerCase().trim().substring(0, 200),
      role: (role || 'Not specified').substring(0, 100),
      topic: (topic || 'General').substring(0, 100),
      rating: (rating || 'Not rated').substring(0, 20),
      message: message.substring(0, 2000),
      created_at: new Date().toISOString()
    });
    if (dbError) {
      // Table may not exist yet — log but don't fail
      console.warn('Contact Supabase insert (non-critical):', dbError.message);
    }

    // 2. Send email via Zoho SMTP
    await sendEmail({
      to: process.env.ZOHO_USER, // support@hydromindai.com
      replyTo: email,
      subject: `[HydroMind Feedback] ${topic || 'General'} — ${rating || 'No rating'} from ${name}`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#060d11;color:#e8f4ff;padding:32px;max-width:560px;margin:0 auto;border:1px solid #1b2d40;border-radius:10px;">
          <h2 style="color:#22d3ee;margin:0 0 20px;">HydroMind<span style="color:#fff">.AI</span> — Feedback</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:8px 12px;color:#7d909c;width:110px;">From</td><td style="padding:8px 12px;font-weight:700;">${name}</td></tr>
            <tr style="background:rgba(255,255,255,0.03)"><td style="padding:8px 12px;color:#7d909c;">Email</td><td style="padding:8px 12px;"><a href="mailto:${email}" style="color:#22d3ee;">${email}</a></td></tr>
            <tr><td style="padding:8px 12px;color:#7d909c;">Role</td><td style="padding:8px 12px;">${role || 'Not specified'}</td></tr>
            <tr style="background:rgba(255,255,255,0.03)"><td style="padding:8px 12px;color:#7d909c;">Topic</td><td style="padding:8px 12px;">${topic || 'General'}</td></tr>
            <tr><td style="padding:8px 12px;color:#7d909c;">Rating</td><td style="padding:8px 12px;">${rating || 'Not rated'}</td></tr>
          </table>
          <div style="margin-top:20px;padding:16px;background:rgba(34,211,238,0.05);border:1px solid rgba(34,211,238,0.15);border-radius:6px;">
            <div style="font-size:11px;color:#7d909c;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;">Message</div>
            <div style="font-size:14px;line-height:1.6;white-space:pre-wrap;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          </div>
          <p style="margin-top:16px;font-size:11px;color:#4a5568;">Submitted via HydroMind.AI feedback form</p>
        </div>
      `
    });

    res.json({ success: true, message: 'Thank you for your feedback!' });
  } catch (e) {
    console.error('Contact endpoint error:', e.message);
    res.status(500).json({ error: 'Failed to submit feedback. Please try again.' });
  }
});

// HydroMind KB Upload Webhook
async function revenuecatWebhookHandler(req, res) {
  try {
    const event = req.body.event;
    if (!event) return res.status(400).send('Missing event payload');

    const appUserId = event.app_user_id;
    const entitlements = event.entitlement_ids || [];
    const eventType = event.type;

    const grantsPremium = entitlements.includes('pro') || entitlements.includes('enterprise');

    switch (eventType) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'UNCANCELLATION':
      case 'PRODUCT_CHANGE': {
        const { error } = await supabase
          .from('users')
          .update({ is_premium: grantsPremium })
          .eq('id', appUserId);
        if (error) console.error('Supabase update failed (purchase event):', error);
        break;
      }
      case 'CANCELLATION':
      case 'EXPIRATION': {
        const { error } = await supabase
          .from('users')
          .update({ is_premium: false })
          .eq('id', appUserId);
        if (error) console.error('Supabase update failed (cancellation/expiration):', error);
        break;
      }
      case 'BILLING_ISSUE':
        console.warn(`Billing issue for user ${appUserId}`);
        break;
      default:
        console.log(`Unhandled RevenueCat event type: ${eventType}`);
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('RevenueCat webhook error:', err);
    return res.status(500).send('Internal error');
  }
}

app.post('/webhook/revenuecat', enforceRevenueCatWebhook, revenuecatWebhookHandler);

app.post('/webhook/kb-upload', enforceWebhookSecret, async function(req, res) {
  try {
    var record = (req.body && req.body.record) ? req.body.record : {};
    var docId = record.id;
    var docName = record.name ? record.name : ('Document_' + docId);
    if (!docId) { return res.status(400).json({ error: 'No document record' }); }
    console.log('[KB-SYNC] Received: ' + docName);
    res.json({ status: 'accepted', document: docName });
    setImmediate(function() { triggerKbSync(docId, docName, record); });
  } catch(e) {
    console.error('[KB-SYNC] Route error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

async function triggerKbSync(docId, docName, record) {
  try {
    console.log('[KB-SYNC] Starting sync for: ' + docName);
    var sampleText = record.content ? record.content : '';

    if (!sampleText) {
      console.log('[KB-SYNC] Fetching chunks for doc: ' + docId);
      var chunkUrl = process.env.SUPABASE_URL + '/rest/v1/kb_chunks?doc_id=eq.' + docId + '&select=content&limit=5';
      var chunkRes = await fetch(chunkUrl, {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
        }
      });
      var chunkRows = await chunkRes.json();
      console.log('[KB-SYNC] Chunk fetch status: ' + chunkRes.status);
      sampleText = Array.isArray(chunkRows) ? chunkRows.map(function(c) { return c.content ? c.content : ''; }).join('\n\n') : '';
    }

    if (!sampleText) {
      console.log('[KB-SYNC] No content found for: ' + docName);
      return;
    }
    console.log('[KB-SYNC] Content length: ' + sampleText.length);

    var numUrl = process.env.SUPABASE_URL + '/rest/v1/kb_skill_entries?select=kb_number&order=kb_number.desc&limit=1';
    var numRes = await fetch(numUrl, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
      }
    });
    var numRows = await numRes.json();
    var kbNumber = (Array.isArray(numRows) && numRows.length > 0) ? (numRows[0].kb_number + 1) : 34;
    console.log('[KB-SYNC] Assigned KB number: ' + kbNumber);

    var today = new Date().toISOString().split('T')[0];
    var promptText = 'You are a technical writer for HydroMind AI hydraulic systems platform.\n';
    promptText += 'New document: ' + docName + '\n';
    promptText += 'KB Number: KB' + kbNumber + '\n';
    promptText += 'Sample content:\n---\n' + sampleText.slice(0, 2500) + '\n---\n';
    promptText += 'Generate ONLY this structured block, no preamble:\n';
    promptText += '**KB' + kbNumber + ' - [Short title]**\n';
    promptText += '- Document: ' + docName + '\n';
    promptText += '- Covers: [component types, models]\n';
    promptText += '- Key data: [4-6 technical values]\n';
    promptText += '- Applicable to: [crane/equipment types]\n';
    promptText += '- Cross-reference: [related KB numbers or None]\n';
    promptText += '- Indexed: ' + today + '\n';
    promptText += 'Maximum 10 lines.';

    console.log('[KB-SYNC] Calling Claude API...');
    var aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: promptText }]
      })
    });

    console.log('[KB-SYNC] Claude API status: ' + aiRes.status);
    var aiData = await aiRes.json();
    console.log('[KB-SYNC] Claude response: ' + JSON.stringify(aiData));

    var kbEntry = '';
    if (aiData && aiData.content) {
      kbEntry = aiData.content.map(function(b) { return b.text ? b.text : ''; }).join('').trim();
    }

    if (!kbEntry) {
      console.error('[KB-SYNC] Empty KB entry from Claude');
      return;
    }
    console.log('[KB-SYNC] KB entry generated, storing in Supabase...');

    var storeRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/kb_skill_entries', {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        document_id: docId,
        document_name: docName,
        kb_number: kbNumber,
        skill_entry: kbEntry,
        status: 'pending'
      })
    });
    console.log('[KB-SYNC] Supabase store status: ' + storeRes.status);
    console.log('[KB-SYNC] KB' + kbNumber + ' successfully stored for: ' + docName);

  } catch(err) {
    console.error('[KB-SYNC] triggerKbSync error: ' + err.message);
    console.error('[KB-SYNC] Stack: ' + err.stack);
  }
}
// End KB Upload Webhook

if (require.main === module) {
  app.listen(PORT, () => console.log(`HydroMind AI v5.1 running on port ${PORT}`));
}

module.exports = {
  detectUserBrandTerms,
  filterRelevantKbChunks,
  isGenericQuestion,
  sanitizeGenericKbText,
  scoreKbChunkRelevance,
};
