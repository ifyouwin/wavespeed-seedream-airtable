import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

// Helpers for __dirname with ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ENV VARS
const {
  PUBLIC_BASE_URL,
  WAVESPEED_API_KEY,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE,
} = process.env;

// Helper: download image and convert to base64 data URL
async function urlToDataURL(imgUrl) {
  const res = await fetch(imgUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${imgUrl}`);
  const buf = await res.arrayBuffer();
  // Infer content type
  const ct = res.headers.get('content-type') || 'image/jpeg';
  const b64 = Buffer.from(buf).toString('base64');
  return `data:${ct};base64,${b64}`;
}

// Helper: Airtable API wrapper
async function airtableApi(endpoint, opts = {}) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${endpoint}`;
  const headers = {
    Authorization: `Bearer ${AIRTABLE_TOKEN}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Airtable API error: ${res.status} ${errText}`);
  }
  return res.json();
}

// Helper: Exponential backoff
async function withRetries(fn, maxTries = 3, baseDelay = 1200) {
  let lastErr;
  for (let i = 0; i < maxTries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < maxTries - 1) await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// HTML form at /app
app.get('/app', (req, res) => {
  res.send(`
    <h2>WaveSpeed Seedream Batch Generator</h2>
    <form method="POST" action="/generate-batch">
      Prompt:<br><textarea name="prompt" rows="2" cols="60"></textarea><br>
      Subject Image URL:<br><input name="subjectUrl" size="60"><br>
      Reference Image URLs (comma separated):<br><input name="refUrls" size="60"><br>
      Width:<input name="width" size="6"> Height:<input name="height" size="6"><br>
      Batch count:<input name="batchCount" size="3"><br>
      <button type="submit">Generate</button>
    </form>
  `);
});

// Handle form submission (also used by Airtable automation)
app.post('/generate-batch', async (req, res) => {
  // NEW: allow parentId to be passed (from Airtable button/automation)
  const { prompt, subjectUrl, refUrls, width, height, batchCount, parentId: incomingParentId } = req.body;

  if (!prompt || !subjectUrl || !width || !height || !batchCount) {
    res.status(400).send('All fields required. Hit Back and try again.');
    return;
  }

  try {
    // Convert images to base64 data URLs
    const subjectDataUrl = await urlToDataURL(subjectUrl.trim());
    const refs = (refUrls ? refUrls.split(',') : []).map(s => s.trim()).filter(Boolean);
    const refDataUrls = await Promise.all(refs.map(urlToDataURL));
    const allImages = [subjectDataUrl, ...refDataUrls];

    const tableId = AIRTABLE_TABLE;

    // Prepare canonical fields (used for either update or create)
    const canonicalFields = {
      Prompt: prompt,
      Subject: [{ url: subjectUrl }],
      References: refs.map(u => ({ url: u })),
      Output: [],
      'Output URL': '',
      Model: 'WaveSpeed Seedream v4',
      Size: `${width}x${height}`,
      'Request IDs': '',
      'Seen IDs': '',
      'Failed IDs': '',
      Status: 'processing',
      'Run ID': Math.random().toString(36).slice(2),
      'Created at': new Date().toISOString(),
      'Last Update': new Date().toISOString(),
      'Completed At': '',
    };

    // NEW: if parentId provided, update existing row; else create a new one
    let parentId = incomingParentId && String(incomingParentId).trim();
    if (parentId) {
      await airtableApi(`${tableId}/${parentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: canonicalFields }),
      });
    } else {
      const createRowRes = await airtableApi(`${tableId}`, {
        method: 'POST',
        body: JSON.stringify({ records: [{ fields: canonicalFields }] }),
      });
      parentId = createRowRes.records[0].id;
    }

    // For each batch, submit job and save request IDs
    const ids = [];
    for (let i = 0; i < Number(batchCount); i++) {
      await new Promise(r => setTimeout(r, 1200)); // spacing jobs
      const reqId = await withRetries(async () => {
        // Submit to WaveSpeed API
        const resp = await fetch('https://api.wavespeed.ai/seedream/v4/generate', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${WAVESPEED_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt,
            images: allImages,               // subject first, then refs
            width: Number(width),
            height: Number(height),
            webhook: `${PUBLIC_BASE_URL || req.protocol + '://' + req.get('host')}/webhooks/wavespeed`,
          }),
        });
        if (!resp.ok) throw new Error(`Wavespeed API error: ${resp.status}`);
        const data = await resp.json();
        return data.request_id;
      });
      ids.push(reqId);
    }

    // Update Airtable row with request IDs
    await airtableApi(`${tableId}/${parentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { 'Request IDs': ids.join(',') } }),
    });

    // Start pollers for each job
    for (const reqId of ids) {
      pollUntilDone(reqId, parentId).catch(e =>
        console.error('Poller error', reqId, e)
      );
    }

    res.send(`Batch started! Parent Airtable row: ${parentId}. <a href="/app">Start another</a>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error: ' + e.message);
  }
});

// Poller: checks job status and appends result to Airtable
async function pollUntilDone(requestId, parentId) {
  let done = false;
  let tries = 0;
  const tableId = AIRTABLE_TABLE;
  while (!done && tries < 180) { // up to ~20m
    await new Promise(r => setTimeout(r, 7000));
    tries += 1;
    try {
      const resp = await fetch(`https://api.wavespeed.ai/seedream/v4/results/${requestId}`, {
        headers: { 'Authorization': `Bearer ${WAVESPEED_API_KEY}` },
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (['completed', 'failed'].includes(data.status)) {
        // Append output
        const outputAttachment = data.output_url ? [{ url: data.output_url }] : [];
        // Fetch current Airtable row
        const record = await airtableApi(`${tableId}/${parentId}`);
        const fields = record.fields;
        const seen = (fields['Seen IDs'] || '').split(',').filter(Boolean);
        if (!seen.includes(requestId)) seen.push(requestId);
        // Output
        const output = fields.Output || [];
        if (outputAttachment.length) output.push(...outputAttachment);
        const failedIds = (fields['Failed IDs'] || '').split(',').filter(Boolean);
        if (data.status === 'failed') failedIds.push(requestId);
        // If all Request IDs seen, mark completed
        const allReqIds = (fields['Request IDs'] || '').split(',').filter(Boolean);
        const isDone = seen.length === allReqIds.length;
        await airtableApi(`${tableId}/${parentId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            fields: {
              Output: output,
              'Seen IDs': seen.join(','),
              'Failed IDs': failedIds.join(','),
              'Last Update': new Date().toISOString(),
              ...(isDone
                ? {
                    Status: 'completed',
                    'Completed At': new Date().toISOString(),
                  }
                : {}),
            },
          }),
        });
        done = true;
      }
    } catch (e) {
      // Ignore and retry
      continue;
    }
  }
  if (!done) {
    // Mark failed in Airtable
    const record = await airtableApi(`${AIRTABLE_TABLE}/${parentId}`);
    const fields = record.fields;
    const failedIds = (fields['Failed IDs'] || '').split(',').filter(Boolean);
    failedIds.push(requestId);
    await airtableApi(`${AIRTABLE_TABLE}/${parentId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fields: {
          'Failed IDs': failedIds.join(','),
          Status: 'completed',
          'Completed At': new Date().toISOString(),
          'Last Update': new Date().toISOString(),
        },
      }),
    });
  }
}

// Webhook receiver
app.post('/webhooks/wavespeed', async (req, res) => {
  try {
    const { request_id, output_url, status } = req.body;

    const tableId = AIRTABLE_TABLE;
    // Safer: URL-encode the filterByFormula
    const formula = encodeURIComponent(`FIND('${request_id}', {Request IDs})`);
    const rows = await airtableApi(`${tableId}?filterByFormula=${formula}`);
    if (rows.records.length === 0) {
      res.status(404).send('Parent row not found');
      return;
    }
    const parentId = rows.records[0].id;

    // Update Airtable row
    const fields = rows.records[0].fields;
    const seen = (fields['Seen IDs'] || '').split(',').filter(Boolean);
    if (!seen.includes(request_id)) seen.push(request_id);

    const output = fields.Output || [];
    if (output_url) output.push({ url: output_url });

    const failedIds = (fields['Failed IDs'] || '').split(',').filter(Boolean);
    if (status === 'failed') failedIds.push(request_id);

    const allReqIds = (fields['Request IDs'] || '').split(',').filter(Boolean);
    const isDone = seen.length === allReqIds.length;

    await airtableApi(`${tableId}/${parentId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fields: {
          Output: output,
          'Seen IDs': seen.join(','),
          'Failed IDs': failedIds.join(','),
          'Last Update': new Date().toISOString(),
          ...(isDone
            ? {
                Status: 'completed',
                'Completed At': new Date().toISOString(),
              }
            : {}),
        },
      }),
    });

    res.send('OK');
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).send('Error: ' + e.message);
  }
});

// Health check
app.get('/', (req, res) => res.send('OK'));

// Start server
app.listen(PORT, () => {
  console.log('Server started on port', PORT);
});
