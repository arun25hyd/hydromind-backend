# CLAUDE.md — HydroMind AI Master Memory File
# Single source of truth. Read this before any HydroMind coding task.
# Last updated: 2026-07-11 (Paddle live payments added — see Section 9)

---

## 1. CANONICAL FILE PATHS (EXACT — NO GUESSING)
# Corrected 2026-06-25 — old /Users/admin/ paths were from the previous
# MacBook and no longer exist. Current machine: /Users/Apple/

### Active Web Frontend (USE THIS — has git token)
/Users/Apple/Documents/HydroMind-Website/Web

### Backend
/Users/Apple/Documents/HydroMind-Website/Backend

### Android App (Expo/React Native — app.json, eas.json, App.js)
/Users/Apple/Documents/HydroMind-App

### HydroFit App
NOT FOUND on current Mac — old path /Users/admin/hydrofit was on the
previous machine and was never confirmed migrated. Verify with Arun
before referencing this app in any task.

### SKILL files
Per-repo, not a single shared agent path:
/Users/Apple/Documents/HydroMind-Website/Web/skills/
/Users/Apple/Documents/HydroMind-Website/Backend/SKILL.md

### STALE PATHS — NEVER USE THESE
# /Users/admin/...  ← ANY path with /Users/admin/ — OLD MACBOOK, DEAD
# /Users/Apple/Documents/HydroMind-Platform/...  ← OLD FOLDER NAME, DEAD
# AndroidStudioProjects/HydroMind  ← separate native Android Studio
#   project, NOT the live app — do not confuse with HydroMind-App

---

## 2. PLATFORM URLS

| Service | URL |
|---|---|
| Frontend (live) | https://hydromindai.com |
| Backend | https://hydromind-backend.onrender.com |
| GitHub repo | https://github.com/arun25hyd/hydromind-ai |
| Supabase project | frqefpoheewbornozvhc |

---

## 3. TECH STACK

### Web Frontend
- Pure HTML/CSS/JS (no framework) — 8 pages
- Design: bg #0d0f12, surface #13171d, orange #f97316
- Pages: index.html, ai_advisor.html, crane_diagnostic.html, system_design.html,
         knowledge_base.html, pricing.html, maintenance.html, disclaimer.html

### Backend (Node.js / Express)
- File: server.js
- Model: claude-sonnet-4-5 (locked — do NOT change)
- Max tokens: 2000
- Security: helmet, rate limiters, CSP/HSTS/XSS headers

### Android App (React Native / Expo)
- SDK: Expo 54
- Package: com.hydromind.app
- EAS account: arun25hyd
- Next versionCode: 35 (always set via `eas build:version:set` first)
- Play Store: Closed testing active — 12 Gmail testers

### HydroFit App
- Package: com.hydrofit.app
- Expo SDK 54
- DB: 1,456 hose fittings + 284 tube fittings + 80 hoses

---

## 4. HTML PAGE ARCHITECTURE — CRITICAL

### Two page types exist — ALWAYS CHECK BEFORE EDITING:

**TYPE A — Shell Layout pages** (ai_advisor, crane_diagnostic, system_design)
- Wrap content in `<div class="shell">`
- Has `</body></html>` INSIDE JS strings (for iframe/print export)
- Real `</body>` is at line 893 (crane_diagnostic) and 1669 (system_design)
- Nav replacement MUST be line-number based — NOT regex (will eat shell closing div)

**TYPE B — Scroll pages** (index, knowledge_base, pricing, maintenance, disclaimer)
- Standard scroll layout — no shell wrapper
- Safe to use regex nav replacement

### Z-index Rule (NON-NEGOTIABLE)
- `bg-wrap` canvas = `position:fixed; z-index:0`
- ALL content sections need `position:relative; z-index:2`
- Forgetting this = content disappears behind canvas

### Standard Page Layout (all pages must have):
1. `hm-topnav` (52px fixed top)
2. `hm-left-sidebar`
3. `hm-right-sidebar` (hmAdSidebar)
4. `hm-main-content`

---

## 5. REPEATED MISTAKES REGISTRY — NEVER REPEAT

