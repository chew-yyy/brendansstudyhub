const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ── MIME types ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Notion-Version',
};

// ── Proxy helper ───────────────────────────────────────────────────────────
function proxyRequest(options, body, res) {
  return new Promise((resolve) => {
    const req = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(proxyRes.statusCode);
        res.end(data || '{}');
        resolve();
      });
    });
    req.on('error', (err) => {
      Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      resolve();
    });
    if (body) req.write(body);
    req.end();
  });
}

// ── Read body ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

// ── Server ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    res.writeHead(204);
    res.end();
    return;
  }

  // ── /api/notion/* → proxy to api.notion.com ──────────────────────────────
  if (pathname.startsWith('/api/notion')) {
    const notionPath = pathname.replace('/api/notion', '') || '/';
    const body = await readBody(req);

    const reqHeaders = {
      'Authorization': req.headers['authorization'] || '',
      'Notion-Version': req.headers['notion-version'] || '2022-06-28',
      'Content-Type': 'application/json',
    };
    if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body, 'utf8').toString();

    await proxyRequest({
      hostname: 'api.notion.com',
      path: notionPath,
      method,
      headers: reqHeaders,
    }, body, res);
    return;
  }

  // ── /api/claude → proxy to api.anthropic.com ─────────────────────────────
  if (pathname === '/api/claude') {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); }
    catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    const apiKey = parsed.anthropic_api_key || '';
    delete parsed.anthropic_api_key;
    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No API key. Add it in Settings.' } }));
      return;
    }

    const cleanBody = JSON.stringify(parsed);
    await proxyRequest({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(cleanBody, 'utf8').toString(),
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
    }, cleanBody, res);
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  // Security: prevent path traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Study Hub running on port ${PORT}`);
});