// server.mjs
// WaveSpeed Seedream v4 → Airtable batch logger
// - /app: minimal form UI
// - /generate-batch: submits N jobs (subject first, refs after), spaced ~1.2s
// - /webhooks/wavespeed: receives push results and appends to Airtable
// - pollUntilDone(): background poller to guarantee closure if webhook drops
//
// ENV VARS (Render → Settings → Environment):
// PORT, PUBLIC_BASE_URL, WAVESPEED_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE

import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

// ------------------------------
// Config & Helpers
// ------------------------------
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ""; // e.g., https://your-app.onrender.com
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID; // e.g., appXXXXXXXX
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE; // e.g., tblXXXXXXXX

// If WaveSpeed ever changes endpoints, you can override with WAVESPEED_BASE
const WAVESPEED_BASE = process.env.WAVESPEED_BASE || "https://api.wavespeed.ai/seedream/v4";

if (!WAVESPEED_API_KEY || !AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
  console.warn("[WARN] Missing required env vars. Set WAVESPEED_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE, PUBLIC_BASE_URL");
}

// Exponential backoff helper
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
async function withRetries(fn, { attempts = 3, baseDelay = 600 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = baseDelay * Math.pow(2, i);
      console.warn(`[retry] attempt ${i + 1} failed → waiting ${delay}ms`, err?.message || err);
      await wait(delay);
    }
  }
  throw lastErr;
}

// Convert a public image URL to a data URL (base64). WaveSpeed never has to fetch URLs.
async function convertUrlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${url} → ${res.status}`);
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  const b64 = buf.toString("base64");
  return `data:${contentType};base64,${b64}`;
}

// Airtable API helpers
const AT_BASE = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
const AT_HEADERS = {
  Authorization: `Bearer ${AIRTABLE_TOKEN}`,
  "Content-Type": "application/json",
};

// Create parent row for a batch; return {recordId}
async function airtableCreateParent({
  prompt,
  subjectUrl,
  refUrls,
  size,
  model = "WaveSpeed Seedream v4",
  runId,
}) {
  const fields = {
    "Prompt": prompt,
    "Subject": subjectUrl ? [{ url: subjectUrl }] : [],
    "References": (refUrls || []).map((u) => ({ url: u })),
    "Model": model,
    "Size": size,
    "Status": "processing",
    "Run ID": runId,
    "Created At": new Date().toISOString(),
    "Last Update": new Date().toISOString(),
  };

  const res = await fetch(AT_BASE, {
    method: "POST",
    headers: AT_HEADERS,
    body: JSON.stringify({ records: [{ fields }] }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Airtable create failed: ${res.status} ${JSON.stringify(json)}`);
  const recordId = json.records?.[0]?.id;
  if (!recordId) throw new Error("Airtable create returned no record id");
  return { recordId };
}

