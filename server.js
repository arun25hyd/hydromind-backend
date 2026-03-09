const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS: Allow all Vercel URLs + custom domain ──────────────────────────────
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // Allow all Vercel preview + production URLs
    if (
      origin.endsWith(".vercel.app") ||
      origin === process.env.FRONTEND_URL ||
      origin === "http://localhost:3000" ||
      origin === "http://localhost:5173"
    ) {
      return callback(null, true);
    }
    callback(new Error("Not allowed by CORS"));
  }
}));

app.use(express.json({ limit: "2mb" }));

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "HydroMind AI Backend Online", version: "3.0" });
});

// ── Main proxy route ──────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  try {
    const { model, max_tokens, system, messages, tools } = req.body;

    // Validate required fields
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }

    const body = {
      model: model || "claude-sonnet-4-20250514",
      max_tokens: max_tokens || 1000,
      messages,
    };

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

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    res.json(data);

  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).json({ error: "Internal server error: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`HydroMind Backend running on port ${PORT}`);
});