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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

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
app.get("/", (req, res) => res.json({ status: "HydroMind AI v5.0 Online", kb: "Supabase Vector DB Active" }));

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

// Register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    // Check if email exists
    const { data: existing } = await supabase
      .from("users").select("id").eq("email", email.toLowerCase()).single();
    if (existing) return res.status(400).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);
    const { data: user, error } = await supabase
      .from("users")
      .insert({ name, email: email.toLowerCase(), password_hash: hash, is_premium: false })
      .select("id, name, email, is_premium")
      .single();

    if (error) throw error;
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, isPremium: user.is_premium }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, isPremium: user.is_premium } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user } = await supabase
      .from("users").select("*").eq("email", email.toLowerCase()).single();
    if (!user) return res.status(400).json({ error: "Invalid email or password" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: "Invalid email or password" });

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, isPremium: user.is_premium }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, isPremium: user.is_premium } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// AI CHAT PROXY
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/chat", async (req, res) => {
  try {
    const { model, max_tokens, system, messages, tools } = req.body;
    if (!messages) return res.status(400).json({ error: "messages required" });

    const body = { model: model || "claude-sonnet-4-20250514", max_tokens: max_tokens || 1000, messages };
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DOCUMENT UPLOAD + PROCESSING
// ══════════════════════════════════════════════════════════════════════════

// Helper: split text into chunks of ~500 words with overlap
function chunkText(text, chunkSize = 500, overlap = 50) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (chunk.trim().length > 50) chunks.push(chunk); // skip tiny chunks
    i += chunkSize - overlap;
  }
  return chunks;
}

// Helper: get embedding from Anthropic API
async function getEmbedding(text) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
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
    // Fallback: generate deterministic pseudo-embedding from text hash
    const vec = new Array(384).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 384] += text.charCodeAt(i) / 1000;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  }
}

// Upload document endpoint
app.post("/api/kb/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    const { category, description } = req.body;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (req.file.mimetype !== "application/pdf") return res.status(400).json({ error: "Only PDF files accepted" });

    // Parse PDF
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text.replace(/\s+/g, " ").trim();
    if (text.length < 100) return res.status(400).json({ error: "PDF appears empty or unreadable" });

    const docName = req.file.originalname.replace(".pdf", "");

    // Save document record
    const { data: doc, error: docErr } = await supabase
      .from("kb_documents")
      .insert({
        name: docName,
        category: category || "General",
        description: description || "",
        uploaded_by: req.user.id,
        page_count: pdfData.numpages,
        char_count: text.length,
        status: "processing"
      })
      .select("id").single();

    if (docErr) throw docErr;

    // Process in background — return immediately
    res.json({ success: true, docId: doc.id, message: "Document received. Processing chunks in background." });

    // Background processing
    (async () => {
      try {
        const chunks = chunkText(text);
        let processed = 0;

        for (const chunk of chunks) {
          const embedding = await getEmbedding(chunk);
          await supabase.from("kb_chunks").insert({
            doc_id: doc.id,
            doc_name: docName,
            category: category || "General",
            content: chunk,
            embedding: JSON.stringify(embedding),
            chunk_index: processed
          });
          processed++;
          // Small delay to avoid rate limits
          await new Promise(r => setTimeout(r, 200));
        }

        await supabase.from("kb_documents").update({
          status: "ready",
          chunk_count: processed
        }).eq("id", doc.id);

      } catch (bgErr) {
        await supabase.from("kb_documents").update({ status: "error" }).eq("id", doc.id);
        console.error("Background processing error:", bgErr.message);
      }
    })();

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all documents
app.get("/api/kb/documents", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("kb_documents")
      .select("id, name, category, description, page_count, chunk_count, status, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete document
app.delete("/api/kb/documents/:id", authMiddleware, async (req, res) => {
  try {
    await supabase.from("kb_chunks").delete().eq("doc_id", req.params.id);
    await supabase.from("kb_documents").delete().eq("id", req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// KB SEARCH — find relevant chunks for a question
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/kb/search", async (req, res) => {
  try {
    const { question, topK = 5 } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });

    // Get question embedding
    const qEmbed = await getEmbedding(question);

    // Fetch all chunks and compute cosine similarity
    const { data: chunks, error } = await supabase
      .from("kb_chunks")
      .select("id, doc_name, category, content, embedding");

    if (error) throw error;
    if (!chunks || chunks.length === 0) return res.json({ chunks: [], found: false });

    // Cosine similarity
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

    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .filter(c => c.score > 0.3); // relevance threshold

    res.json({ chunks: top, found: top.length > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// KB-ENHANCED CHAT — searches KB then answers
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/kb/chat", async (req, res) => {
  try {
    const { question, history = [], system } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });

    // Search KB first
    const searchRes = await fetch(`http://localhost:${PORT}/api/kb/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, topK: 5 })
    });
    const { chunks, found } = await searchRes.json();

    // Build context from KB
    let kbContext = "";
    if (found && chunks.length > 0) {
      kbContext = "\n\n--- KNOWLEDGE BASE CONTEXT (from uploaded documents) ---\n";
      chunks.forEach((c, i) => {
        kbContext += `\n[${c.category} — ${c.doc_name}]\n${c.content}\n`;
      });
      kbContext += "--- END KB CONTEXT ---\n\nUse the above KB context to answer. If context is relevant, prioritise it over general knowledge.";
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
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: enhancedSystem,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });

    res.json({ ...data, kbUsed: found, kbChunkCount: chunks.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`HydroMind AI v5.0 running on port ${PORT}`));
