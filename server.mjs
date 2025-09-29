import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 5000; // Check every 5 seconds

// Store for tracking processed records
const processedRecords = new Set();

// Utility: Convert image URL to base64 data URL
async function imageUrlToBase64(url) {
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${base64}`;
  } catch (err) {
    console.error(`Failed to convert ${url} to base64:`, err.message);
    throw err;
  }
}

// Utility: Sleep function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Utility: Retry with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      const delay = baseDelay * Math.pow(2, i);
      console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
      await sleep(delay);
    }
  }
}

// Get all Airtable records
async function getAirtableRecords() {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Airtable fetch error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.records;
}

// Update Airtable record
async function updateAirtableRecord(recordId, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}/${recordId}`;
  
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Airtable update error: ${response.status} - ${text}`);
  }

  return await response.json();
}

// Submit job to WaveSpeed API
async function submitWaveSpeedJob(prompt, imageUrls, width, height, webhookUrl, recordId) {
  const payload = {
    key: WAVESPEED_API_KEY,
    prompt: prompt,
    model_id: "seedream-v4",
    width: width,
    height: height,
    samples: 1,
    num_inference_steps: 25,
    guidance_scale: 7.5,
    init_image: imageUrls[0], // Subject first
    control_image: imageUrls.slice(1), // References after
    webhook: webhookUrl,
    track_id: recordId // Use Airtable record ID as track ID
  };

  return await retryWithBackoff(async () => {
    const response = await fetch('https://wavespeed.fal.ai/v1/models/seedream-v4/inferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WaveSpeed API error: ${response.status} - ${text}`);
    }

    const data = await response.json();
    return data.eta || data.request_id || data.id;
  });
}

