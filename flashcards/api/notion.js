const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Notion-Version');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Get the Notion path from the query param set by vercel.json rewrite
  const notionPath = (req.query.notionpath || '/v1').replace(/^\/api\/notion/, '');

  // Read body
  let body = '';
  await new Promise((resolve) => {
    req.on('data', chunk => { body += chunk; });
    req.on('end', resolve);
  });

  const reqHeaders = {
    'Authorization': req.headers['authorization'] || '',
    'Notion-Version': req.headers['notion-version'] || '2022-06-28',
    'Content-Type': 'application/json',
  };
  if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body, 'utf8').toString();

  const options = {
    hostname: 'api.notion.com',
    path: notionPath,
    method: req.method,
    headers: reqHeaders,
  };

  return new Promise((resolve) => {
    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode).send(data || '{}');
        resolve();
      });
    });
    proxyReq.on('error', (err) => {
      res.status(500).json({ error: err.message });
      resolve();
    });
    if (body) proxyReq.write(body);
    proxyReq.end();
  });
};