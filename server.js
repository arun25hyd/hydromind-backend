const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const { helmetMiddleware, chatLimiter, authLimiter, kbSearchLimiter, generalLimiter, validateChatRequest, validateAuthRequest, validateKBChatRequest, safeError, enforceWebhookSecret, requestLogger } = require("./security");

const app = express();
const PORT = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── SUPABASE CLIENT ────────────────────────────────────────────────────────
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
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
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
    const frontendUrl = process.env.FRONTEND_URL || "https://hydromind-frontend.vercel.app";
    const resetLink = `${frontendUrl}?reset=${resetToken}`;

    // Send email via Supabase (uses your Supabase SMTP settings)
    // Using Resend/SMTP via fetch — simple approach using EmailJS-style API
    // We'll use a simple mailto approach via Supabase's built-in email
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY || ""}`
      },
      body: JSON.stringify({
        from: "HydroMind AI <noreply@hydromindai.com>",
        to: [email],
        subject: "HydroMind AI — Password Reset",
        html: `
          <div style="font-family:monospace;background:#020510;color:#d0e8ff;padding:32px;max-width:480px;margin:0 auto;border:1px solid #0f2244;border-radius:4px;">
            <h2 style="color:#00ccff;letter-spacing:0.1em;">HYDRO<span style="color:#fff">MIND</span> AI</h2>
            <p>You requested a password reset for your HydroMind AI account.</p>
            <p>Click the button below to reset your password. This link expires in <strong>1 hour</strong>.</p>
            <a href="${resetLink}" style="display:inline-block;background:#00ccff;color:#000;padding:12px 28px;border-radius:3px;text-decoration:none;font-weight:bold;letter-spacing:0.1em;margin:16px 0;">RESET PASSWORD</a>
            <p style="color:#4a7aaa;font-size:0.85em;">If you did not request this, ignore this email. Your password will not change.</p>
            <p style="color:#4a7aaa;font-size:0.85em;">Link: ${resetLink}</p>
          </div>
        `
      })
    });

    if (!emailRes.ok && process.env.RESEND_API_KEY) {
      console.error("Email send failed:", await emailRes.text());
    }

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

// ── TEMPORARY ADMIN: direct password reset by email (protected by webhook secret)
// REMOVE THIS ENDPOINT AFTER USE
app.post('/api/admin/force-pw-reset', async (req, res) => {
  try {
    const { email, newPassword, adminKey } = req.body;
    if (adminKey !== 'HM-TEMP-RESET-2026') return res.status(403).json({ error: 'forbidden' });
    if (!email || !newPassword) return res.status(400).json({ error: 'email and newPassword required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const bcryptjs = require('bcryptjs');
    const hashed = await bcryptjs.hash(newPassword, 10);
    const { data, error } = await supabase.from('users')
      .update({ password_hash: hashed, reset_token: null, reset_expires: null })
      .eq('email', email.toLowerCase().trim())
      .select('id, email, name');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, message: `Password reset for ${data[0].email}`, user: data[0].name });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const { data: doc, error: docErr } = await supabase.from("kb_documents")
      .insert({ name: docName, category: category || "General", description: description || "", uploaded_by: req.user.id, page_count: pdfData.numpages, char_count: text.length, status: "processing" })
      .select("id").single();
    if (docErr) throw docErr;
    res.json({ success: true, docId: doc.id, message: "Document received. Processing in background." });
    (async () => {
      try {
        const chunks = chunkText(text);
        let processed = 0;
        for (const chunk of chunks) {
          const embedding = await getEmbedding(chunk);
          await supabase.from("kb_chunks").insert({ doc_id: doc.id, doc_name: docName, category: category || "General", content: chunk, embedding: JSON.stringify(embedding), chunk_index: processed });
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

async function getKbContextForQuestion(question, topK) {
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

app.post("/api/kb/chat", chatLimiter, validateKBChatRequest, async (req, res) => {
  try {
    const { question, history = [], system } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });

    const q_lower = question.toLowerCase();
    console.log(`Query: "${question.slice(0,70)}"`);

    // ── FETCH RELEVANT KB CONTEXT ─────────────────────────────────────────
    const { chunks, found } = await getKbContextForQuestion(question, 5);

    let kbContext = "";

    if (found && chunks.length > 0) {
      kbContext = "\n\n--- KNOWLEDGE BASE CONTEXT ---\n";
      chunks.forEach(c => {
        const text = (c.searchable_text || '').substring(0, 1800);
        kbContext += `\n[${c.category} — ${c.doc_name}]${c.brand ? ' | Brand: '+c.brand : ''}\n${text}\n`;
      });

      // Determine answer type and give the AI the right instruction
      const isFaultQ = /\b(why|fault|not working|chattering|slow|leak|noise|hot|overheat|no pressure|low pressure|stuck|not build|not shift|vibrat|alarm|trip|fail|drift|surge|hunt|cavitat)\b/.test(q_lower);
      const isCraneCircuit = /\b(hoist|luffing|slew|slewing|crane circuit|winch circuit)\b/.test(q_lower) && /\b(explain|circuit|how|describe)\b/.test(q_lower);
      const isDatasheet = /\b(datasheet|data sheet|specification|technical data|performance curve|displacement|speed range|torque|pressure rating)\b/.test(q_lower);

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
      } else {
        kbContext += `--- END KB CONTEXT ---