// Patch a row by recordId with partial fields
async function airtablePatch(recordId, patchFields) {
  const res = await fetch(AT_BASE, {
    method: "PATCH",
    headers: AT_HEADERS,
    body: JSON.stringify({ records: [{ id: recordId, fields: patchFields }] }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Airtable patch failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// Utility: merge a new attachment url into an attachment field (append)
async function airtableAppendAttachment(recordId, fieldName, url) {
  // Get existing first
  const getRes = await fetch(`${AT_BASE}?filterByFormula=RECORD_ID()="${recordId}"`, { headers: AT_HEADERS });
  const getJson = await getRes.json();
  const existing = getJson?.records?.[0]?.fields?.[fieldName] || [];
  const next = [...existing, { url }];
  await airtablePatch(recordId, {
    [fieldName]: next,
    "Last Update": new Date().toISOString(),
  });
}

// Utility: CSV helpers for Request IDs / Seen / Failed
function csvToSet(csv) {
  const s = new Set();
  if (!csv) return s;
  csv.split(",").map((x) => x.trim()).filter(Boolean).forEach((x) => s.add(x));
  return s;
}
function setToCsv(set) {
  return Array.from(set).join(", ");
}

// Update Request IDs / Seen IDs / Failed IDs atomically-ish
async function airtableUpdateIdLists(recordId, { addRequestIds = [], addSeen = [], addFailed = [] }) {
  // fetch current row
  const getRes = await fetch(`${AT_BASE}?filterByFormula=RECORD_ID()="${recordId}"`, { headers: AT_HEADERS });
  const getJson = await getRes.json();
  const row = getJson?.records?.[0]?.fields || {};

  const reqSet = csvToSet(row["Request IDs"]);
  const seenSet = csvToSet(row["Seen IDs"]);
  const failSet = csvToSet(row["Failed IDs"]);

  addRequestIds.forEach((id) => reqSet.add(id));
  addSeen.forEach((id) => seenSet.add(id));
  addFailed.forEach((id) => failSet.add(id));

  const patch = {
    "Request IDs": setToCsv(reqSet),
    "Seen IDs": setToCsv(seenSet),
    "Failed IDs": setToCsv(failSet),
    "Last Update": new Date().toISOString(),
  };

  // complete when seen == request (terminal regardless of failures)
  const allSeen = reqSet.size > 0 && reqSet.size === seenSet.size;
  if (allSeen) {
    patch["Status"] = "completed";
    patch["Completed At"] = new Date().toISOString();
  }

  await airtablePatch(recordId, patch);
}

// ------------------------------
// WaveSpeed API wrappers
// ------------------------------
async function wavespeedSubmit({ prompt, width, height, dataUrls, webhookUrl }) {
  // dataUrls: [subjectDataUrl, ...refDataUrls]
  const url = `${WAVESPEED_BASE}/generate?webhook=${encodeURIComponent(webhookUrl)}`;
  const body = {
    prompt,
    width,
    height,
    images: dataUrls, // subject first
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WAVESPEED_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WaveSpeed submit failed: ${res.status} ${JSON.stringify(json)}`);
  // Expecting { requestId: "..." }
  const requestId = json.requestId || json.id || json.request_id;
  if (!requestId) throw new Error(`WaveSpeed submit response missing requestId: ${JSON.stringify(json)}`);
  return { requestId };
}

async function wavespeedResult(requestId) {
  const url = `${WAVESPEED_BASE}/result/${encodeURIComponent(requestId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WaveSpeed result failed: ${res.status} ${JSON.stringify(json)}`);
  // Expecting shape: { status: 'processing'|'completed'|'failed'|'timeout', images: [url,...] }
  return json;
}

// ------------------------------
// UI
// ------------------------------
app.get("/", (_req, res) => {
  res.type("text").send("OK");
});

app.get("/app", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WaveSpeed → Airtable</title>
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:880px;margin:40px auto;padding:0 16px}
    label{display:block;margin:14px 0 6px;font-weight:600}
    input,textarea{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px}
    button{margin-top:16px;padding:12px 16px;border:0;border-radius:10px;background:#111;color:#fff;font-weight:700}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    small{color:#666}
  </style>
</head>
<body>
  <h1>WaveSpeed → Airtable Batch</h1>
  <form method="POST" action="/generate-batch">
    <label>Prompt</label>
    <textarea name="prompt" rows="4" placeholder="Refer to first image as subject; second for pose & lighting..." required></textarea>

    <label>Subject Image URL</label>
    <input name="subject" type="url" placeholder="https://..." required />

    <label>Reference Image URLs (comma-separated)</label>
    <input name="refs" type="text" placeholder="https://ref1..., https://ref2..." />

    <div class="row">
      <div>
        <label>Width</label>
        <input name="width" type="number" value="2227" required />
      </div>
      <div>
        <label>Height</label>
        <input name="height" type="number" value="3961" required />
      </div>
    </div>

    <div class="row">
      <div>
        <label>Batch Count</label>
        <input name="count" type="number" value="4" min="1" max="12" required />
      </div>
      <div>
        <label>Size (display only)</label>
        <input name="size" type="text" value="2227×3961" />
      </div>
    </div>

    <button type="submit">Generate</button>
    <p><small>Subject will be sent first, then references. Jobs spaced ~1.2s. Airtable will update live.</small></p>
  </form>
</body>
</html>`);
});

// ------------------------------
// Batch Orchestration
// ------------------------------
app.post("/generate-batch", async (req, res) => {
  try {
    const prompt = (req.body.prompt || "").trim();
    const subjectUrl = (req.body.subject || "").trim();
    const refsCsv = (req.body.refs || "").trim();
    const width = parseInt(req.body.width, 10) || 1024;
    const height = parseInt(req.body.height, 10) || 1024;
    const count = Math.max(1, Math.min(24, parseInt(req.body.count, 10) || 1));
    const size = (req.body.size || `${width}×${height}`).trim();

    if (!prompt || !subjectUrl) throw new Error("Missing prompt or subject URL");
    if (!PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL is not set. Set it to your deployed base URL.");

    const runId = crypto.randomUUID();

    // 1) Create Airtable parent row
    const { recordId } = await airtableCreateParent({
      prompt,
      subjectUrl,
      refUrls: refsCsv ? refsCsv.split(",").map((s) => s.trim()).filter(Boolean) : [],
      size,
      model: "WaveSpeed Seedream v4",
      runId,
    });

    // 2) Prepare images: subject first, refs after → to data URLs
    const refUrls = refsCsv
      ? refsCsv.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const subjectDataUrl = await withRetries(() => convertUrlToDataUrl(subjectUrl));
    const refDataUrls = [];
    for (const r of refUrls) {
      const d = await withRetries(() => convertUrlToDataUrl(r));
      refDataUrls.push(d);
    }

    const webhookUrl = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/wavespeed`;

    // 3) Submit jobs spaced ~1200ms
    const requestIds = [];
    for (let i = 0; i < count; i++) {
      if (i > 0) await wait(1200);
      const { requestId } = await withRetries(() =>
        wavespeedSubmit({ prompt, width, height, dataUrls: [subjectDataUrl, ...refDataUrls], webhookUrl })
      );
      requestIds.push(requestId);
      // Immediately reflect in Airtable
      await airtableUpdateIdLists(recordId, { addRequestIds: [requestId] });
      // Kick off background polling (fire-and-forget)
      pollUntilDone(requestId, recordId).catch((e) => console.error("poll error", e));
    }

    res.type("html").send(`<!doctype html><html><body>
      <h2>Batch started</h2>
      <p>Run ID: ${runId}</p>
      <p>Airtable Record: ${recordId}</p>
      <p>Request IDs:</p>
      <pre>${requestIds.map((x) => "- " + x).join("\n")}</pre>
      <p>Return to <a href="/app">/app</a></p>
    </body></html>`);
  } catch (err) {
    console.error("/generate-batch error", err);
    res.status(500).send(String(err?.message || err));
  }
});

// ------------------------------
// Webhook handler (push from WaveSpeed)
// Expected payload example (adjust to actual schema if different):
// { requestId: "...", status: "completed"|"failed", images: ["https://..."], error?: "..." }
// ------------------------------
app.post("/webhooks/wavespeed", async (req, res) => {
  try {
    const { requestId, status, images = [], error } = req.body || {};
    if (!requestId) {
      console.warn("Webhook missing requestId", req.body);
      return res.status(400).json({ ok: false });
    }

    // Find parent record by scanning for Request IDs containing requestId
    // (Airtable doesn't support LIKE easily; in practice you'd store a child table.
    // Here we iterate over recent rows. For simplicity, we assume the latest run.)
    // If you have many rows, consider caching requestId→recordId when you submit.

    const recordId = await findRecordByRequestId(requestId);
    if (!recordId) {
      console.warn("No Airtable record found for", requestId);
      return res.json({ ok: true });
    }

    // Append any images
    for (const url of images) {
      await airtableAppendAttachment(recordId, "Output", url);
    }

    const addSeen = [requestId];
    const addFailed = status === "failed" ? [requestId] : [];
    await airtableUpdateIdLists(recordId, { addSeen, addFailed });

    return res.json({ ok: true });
  } catch (err) {
    console.error("/webhooks/wavespeed error", err);
    res.status(200).json({ ok: true }); // Avoid retries storms
  }
});

// Cache mapping for quick lookup
const requestToRecord = new Map();
async function findRecordByRequestId(requestId) {
  const cached = requestToRecord.get(requestId);
  if (cached) return cached;

  // Fallback: naive scan of the latest 50 records
  const url = `${AT_BASE}?pageSize=50&sort[0][field]=Created%20at&sort[0][direction]=desc`;
  const res = await fetch(url, { headers: AT_HEADERS });
  const json = await res.json();
  for (const r of json.records || []) {
    const csv = r.fields?.["Request IDs"] || "";
    if (("," + csv + ",").includes("," + requestId + ",")) {
      requestToRecord.set(requestId, r.id);
      return r.id;
    }
  }
  return null;
}

// ------------------------------
// Poller: ensures every job resolves even if webhook drops
// ------------------------------
async function pollUntilDone(requestId, recordId) {
  const started = Date.now();
  const TIMEOUT_MS = 20 * 60 * 1000; // ~20 minutes

  // Cache mapping for faster webhooks later
  requestToRecord.set(requestId, recordId);

  while (true) {
    try {
      const result = await withRetries(() => wavespeedResult(requestId), { attempts: 3, baseDelay: 1000 });
      const st = (result.status || "").toLowerCase();

      if (st === "completed") {
        const imgs = Array.isArray(result.images) ? result.images : [];
        for (const url of imgs) {
          await airtableAppendAttachment(recordId, "Output", url);
        }
        await airtableUpdateIdLists(recordId, { addSeen: [requestId] });
        return;
      }

      if (st === "failed") {
        await airtableUpdateIdLists(recordId, { addSeen: [requestId], addFailed: [requestId] });
        return;
      }
    } catch (err) {
      console.warn("poll error", requestId, err?.message || err);
      // continue loop; backoff below
    }

    if (Date.now() - started > TIMEOUT_MS) {
      console.warn("poll timeout", requestId);
      await airtableUpdateIdLists(recordId, { addSeen: [requestId], addFailed: [requestId] });
      return;
    }

    await wait(7000); // poll every 7s
  }
}

// ------------------------------
// Start server
// ------------------------------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