// Poll WaveSpeed for result
async function pollWaveSpeedResult(requestId) {
  const url = `https://wavespeed.fal.ai/v1/models/seedream-v4/fetch/${requestId}`;
  
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Poll error: ${response.status}`);
  }

  return await response.json();
}

// Poll until job done
async function pollUntilDone(requestId, recordId, maxWaitMs = 20 * 60 * 1000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const result = await retryWithBackoff(() => pollWaveSpeedResult(requestId), 3, 2000);
      
      if (result.status === 'completed' && result.output) {
        await appendResultToAirtable(recordId, requestId, result.output, 'completed');
        return;
      } else if (result.status === 'failed' || result.status === 'error') {
        await appendResultToAirtable(recordId, requestId, null, 'failed');
        return;
      }
      
      // Still processing
      await sleep(7000);
    } catch (err) {
      console.error(`Poll error for ${requestId}:`, err.message);
      await sleep(7000);
    }
  }
  
  // Timeout
  console.log(`Job ${requestId} timed out after ${maxWaitMs}ms`);
  await appendResultToAirtable(recordId, requestId, null, 'timeout');
}

// Append result to Airtable
async function appendResultToAirtable(recordId, requestId, outputUrls, status) {
  try {
    // Get current record
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}/${recordId}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });
    
    if (!response.ok) throw new Error(`Failed to get record: ${response.status}`);
    
    const data = await response.json();
    const record = data.fields;
    
    const seenIds = record['Seen IDs'] ? record['Seen IDs'].split(',') : [];
    const failedIds = record['Failed IDs'] ? record['Failed IDs'].split(',') : [];
    const outputs = record['Output'] || [];
    
    if (!seenIds.includes(requestId)) {
      seenIds.push(requestId);
      
      if (status === 'failed' || status === 'timeout') {
        failedIds.push(requestId);
      } else if (outputUrls && outputUrls.length > 0) {
        // Add new outputs
        const newOutputs = outputUrls.map(url => ({ url }));
        outputs.push(...newOutputs);
      }
      
      const requestIds = record['Request IDs'] ? record['Request IDs'].split(',') : [];
      const allSeen = requestIds.every(id => seenIds.includes(id));
      
      const updateFields = {
        'Seen IDs': seenIds.join(','),
        'Failed IDs': failedIds.join(','),
        'Output': outputs,
        'Last Update': new Date().toISOString(),
        'Status': allSeen ? 'completed' : 'processing'
      };
      
      if (allSeen) {
        updateFields['Completed At'] = new Date().toISOString();
      }
      
      await updateAirtableRecord(recordId, updateFields);
      console.log(`Updated record ${recordId}: ${status}`);
    }
  } catch (err) {
    console.error(`Failed to append result for ${requestId}:`, err.message);
  }
}

// Process a single Airtable record
async function processRecord(record) {
  const recordId = record.id;
  const fields = record.fields;
  
  // Skip if already processed or no prompt
  if (processedRecords.has(recordId)) return;
  if (!fields['Prompt']) return;
  if (fields['Status'] === 'processing' || fields['Status'] === 'completed') return;
  
  console.log(`Processing new record: ${recordId}`);
  processedRecords.add(recordId);
  
  try {
    // Get configuration from record or use defaults
    const prompt = fields['Prompt'];
    const batchCount = parseInt(fields['Batch Count']) || 1;
    const width = parseInt(fields['Width']) || 1024;
    const height = parseInt(fields['Height']) || 1024;
    
    // Get images
    const subjectUrls = fields['Subject'] ? fields['Subject'].map(att => att.url) : [];
    const referenceUrls = fields['References'] ? fields['References'].map(att => att.url) : [];
    
    // If no subject image provided, skip
    if (subjectUrls.length === 0) {
      console.log(`No subject image for record ${recordId}, skipping...`);
      await updateAirtableRecord(recordId, {
        'Status': 'failed',
        'Notes': 'No subject image provided'
      });
      return;
    }
    
    const allImageUrls = [...subjectUrls, ...referenceUrls];
    
    // Mark as processing
    await updateAirtableRecord(recordId, {
      'Status': 'processing',
      'Model': 'seedream-v4',
      'Size': `${width}x${height}`,
      'Run ID': `run_${Date.now()}`,
      'Created at': new Date().toISOString(),
      'Last Update': new Date().toISOString()
    });
    
    // Convert images to base64
    console.log('Converting images to base64...');
    const base64Images = await Promise.all(allImageUrls.map(url => imageUrlToBase64(url)));
    
    // Submit jobs
    const webhookUrl = `${PUBLIC_BASE_URL}/webhooks/wavespeed`;
    const requestIds = [];
    
    for (let i = 0; i < batchCount; i++) {
      try {
        const requestId = await submitWaveSpeedJob(prompt, base64Images, width, height, webhookUrl, recordId);
        requestIds.push(requestId);
        console.log(`Submitted job ${i + 1}/${batchCount} for record ${recordId}: ${requestId}`);
        
        // Update record with new request ID
        await updateAirtableRecord(recordId, {
          'Request IDs': requestIds.join(',')
        });
        
        // Start polling in background
        pollUntilDone(requestId, recordId).catch(err => 
          console.error(`Background poll error for ${requestId}:`, err.message)
        );
        
        // Space out requests
        if (i < batchCount - 1) {
          await sleep(1200);
        }
      } catch (err) {
        console.error(`Failed to submit job ${i + 1}:`, err.message);
      }
    }
    
  } catch (err) {
    console.error(`Error processing record ${recordId}:`, err.message);
    await updateAirtableRecord(recordId, {
      'Status': 'failed',
      'Notes': `Error: ${err.message}`,
      'Last Update': new Date().toISOString()
    });
  }
}

// Main polling loop for Airtable
async function pollAirtable() {
  try {
    const records = await getAirtableRecords();
    
    for (const record of records) {
      await processRecord(record);
    }
  } catch (err) {
    console.error('Airtable poll error:', err.message);
  }
}

// Start the Airtable polling loop
function startAirtablePoller() {
  console.log(`Starting Airtable poller (checking every ${POLL_INTERVAL}ms)...`);
  
  // Initial poll
  pollAirtable();
  
  // Set up interval
  setInterval(pollAirtable, POLL_INTERVAL);
}

// Routes

// Health check
app.get('/', (req, res) => {
  res.send('Airtable WaveSpeed Integration Running');
});

// Manual trigger endpoint (optional)
app.post('/trigger', async (req, res) => {
  await pollAirtable();
  res.json({ message: 'Manual trigger completed' });
});

// Webhook endpoint for WaveSpeed
app.post('/webhooks/wavespeed', async (req, res) => {
  try {
    const { request_id, status, output, track_id } = req.body;
    
    // track_id is the Airtable record ID we passed
    if (request_id && track_id) {
      await appendResultToAirtable(track_id, request_id, output, status);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Status endpoint to see what's been processed
app.get('/status', (req, res) => {
  res.json({
    processedRecords: Array.from(processedRecords),
    totalProcessed: processedRecords.size,
    uptime: process.uptime()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Public URL: ${PUBLIC_BASE_URL}`);
  console.log(`Webhook URL: ${PUBLIC_BASE_URL}/webhooks/wavespeed`);
  
  // Start polling Airtable
  startAirtablePoller();
});