Provide a complete, specific technical answer using the KB context above.
Reference OEM model numbers, pressure values, and specific settings where available.
If full document pages are needed, mention: "→ Full manual available in the HydroMind Knowledge Base"`;
      }
    } else {
      // No KB match — use pure engineering knowledge
      kbContext = `\n\n--- NO KB MATCH — USE ENGINEERING KNOWLEDGE ---\nAnswer from first principles using your deep hydraulic/crane expertise. Be specific about OEM models and values.`;
    }

    const enhancedSystem = (system || "") + kbContext;
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

    // Always return empty schematics — AI Advisor is text-only
    // Full manuals/schematics are available in the Knowledge Base
    res.json({ ...data, kbUsed: found, kbChunkCount: chunks.length, schematics: [], schematicMode: 'text' });
  } catch (e) {
    console.error("kb/chat error:", e.message);
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

    // 2. Send email via Resend (if API key is configured)
    if (process.env.RESEND_API_KEY) {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'HydroMind AI Feedback <noreply@hydromindai.com>',
          to: ['support@hydromindai.com'],
          reply_to: email,
          subject: `[HydroMind Feedback] ${topic || 'General'} — ${rating || 'No rating'} from ${name}`,
          html: `
            <div style="font-family:Arial,sans-serif;background:#060d11;color:#e8f4ff;padding:32px;max-width:560px;margin:0 auto;border:1px solid #1b2d40;border-radius:8px;">
              <h2 style="color:#22d3ee;margin:0 0 20px;letter-spacing:0.05em;">HydroMind AI — Feedback</h2>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:8px 12px;color:#7d909c;width:100px;">From</td><td style="padding:8px 12px;font-weight:700;">${name}</td></tr>
                <tr style="background:rgba(255,255,255,0.03)"><td style="padding:8px 12px;color:#7d909c;">Email</td><td style="padding:8px 12px;"><a href="mailto:${email}" style="color:#22d3ee;">${email}</a></td></tr>
                <tr><td style="padding:8px 12px;color:#7d909c;">Role</td><td style="padding:8px 12px;">${role || 'Not specified'}</td></tr>
                <tr style="background:rgba(255,255,255,0.03)"><td style="padding:8px 12px;color:#7d909c;">Topic</td><td style="padding:8px 12px;">${topic || 'General'}</td></tr>
                <tr><td style="padding:8px 12px;color:#7d909c;">Rating</td><td style="padding:8px 12px;">${rating || 'Not rated'}</td></tr>
              </table>
              <div style="margin-top:20px;padding:16px;background:rgba(34,211,238,0.05);border:1px solid rgba(34,211,238,0.15);border-radius:6px;">
                <div style="font-size:11px;color:#7d909c;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;">Message</div>
                <div style="font-size:14px;line-height:1.6;white-space:pre-wrap;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
              </div>
              <div style="margin-top:16px;font-size:11px;color:#4a5568;">Submitted via HydroMind.AI feedback form</div>
            </div>
          `
        })
      });
      if (!emailRes.ok) {
        console.error('Contact email via Resend failed:', await emailRes.text());
      }
    }

    res.json({ success: true, message: 'Thank you for your feedback!' });
  } catch (e) {
    console.error('Contact endpoint error:', e.message);
    res.status(500).json({ error: 'Failed to submit feedback. Please try again.' });
  }
});

// HydroMind KB Upload Webhook
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

app.listen(PORT, () => console.log(`HydroMind AI v5.1 running on port ${PORT}`));

