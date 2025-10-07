import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const {
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE,
  AIRTABLE_TOKEN,
  FAL_API_KEY, // <-- set this in Render!
} = process.env;

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

// Helper: download and convert image to base64
async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch image: ' + url);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

// Main endpoint for Airtable Automation webhook
app.post('/airtable-trigger', async (req, res) => {
  const { recordId, fields } = req.body;
  try {
    // 1. Extract fields
    const prompt = fields.Prompt;
    const subjectUrl = fields.Subject?.[0]?.url;
    const refUrls = fields.References?.map(r => r.url) || [];
    const width = fields.Width || 1024;
    const height = fields.Height || 1024;

    // 2. Download images and convert to base64
    const subjectBase64 = await urlToBase64(subjectUrl);
    const refBase64s = await Promise.all(refUrls.map(urlToBase64));

    // 3. Prepare payload for fal.ai
    const falPayload = {
      prompt,
      images: [subjectBase64, ...refBase64s],
      width,
      height,
    };

    // 4. Call fal.ai Seedream v4 API
    const falRes = await fetch('https://fal.run/fal-ai/bytedance/seedream/v4', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(falPayload),
    });
    if (!falRes.ok) throw new Error(`Fal.ai error: ${await falRes.text()}`);
    const falData = await falRes.json();

    // 5. Update Airtable record with result
    // Example: Add output image URL to "Output" field
    await airtableApi(`${AIRTABLE_TABLE}/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fields: {
          'Output': [{ url: falData.images?.[0]?.url || falData.output_url }],
          'Status': 'completed',
          'Completed At': new Date().toISOString(),
        }
      })
    });

    res.send('Seedream v4 batch run complete!');

  } catch (e) {
    console.error(e);
    res.status(500).send('Error: ' + e.message);
  }
});

// Health check
app.get('/', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server started on port', PORT);
});
