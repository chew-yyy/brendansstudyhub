const https = require('https');

module.exports = async (req, res) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Notion-Version',
  };
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // req.url contains the full original path e.g. /api/notion/v1/databases/xxx/query
  // Strip /api/notion to get the Notion API path
  const url = req.url || '';
  const notionPath = url.replace(/^\/api\/notion/, '') || '/';

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
        res.status(proxyRes.statusCode)
           .setHeader('Content-Type', 'application/json')
           .send(data || '{}');
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