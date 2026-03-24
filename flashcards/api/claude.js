const https = require('https');

module.exports = async (req, res) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let body = '';
  await new Promise((resolve) => {
    req.on('data', chunk => { body += chunk; });
    req.on('end', resolve);
  });

  let parsed;
  try { parsed = JSON.parse(body); }
  catch(e) { res.status(400).json({ error: 'Invalid JSON' }); return; }

  const apiKey = parsed.anthropic_api_key || '';
  delete parsed.anthropic_api_key;
  if (!apiKey) {
    res.status(401).json({ error: { message: 'No API key. Add it in Settings.' } });
    return;
  }

  const cleanBody = JSON.stringify(parsed);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(cleanBody, 'utf8').toString(),
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
  };

  return new Promise((resolve) => {
    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode)
           .setHeader('Content-Type', 'application/json')
           .send(data);
        resolve();
      });
    });
    proxyReq.on('error', (err) => {
      res.status(500).json({ error: err.message });
      resolve();
    });
    proxyReq.write(cleanBody);
    proxyReq.end();
  });
};