const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Read body
  let body = '';
  await new Promise((resolve) => {
    req.on('data', chunk => { body += chunk; });
    req.on('end', resolve);
  });

  let parsedBody;
  try { parsedBody = JSON.parse(body); }
  catch(e) { res.status(400).json({ error: 'Invalid JSON' }); return; }

  const apiKey = parsedBody.anthropic_api_key || '';
  delete parsedBody.anthropic_api_key;
  if (!apiKey) {
    res.status(401).json({ error: { message: 'No API key provided. Add your Anthropic API key in Settings.' } });
    return;
  }

  const cleanBody = JSON.stringify(parsedBody);
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(cleanBody, 'utf8').toString(),
    'anthropic-version': '2023-06-01',
    'x-api-key': apiKey,
  };

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: reqHeaders,
  };

  return new Promise((resolve) => {
    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode).send(data);
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