| # | Mistake | Fix |
|---|---|---|
| 1 | Edit HTML without reading structure first | grep shell/nav/div counts FIRST |
| 2 | Nav regex consuming closing shell div | Line-number based replace on shell pages |
| 3 | Claim "fixed" without browser screenshot | Screenshot = only proof |
| 4 | Patching broken patch | Hard reset to last good git commit — do not restore from any /Users/admin/ path, that machine is gone |
| 5 | Using bash_tool for Mac filesystem | bash_tool = container only. Use Desktop Commander for Mac |
| 6 | Guessing file paths | Read CLAUDE.md section 1 first |
| 7 | Multiple questions to Arun | Max ONE question per response |
| 8 | python str.replace() returning unchanged | Always verify with assert or print before writing |
| 9 | Editing stale Desktop copy | ALWAYS use /Users/Apple/Documents/HydroMind-Website/Web |
| 10 | node --check skipped before backend push | ALWAYS run node --check server.js before git push |
| 11 | Auth restore not in 3 places | Auth restore script runs at: DOMContentLoaded + setTimeout 100ms + setTimeout 500ms |
| 12 | Re-doing tasks Arun confirmed ✅ | If Arun gave 👍 — NEVER touch it again |
| 13 | index.html hero SVG replaced with canvas | Hero is hydraulic schematic SVG in <div class="circuit-bg"> — NEVER replace |
| 14 | window.claude.complete() on live site | Use mailto: or Supabase — not claude API in browser |
| 15 | EAS build without version set | Always: eas build:version:set → 35 FIRST, then build |
| 16 | Trusting IP allowlists for Paddle live webhooks | Paddle's LIVE webhooks route through Cloudflare's edge (confirmed 2026-07-11, blocked IP was a Cloudflare IP, not Paddle's). IP checks are advisory-only in security.js — HMAC signature (enforcePaddleWebhook) is the real gate. Never re-add a hard IP block for this route. |
| 17 | Assuming a freshly-created Paddle API key has every permission needed | ALWAYS explicitly verify each scope (esp. Customers, Discounts) is checked when creating/editing a Paddle API key — Paddle does not warn you about missing scopes, it just 403s silently on that specific endpoint later |

---

## 9. PADDLE PAYMENTS (added 2026-07-11 — live and verified)

Direct Paddle.js web checkout, separate from RevenueCat (mobile-only, unrelated system).
Full status/history: `Work/HydroMind/Paddle-Payments-Status.md` in Arun's Obsidian vault.

- `PADDLE_ENV=live` in Render env vars controls sandbox vs live for all server-to-server calls
- Webhook: `POST /webhook/paddle` — signature-verified (HMAC), IP check is advisory-only (see mistake #16 above)
- Client token served dynamically via `GET /api/paddle/client-token` — never hardcode a token in pricing.html again
- Cancel/status: `/api/subscription/cancel`, `/api/subscription/status` — wired into the existing login modal, no dedicated account page
- Live price IDs: Pro `pri_01kx8d51djrfhh1a0ccj914cyf` ($29/mo), Team `pri_01kx8d51r4s98ba43tptgepbx2` ($299/mo)
- When testing webhooks against a real Paddle account (sandbox or live), verify via Paddle's own `/notifications/{id}` and `/notifications/{id}/logs` API, not just server logs — this is how both the Cloudflare-IP and missing-permissions bugs were actually found and confirmed fixed


---

## 6. GIT WORKFLOW (EXACT COMMANDS)

### Frontend
```bash
cd /Users/Apple/Documents/HydroMind-Website/Web
git add -A && git commit -m "fix: description" && git push origin main
```

### Backend
```bash
cd /Users/Apple/Documents/HydroMind-Website/Backend
node --check server.js   # MANDATORY before push
git add -A && git commit -m "fix: description" && git push origin main
```

### After push: wait 20s → browser verify → screenshot to Arun

---

## 7. QUERY ROUTING — WHAT TO LOAD

| Query Type | Action |
|---|---|
| Hydraulic fault / crane / KB / HPU | Load hydromind-ai-advisor SKILL.md |
| Web platform bug / page fix / HTML | Read this CLAUDE.md → inspect actual file → fix |
| Android / Expo / React Native | Direct coding — no skill needed |
| AI building / Claude API / LLM | Direct — general AI knowledge |
| Money / monetisation / SaaS / Play Store | Direct — general business knowledge |
| General chat / writing / research | Direct — no skill needed |

---

## 8. EXECUTION PROTOCOL (NON-NEGOTIABLE)

INSPECT → PLAN → CONFIRM → EXECUTE → VERIFY → COMMIT

1. INSPECT: Read actual file — count divs, grep structure
2. PLAN: State exactly what will change + which files
3. CONFIRM: If risky, one sentence to Arun before acting
4. EXECUTE: Single clean pass — never patch a broken patch
5. VERIFY: Browser screenshot of changed page
6. COMMIT: Only after browser confirms correct

NEVER claim done without browser screenshot.
NEVER edit without reading file structure first.
NEVER guess a file path — check CLAUDE.md section 1.

