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
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin.endsWith(".vercel.app") || origin === process.env.FRONTEND_URL) cb(null, true);
    else cb(new Error("Not allowed by CORS"));
  }
}));
app.use(express.json({ limit: "2mb" }));

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "HydroMind AI v5.1 Online", kb: "Supabase Vector DB Active" }));

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
    const body = { model: model || "claude-sonnet-4-5-20250514", max_tokens: max_tokens || 1000, messages };
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
        model: "claude-sonnet-4-5-20250514",
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
      model: "claude-sonnet-4-5-20250514",
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

// ── INTERNAL KB SEARCH (no localhost call) ────────────────────────────────
async function searchKBInternal(question, topK = 5) {
  try {
    const qEmbed = await getEmbedding(question);
    const { data: chunks, error } = await supabase
      .from("kb_chunks")
      .select("id, doc_name, category, content, embedding");
    if (error || !chunks || chunks.length === 0) return { chunks: [], found: false };
    const scored = chunks.map(chunk => {
      try {
        const vec = JSON.parse(chunk.embedding);
        let dot = 0, magA = 0, magB = 0;
        for (let i = 0; i < vec.length; i++) {
          dot += (qEmbed[i] || 0) * vec[i];
          magA += (qEmbed[i] || 0) ** 2;
          magB += vec[i] ** 2;
        }
        const sim = dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
        return { ...chunk, score: sim };
      } catch { return { ...chunk, score: 0 }; }
    });
    const top = scored.sort((a, b) => b.score - a.score).slice(0, topK).filter(c => c.score > 0.3);
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
// KB-ENHANCED CHAT — FIXED: uses internal function, no localhost call
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/kb/chat", async (req, res) => {
  try {
    const { question, history = [], system } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });

    // ✅ FIX: use internal function instead of localhost fetch
    const { chunks, found } = await searchKBInternal(question, 5);

    let kbContext = "";
    if (found && chunks.length > 0) {
      kbContext = "\n\n--- KNOWLEDGE BASE CONTEXT (from uploaded documents) ---\n";
      chunks.forEach(c => { kbContext += `\n[${c.category} — ${c.doc_name}]\n${c.content}\n`; });
      kbContext += "--- END KB CONTEXT ---\n\nUse the above KB context to answer. If context is relevant, prioritise it.";
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
        model: "claude-sonnet-4-5-20250514",
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

    res.json({ ...data, kbUsed: found, kbChunkCount: chunks.length });
  } catch (e) {
    console.error("kb/chat error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

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
