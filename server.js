const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── SUPABASE CLIENT ────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CORS ───────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://hydromindai.com',
  'https://www.hydromindai.com',
  'http://localhost:3000',
  'http://localhost:8080',
];
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

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "HydroMind AI v5.2 Online", kb: "Supabase Vector DB Active", build: "deep-think-v6.2" }));

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
app.post("/api/auth/register", async (req, res) => {
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

app.post("/api/auth/login", async (req, res) => {
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
app.post("/api/chat", async (req, res) => {
  try {
    const { model, max_tokens, system, messages, tools } = req.body;
    if (!messages) return res.status(400).json({ error: "messages required" });
    const body = { model: model || "claude-sonnet-4-5", max_tokens: max_tokens || 1000, messages };
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
// NEWS ENDPOINT — web search for hydraulic industry news with image scraping
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/news", async (req, res) => {
  try {
    const newsPrompt = `Search hpmag.co.uk and hydraulicspneumatics.com for the 6 most recent hydraulic industry news articles published in 2025 or 2026. For each article include the direct URL and any image URL found.
Return ONLY a JSON array, no markdown, no extra text:
[{"title":"article headline","source":"hpmag.co.uk","url":"https://full-url","date":"DD Mon YYYY","summary":"2 sentence technical summary","tag":"PUMPS","image":"https://image-url-or-empty"}]
Tags must be one of: PUMPS VALVES SEALS CONTROLS FILTRATION INDUSTRY`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: newsPrompt }]
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });

    // Extract text from ALL content blocks — web_search returns mixed types
    let fullText = "";
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === "text") fullText += block.text;
        // tool_result blocks may contain text too
        if (block.type === "tool_result" && Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner.type === "text") fullText += inner.text;
          }
        }
      }
    }

    // Extract JSON array from response
    const clean = fullText.replace(/```json|```/g, "").trim();
    const match = clean.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (match) {
      try {
        const articles = JSON.parse(match[0]);
        if (Array.isArray(articles) && articles.length > 0) {
          return res.json({ articles });
        }
      } catch (e) { /* fall through to fallback */ }
    }

    // Fallback: return raw text so frontend can debug
    res.json({ articles: [], raw: fullText.substring(0, 500) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

const SUPABASE_SCHEM_URL = 'https://frqefpoheewbornozvhc.supabase.co/storage/v1/object/public/schematics/';

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
app.post("/api/kb/search", async (req, res) => {
  try {
    const { question, topK = 5 } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });
    const result = await searchKBInternal(question, topK);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// DEEP-THINK QUERY CLASSIFIER
// Before searching KB, classify EXACTLY what the user wants
// ══════════════════════════════════════════════════════════════════════════

// Datasheet request — user wants the technical spec document for a component
const DATASHEET_PATTERNS = [
  'datasheet','data sheet','spec sheet','technical data','specifications',
  'pump manual','motor manual','valve manual','crane manual',
  'show me the pump','show me the motor','show me the valve','show me the manual',
  'open the manual','show the catalog','show catalog','show document',
];

// Simple words that alone mean "show me this component" when model name is present
// e.g. "show me the A4VG pump" or "show me Favco"
const SHOW_ME_COMPONENT_WORDS = ['pump','motor','manual','catalog','document','reference'];

// Circuit/schematic request — user wants the hydraulic circuit drawing
const CIRCUIT_PATTERNS = [
  'circuit schematic','hydraulic circuit','circuit diagram','schematic diagram',
  'show circuit','show schematic','show diagram','show drawing','show wiring',
  'circuit for','schematic for','diagram for','wiring diagram',
  'hoist circuit','slew circuit','luffing circuit','HPU circuit',
  'closed loop circuit','open loop circuit','control circuit',
  'pilot circuit','brake circuit','load holding circuit',
];

// Full manual pages request
const PAGES_PATTERNS = [
  'all pages','full manual','every page','complete manual','entire manual',
  'all schematics','show all','manual pages','show pages',
];

// Context/explanation with visual support
const CONTEXT_PATTERNS = [
  'explain.*circuit','describe.*circuit','how does.*circuit','circuit.*work',
  'explain.*schematic','with diagram','with schematic','with drawing',
  'how.*works','explain.*system','describe.*system',
];

function classifyQuery(question) {
  const q = question.toLowerCase();

  // Pages = most explicit — user wants the whole document
  for (const p of PAGES_PATTERNS) { if (q.includes(p)) return { mode:'visual', docType:'pages', limit:12 }; }

  // Circuit = wants the hydraulic circuit drawing
  const hasCircuit = q.includes(' circuit') || q.endsWith('circuit');
  const hasCraneCircuit = /\b(hoist|luffing|slew|slewing|crane|winch|boom)\b/.test(q) && hasCircuit;
  const hasExplain    = /\b(explain|describe|how does|how do|tell me about|what is|understand)\b/.test(q);

  // Crane circuit + explain → context mode (full explanation + circuit images)
  if (hasCraneCircuit && hasExplain) return { mode:'context', docType:'crane_explain', limit:3 };

  for (const p of CIRCUIT_PATTERNS) { if (q.includes(p)) return { mode:'visual', docType:'circuit', limit:3 }; }
  if (hasCircuit) return { mode:'visual', docType:'circuit', limit:3 };

  // Datasheet = wants the component spec/manual — but NOT if 'circuit' is in query
  if (!hasCircuit) {
    for (const p of DATASHEET_PATTERNS) { if (q.includes(p)) return { mode:'visual', docType:'datasheet', limit:4 }; }
    // "show me [component]" without circuit keyword → datasheet
    // BUT exclude fault/troubleshooting questions: not/fault/why/problem/issue/pressure/error/fail
    const FAULT_WORDS = ['not ','fault','why ','problem','issue','fail','error','chattering',
                          'slow','hot','overheat','leak','noise','vibrat','trip','alarm',
                          'pressure drop','no flow','low pressure','high pressure','stuck'];
    const isFaultQ = FAULT_WORDS.some(w => q.includes(w));
    if (!isFaultQ && (q.startsWith('show me') || q.startsWith('open') || q.startsWith('display'))) {
      return { mode:'visual', docType:'datasheet', limit:4 };
    }
  }

  // Context = explanation with optional visual support
  for (const p of CONTEXT_PATTERNS) { if (new RegExp(p).test(q)) return { mode:'context', docType:'explain', limit:3 }; }

  // Default = text answer only
  return { mode:'text', docType:'answer', limit:0 };
}

// ── CIRCUIT vs DATASHEET document routing ────────────────────────────────
// When user asks for "X circuit", route to correct docs AND correct page offset
// Format: { kbIds, pageOffset, pageCount }
// pageOffset = which page index to start from (0-based)
// pageCount = how many pages to show (default 3)
// CIRCUIT_DOCUMENT_MAP: { kbIds, pageOffset, pageCount }
// pageOffset = 0-based index of first circuit diagram page in the document
// pageCount  = number of circuit pages to show (default 3)
const CIRCUIT_DOCUMENT_MAP = {
  // A4VG: circuit diagrams are at pages 60-63 of the 74-page datasheet
  'a4vg':          { kbIds: ['KB116','KB117'], pageOffset: 59, pageCount: 4 },
  // A10VSO: circuit diagrams in their manual
  'a10v':          { kbIds: ['KB134'],          pageOffset: 0,  pageCount: 3 },
  // Danfoss Series 90: circuit diagrams
  'series 90':     { kbIds: ['KB119','KB141'],  pageOffset: 0,  pageCount: 3 },
  'serie 90':      { kbIds: ['KB119','KB141'],  pageOffset: 0,  pageCount: 3 },
  'danfoss 90':    { kbIds: ['KB119','KB141'],  pageOffset: 0,  pageCount: 3 },
  // PVG32 proportional valve circuit
  'pvg32':         { kbIds: ['KB196'],           pageOffset: 0,  pageCount: 3 },
  'pvg':           { kbIds: ['KB196'],           pageOffset: 0,  pageCount: 3 },
  // Counterbalance valve — all pages are circuit-relevant
  'counterbalance':{ kbIds: ['KB201'],           pageOffset: 0,  pageCount: 4 },
  'cbv':           { kbIds: ['KB201'],           pageOffset: 0,  pageCount: 4 },
  // Crane system circuits from OEM manuals
  'hoist circuit': { kbIds: ['KB115','KB109','KB110'], pageOffset: 0, pageCount: 3 },
  'slew circuit':  { kbIds: ['KB115','KB110','KB109'], pageOffset: 0, pageCount: 3 },
  'luffing':       { kbIds: ['KB115','KB110','KB114'], pageOffset: 0, pageCount: 3 },
  'crane circuit': { kbIds: ['KB109','KB110','KB114'], pageOffset: 0, pageCount: 3 },
  'winch circuit': { kbIds: ['KB103','KB274'],    pageOffset: 0,  pageCount: 3 },
  // Generic hydraulic circuits
  'hpu circuit':   { kbIds: ['KB283','KB105'],   pageOffset: 0,  pageCount: 3 },
  'pilot circuit': { kbIds: ['KB283'],            pageOffset: 0,  pageCount: 3 },
  'closed loop':   { kbIds: ['KB283','KB105'],   pageOffset: 0,  pageCount: 3 },
  'open loop':     { kbIds: ['KB283','KB105'],   pageOffset: 0,  pageCount: 3 },
  'load sensing':  { kbIds: ['KB283'],            pageOffset: 0,  pageCount: 3 },
  'hydraulic schematic': { kbIds: ['KB283','KB105'], pageOffset: 0, pageCount: 3 },
};

// Component datasheets — when user says "show me A4VG" without "circuit"
const DATASHEET_DOCUMENT_MAP = [
  { patterns: ['a4vg'],          kbIds: ['KB116','KB117'] },
  { patterns: ['a10v','a10vso'], kbIds: ['KB134'] },
  { patterns: ['a4vso'],         kbIds: ['KB130'] },
  { patterns: ['a20vlo'],        kbIds: ['KB128'] },
  { patterns: ['a4csg'],         kbIds: ['KB135'] },
  { patterns: ['a2fo'],          kbIds: ['KB129'] },
  { patterns: ['a6vm'],          kbIds: ['KB151'] },
  { patterns: ['mrt','mre'],     kbIds: ['KB153'] },
  { patterns: ['series 90','serie 90','danfoss 90','s90'], kbIds: ['KB119','KB141','KB154'] },
  { patterns: ['series 90 motor','serie 90 motor'],          kbIds: ['KB154'] },
  { patterns: ['series 45'],     kbIds: ['KB142'] },
  { patterns: ['f11','f12'],     kbIds: ['KB124'] },
  { patterns: ['pvg32'],         kbIds: ['KB196'] },
  { patterns: ['pvg120'],        kbIds: ['KB167','KB312'] },
  { patterns: ['rexroth we','we dcv','we6'], kbIds: ['KB189'] },
  { patterns: ['counterbalance valve','cbv','vickers cbv'], kbIds: ['KB201'] },
  { patterns: ['favco','favelle'], kbIds: ['KB115'] },
  { patterns: ['seatrax'],         kbIds: ['KB110'] },
  { patterns: ['macgregor','hmc2201'], kbIds: ['KB109'] },
  { patterns: ['nov ahc','knuckle boom'], kbIds: ['KB114'] },
  { patterns: ['amclyde'],         kbIds: ['KB102'] },
  { patterns: ['braden'],          kbIds: ['KB103','KB274'] },
  { patterns: ['vt-hacd'],         kbIds: ['KB317'] },
  { patterns: ['vtvpcd'],          kbIds: ['KB318'] },
  { patterns: ['vt-varp','varp1'], kbIds: ['KB309'] },
  { patterns: ['pvres','pvrel'],   kbIds: ['KB311'] },
  { patterns: ['oilgear','pvm'],   kbIds: ['KB123','KB144'] },
  { patterns: ['hydraulic schematic','hydraulic circuit book','circuit manual'], kbIds: ['KB283','KB105'] },
  // Troubleshooting and preventive maintenance guides
  // Troubleshooting guides
  { patterns: ['how to solve','solve hydraulic','prevent hydraulic','preventive hydraulic','solve and prevent'], kbIds: ['KB281','KB282'] },
  { patterns: ['hydraulic troubleshooting','troubleshooting hydraulic','troubleshoot hydraulic'],               kbIds: ['KB286','KB113','KB282'] },
  { patterns: ['logical troubleshooting','troubleshooting guide','troubleshooting steps'],                      kbIds: ['KB108','KB104','KB286'] },
  { patterns: ['hydraulic problem','hydraulic fault','hydraulic failure','hydraulic issue'],                    kbIds: ['KB281','KB286','KB282'] },
  { patterns: ['cylinder troubleshooting','cylinder fault','cylinder drifting','cylinder not extending'],       kbIds: ['KB285','KB106'] },
  { patterns: ['load sensing manual','ls service','ls system manual'],                                         kbIds: ['KB296'] },
  { patterns: ['fluid power engineering','fluid power basics','fluid power ebook'],                             kbIds: ['KB279','KB277'] },
  { patterns: ['industrial hydraulics manual','industrial hydraulics textbook'],                                kbIds: ['KB289','KB290'] },
];

app.post("/api/kb/chat", async (req, res) => {
  try {
    const { question, history = [], system } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });

    // ── DEEP-THINK: Classify the query precisely ──────────────────────────
    const { mode: schematicMode, docType, limit: schematicLimit } = classifyQuery(question);
    const q_lower = question.toLowerCase();
    console.log(`Query: "${question.slice(0,60)}" → mode:${schematicMode} type:${docType} limit:${schematicLimit}`);

    let schematics = [];
    let kbContext  = "";
    let directHit  = false;

    if (schematicMode !== 'text') {
      // ── ROUTE: circuit request → circuit books, datasheet → component docs
      let targetKbIds = null;

      let circuitPageOffset = 0;  // which page to start from for circuit mode
      let circuitPageCount = 3;   // how many pages to show

      if (docType === 'circuit' || docType === 'crane_explain') {
        // Look for circuit-specific routing with optional page offset
        for (const [pattern, entry] of Object.entries(CIRCUIT_DOCUMENT_MAP)) {
          if (q_lower.includes(pattern)) {
            targetKbIds = entry.kbIds || entry;
            circuitPageOffset = entry.pageOffset || 0;
            circuitPageCount  = entry.pageCount  || 3;
            break;
          }
        }
        // If no specific circuit route, fall back to general KB search
      } else if (docType === 'datasheet' || docType === 'pages') {
        // Look for specific component datasheet
        for (const entry of DATASHEET_DOCUMENT_MAP) {
          if (entry.patterns.some(p => q_lower.includes(p))) {
            targetKbIds = entry.kbIds; break;
          }
        }
      }

      if (targetKbIds) {
        const idFilter = targetKbIds.map(id => `kb_id.eq.${id}`).join(',');
        const { data: directDocs } = await supabase
          .from("kb_chunks")
          .select("kb_id, doc_name, category, brand, searchable_text, schematic_ids, schematic_count")
          .or(idFilter);

        if (directDocs && directDocs.length > 0) {
          console.log(`Direct hit [${docType}]: ${directDocs.map(d=>d.doc_name.slice(0,30)).join(', ')}`);
          kbContext = "\n\n--- KNOWLEDGE BASE CONTEXT ---\n";
          directDocs.forEach(c => {
            kbContext += `\n[${c.category} — ${c.doc_name}]\n${(c.searchable_text||'').substring(0,400)}\n`;
            if (Array.isArray(c.schematic_ids) && schematics.length < schematicLimit) {
              // For circuit mode: use pageOffset to show the correct circuit pages
              // For datasheet mode: always start from page 1 (index 0)
              const pageStart = (docType === 'circuit') ? circuitPageOffset : 0;
              const pageEnd   = pageStart + (docType === 'circuit' ? circuitPageCount : schematicLimit);
              c.schematic_ids.slice(pageStart, pageEnd).forEach(imgFile => {
                if (schematics.length < schematicLimit)
                  schematics.push({ filename: imgFile, url: SUPABASE_SCHEM_URL + imgFile, doc: c.doc_name, category: c.category });
              });
            }
          });

          if (docType === 'crane_explain') {
            kbContext += "--- END KB CONTEXT ---\n\nThe user wants an EXPLANATION of the crane circuit, not just images.\nIMPORTANT RULES:\n1. Do NOT draw ASCII circuits.\n2. Give a FULL technical explanation of how the main hoist/luffing circuit works:\n   - Describe the main components (pump, motor, DCV, CBV, brake valve)\n   - Explain the flow path for hoisting and lowering\n   - State typical pressure settings\n   - Explain the safety function (counterbalance valve role)\n3. Keep explanation under 200 words.\n4. The PNG circuit images are shown BELOW your explanation as visual reference.";
          } else if (docType === 'circuit') {
            kbContext += "--- END KB CONTEXT ---\n\nIMPORTANT RULES:\n1. Do NOT draw ASCII circuits. The hydraulic circuit PNG images are displayed below.\n2. Write 2-3 sentences ONLY: what circuit is shown and which document it comes from.\n3. Max 60 words. The images ARE the answer.";
          } else if (docType === 'pages') {
            kbContext += "--- END KB CONTEXT ---\n\nIMPORTANT: Do NOT draw ASCII art. Write 1-2 sentences identifying the document. The PNG pages are shown below. Max 30 words.";
          } else {
            kbContext += "--- END KB CONTEXT ---\n\nIMPORTANT: Do NOT draw ASCII art. Write 2-3 sentences identifying what these document pages show. The PNG images are displayed below. Max 50 words.";
          }
          directHit = true;
        }
      }
    }

    // ── GENERAL KB SEARCH (when no direct hit) ───────────────────────────
    let found = directHit;
    let chunks = [];
    if (!directHit) {
      const topK = schematicMode === 'visual' ? 3 : 5;
      const result = await searchKBInternal(question, topK);
      chunks = result.chunks; found = result.found;

      if (found && chunks.length > 0) {
        kbContext = "\n\n--- KNOWLEDGE BASE CONTEXT ---\n";
        chunks.forEach(c => {
          kbContext += `\n[${c.category} — ${c.doc_name}]${c.brand?' | Brand:'+c.brand:''}\n${(c.searchable_text||'').substring(0,1500)}\n`;
          if (schematics.length === 0 && schematicLimit > 0 && Array.isArray(c.schematic_ids) && c.schematic_ids.length > 0) {
            c.schematic_ids.slice(0, schematicLimit).forEach(imgFile => {
              if (schematics.length < schematicLimit)
                schematics.push({ filename: imgFile, url: SUPABASE_SCHEM_URL + imgFile, doc: c.doc_name, category: c.category });
            });
          }
        });
        if (schematicMode === 'visual') {
          kbContext += "--- END KB CONTEXT ---\n\nIMPORTANT: Do NOT draw ASCII art. Write 2-3 sentences describing what document these images come from. PNG images shown below. Max 50 words.";
        } else if (schematicMode === 'context') {
          kbContext += "--- END KB CONTEXT ---\n\nProvide full technical explanation. Do NOT draw ASCII art — schematic PNG images are shown separately.";
        } else {
          // For troubleshooting/fault questions, add reference to relevant KB docs
          const isTroubleQ = /\b(why|fault|problem|fail|not working|chattering|slow|leak|noise|hot|over|no pressure|low pressure|stuck|not build|not shift|vibrat|alarm|trip)\b/.test(q_lower);
          if (isTroubleQ) {
            kbContext += "--- END KB CONTEXT ---\n\nThis is a FAULT DIAGNOSIS question. IMPORTANT:\n1. Use your engineering reasoning FIRST — identify the most likely root cause from first principles.\n2. Reference the KB context for specific procedures, settings, or OEM data.\n3. The KB includes: Hydraulic Troubleshooting guides (KB286), How to Solve Hydraulic Problems (KB281/KB282), Logical Troubleshooting (KB108), and crane-specific guides (KB104).\n4. Answer with: Most likely cause → Physical reasoning → 2-3 alternatives → Ask if they want step-by-step.\n5. Do NOT list every possible cause — give the ONE most likely based on symptoms.";
          } else {
            kbContext += "--- END KB CONTEXT ---\n\nProvide a complete, logical technical answer based on engineering reasoning.";
          }
        }
      }
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

    res.json({ ...data, kbUsed: found, kbChunkCount: chunks.length, schematics, schematicMode });
  } catch (e) {
    console.error("kb/chat error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// HydroMind KB Upload Webhook
app.post('/webhook/kb-upload', async function(req, res) {
  try {
    var secret = req.headers['x-webhook-secret'];
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
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

// ── KEEP-ALIVE: ping self every 14 minutes to prevent Render sleep ─────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(async () => {
  try {
    await fetch(`${SELF_URL}/`);
    console.log("Keep-alive ping sent");
  } catch (e) {
    console.log("Keep-alive ping failed:", e.message);
  }
}, 14 * 60 * 1000); // every 14 minutes
