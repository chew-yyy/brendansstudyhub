const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Notion-Version',
};

function setCORS(res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function notionCall(method, notionPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data, 'utf8').toString();

    const req = https.request({ hostname: 'api.notion.com', path: notionPath, method, headers }, res => {
      let out = '';
      res.on('data', chunk => { out += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch(e) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Convert HTML to Notion blocks
function htmlToBlocks(html) {
  const blocks = [];
  // Use a simple regex-based parser since we have no DOM on server
  // Strip tags we can't handle, convert known ones
  const rt = text => {
    // Clean HTML entities back
    text = text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
    // Strip remaining HTML tags for plain text
    text = text.replace(/<[^>]+>/g,'').trim();
    return text ? [{ type:'text', text:{ content: text } }] : [];
  };

  // Split into lines and process
  const lines = html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi,       '\x01H1\x02$1\x03')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi,       '\x01H2\x02$1\x03')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi,       '\x01H3\x02$1\x03')
    .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, '\x01QUOTE\x02$1\x03')
    .replace(/<pre[^>]*>.*?<code[^>]*>([\s\S]*?)<\/code>.*?<\/pre>/gi, '\x01CODE\x02$1\x03')
    .replace(/<hr\s*\/?>/gi, '\x01HR\x02\x03')
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (m, inner) => {
      return inner.replace(/<li[^>]*>(.*?)<\/li>/gi, '\x01BULLET\x02$1\x03');
    })
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (m, inner) => {
      return inner.replace(/<li[^>]*>(.*?)<\/li>/gi, '\x01NUMBER\x02$1\x03');
    })
    .replace(/<div[^>]*class="callout ([^"]*)"[^>]*>[\s\S]*?<div[^>]*class="callout-icon"[^>]*>(.*?)<\/div>[\s\S]*?<div[^>]*class="callout-content"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/div>/gi,
      (m, type, icon, content) => `\x01CALLOUT-${type.trim()}\x02${icon.trim()}|||${content}\x03`)
    .replace(/<figure[^>]*>[\s\S]*?<img[^>]*src="([^"]*)"[^>]*>[\s\S]*?<\/figure>/gi, '\x01IMG\x02$1\x03')
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '\x01IMG\x02$1\x03')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\x01P\x02$1\x03')
    .split('\x03');

  for (const chunk of lines) {
    const match = chunk.match(/\x01(\S+)\x02([\s\S]*)/);
    if (!match) {
      const text = chunk.replace(/<[^>]+>/g,'').trim();
      if (text) blocks.push({ object:'block', type:'paragraph', paragraph:{ rich_text: rt(text) } });
      continue;
    }
    const [, type, content] = match;
    const text = content.replace(/<[^>]+>/g,'').trim();

    if (type === 'H1')     blocks.push({ object:'block', type:'heading_1',    heading_1:    { rich_text: rt(text) } });
    else if (type === 'H2') blocks.push({ object:'block', type:'heading_2',   heading_2:    { rich_text: rt(text) } });
    else if (type === 'H3') blocks.push({ object:'block', type:'heading_3',   heading_3:    { rich_text: rt(text) } });
    else if (type === 'QUOTE') blocks.push({ object:'block', type:'quote',    quote:         { rich_text: rt(text) } });
    else if (type === 'CODE')  blocks.push({ object:'block', type:'code',     code:          { rich_text: rt(text), language:'plain text' } });
    else if (type === 'HR')    blocks.push({ object:'block', type:'divider',  divider:       {} });
    else if (type === 'BULLET') blocks.push({ object:'block', type:'bulleted_list_item', bulleted_list_item: { rich_text: rt(text) } });
    else if (type === 'NUMBER') blocks.push({ object:'block', type:'numbered_list_item', numbered_list_item: { rich_text: rt(text) } });
    else if (type === 'IMG' && content.trim()) {
      blocks.push({ object:'block', type:'image', image:{ type:'external', external:{ url: content.trim() } } });
    }
    else if (type.startsWith('CALLOUT-')) {
      const cls = type.split('-')[1]||'info';
      const [icon, calloutText] = content.split('|||');
      const emojiMap = { info:'ℹ️', warning:'⚠️', success:'✅', danger:'🔴' };
      blocks.push({ object:'block', type:'callout', callout:{
        rich_text: rt((calloutText||'').replace(/<[^>]+>/g,'').trim()),
        icon:{ type:'emoji', emoji: emojiMap[cls]||'ℹ️' }
      }});
    }
    else if (type === 'P' && text) {
      blocks.push({ object:'block', type:'paragraph', paragraph:{ rich_text: rt(text) } });
    }
  }

  return blocks.filter(b => {
    if (b.type === 'divider' || b.type === 'image') return true;
    const key = b[b.type];
    return key?.rich_text?.length > 0;
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  setCORS(res);

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /api/save-note — save full note content as Notion blocks ──────────────
  if (pathname === '/api/save-note' && method === 'POST') {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch(e) { res.writeHead(400); res.end('Bad JSON'); return; }

    const { pageId, title, html, preview, token } = body;
    if (!pageId || !token) { res.writeHead(400); res.end('Missing pageId or token'); return; }

    try {
      // Step 1: Update title + preview properties
      await notionCall('PATCH', `/v1/pages/${pageId}`, token, {
        properties: {
          Title:   { title:[{ text:{ content: title||'Untitled' } }] },
          Preview: { rich_text:[{ text:{ content: (preview||'').slice(0,200) } }] }
        }
      });

      // Step 2: Get existing blocks
      const existing = await notionCall('GET', `/v1/blocks/${pageId}/children?page_size=100`, token, null);
      const existingIds = (existing.body?.results||[]).map(b => b.id);

      // Step 3: Delete each existing block
      for (const bid of existingIds) {
        await notionCall('DELETE', `/v1/blocks/${bid}`, token, null);
      }

      // Step 4: Convert HTML to blocks and append
      const blocks = htmlToBlocks(html||'');
      if (blocks.length > 0) {
        for (let i = 0; i < blocks.length; i += 100) {
          await notionCall('PATCH', `/v1/blocks/${pageId}/children`, token, {
            children: blocks.slice(i, i+100)
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── /api/notion/* — general Notion proxy ──────────────────────────────────
  if (pathname.startsWith('/api/notion')) {
    const notionPath = pathname.replace('/api/notion', '') || '/';
    const body = await readBody(req);
    const reqHeaders = {
      'Authorization': req.headers['authorization'] || '',
      'Notion-Version': req.headers['notion-version'] || '2022-06-28',
      'Content-Type': 'application/json',
    };
    if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body, 'utf8').toString();

    const proxyRes = await new Promise((resolve) => {
      const proxyReq = https.request({ hostname:'api.notion.com', path:notionPath, method, headers:reqHeaders }, r => {
        let data = '';
        r.on('data', chunk => { data += chunk; });
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      proxyReq.on('error', err => resolve({ status:500, body: JSON.stringify({ error: err.message }) }));
      if (body) proxyReq.write(body);
      proxyReq.end();
    });

    res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
    res.end(proxyRes.body || '{}');
    return;
  }

  // ── /api/claude — Claude proxy ────────────────────────────────────────────
  if (pathname === '/api/claude') {
    const body = await readBody(req);
    let parsed2;
    try { parsed2 = JSON.parse(body); } catch(e) { res.writeHead(400); res.end('Bad JSON'); return; }
    const apiKey = parsed2.anthropic_api_key || '';
    delete parsed2.anthropic_api_key;
    if (!apiKey) { res.writeHead(401); res.end(JSON.stringify({ error:{ message:'No API key' } })); return; }
    const cleanBody = JSON.stringify(parsed2);
    const proxyRes = await new Promise((resolve) => {
      const proxyReq = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(cleanBody).toString(), 'anthropic-version':'2023-06-01', 'x-api-key': apiKey }
      }, r => {
        let data = '';
        r.on('data', chunk => { data += chunk; });
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      proxyReq.on('error', err => resolve({ status:500, body: JSON.stringify({ error: err.message }) }));
      proxyReq.write(cleanBody);
      proxyReq.end();
    });
    res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
    res.end(proxyRes.body);
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 Not Found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Study Hub running on port ${PORT}`));
