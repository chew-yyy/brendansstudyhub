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

// Convert HTML to Notion Markdown (for replace_content style blocks)
function htmlToNotionMarkdown(html) {
  return html
    // Headings
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, (_, t) => `# ${stripTags(t)}\n`)
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, (_, t) => `## ${stripTags(t)}\n`)
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, (_, t) => `### ${stripTags(t)}\n`)
    // Callouts
    .replace(/<div[^>]*class="callout info"[^>]*>[\s\S]*?<div[^>]*class="callout-icon"[^>]*>(.*?)<\/div>[\s\S]*?<div[^>]*class="callout-content"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/div>/gi,
      (_, icon, text) => `> ℹ️ ${stripTags(text).trim()}\n`)
    .replace(/<div[^>]*class="callout warning"[^>]*>[\s\S]*?<div[^>]*class="callout-icon"[^>]*>(.*?)<\/div>[\s\S]*?<div[^>]*class="callout-content"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/div>/gi,
      (_, icon, text) => `> ⚠️ ${stripTags(text).trim()}\n`)
    .replace(/<div[^>]*class="callout success"[^>]*>[\s\S]*?<div[^>]*class="callout-icon"[^>]*>(.*?)<\/div>[\s\S]*?<div[^>]*class="callout-content"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/div>/gi,
      (_, icon, text) => `> ✅ ${stripTags(text).trim()}\n`)
    .replace(/<div[^>]*class="callout danger"[^>]*>[\s\S]*?<div[^>]*class="callout-icon"[^>]*>(.*?)<\/div>[\s\S]*?<div[^>]*class="callout-content"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/div>/gi,
      (_, icon, text) => `> 🔴 ${stripTags(text).trim()}\n`)
    // Code blocks
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => `\`\`\`\n${stripTags(code)}\n\`\`\`\n`)
    // Blockquote
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => `> ${stripTags(t).trim()}\n`)
    // Lists
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) =>
      inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, item) => `- ${stripTags(item).trim()}\n`))
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
      let i = 1;
      return inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, item) => `${i++}. ${stripTags(item).trim()}\n`);
    })
    // Images
    .replace(/<figure[^>]*>[\s\S]*?<img[^>]*src="([^"]*)"[^>]*>[\s\S]*?<\/figure>/gi, (_, src) => `![image](${src})\n`)
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, (_, src) => `![image](${src})\n`)
    // HR
    .replace(/<hr\s*\/?>/gi, '---\n')
    // Inline formatting
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, (_, t) => `**${t}**`)
    .replace(/<b[^>]*>(.*?)<\/b>/gi, (_, t) => `**${t}**`)
    .replace(/<em[^>]*>(.*?)<\/em>/gi, (_, t) => `*${t}*`)
    .replace(/<i[^>]*>(.*?)<\/i>/gi, (_, t) => `*${t}*`)
    .replace(/<u[^>]*>(.*?)<\/u>/gi, (_, t) => t)
    .replace(/<s[^>]*>(.*?)<\/s>/gi, (_, t) => `~~${t}~~`)
    .replace(/<code[^>]*>(.*?)<\/code>/gi, (_, t) => `\`${t}\``)
    .replace(/<mark[^>]*>(.*?)<\/mark>/gi, (_, t) => t)
    // Paragraphs
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => {
      const text = stripTags(t).trim();
      return text ? `${text}\n` : '';
    })
    // Line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip any remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    // Collapse 3+ newlines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  setCORS(res);
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /api/save-note ─────────────────────────────────────────────────────────
  if (pathname === '/api/save-note' && method === 'POST') {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch(e) { res.writeHead(400); res.end('Bad JSON'); return; }

    const { pageId, title, html, preview, token } = body;
    if (!pageId || !token) { res.writeHead(400); res.end('Missing pageId or token'); return; }

    try {
      // 1. Update title + preview properties
      await notionCall('PATCH', `/v1/pages/${pageId}`, token, {
        properties: {
          Title:   { title:[{ text:{ content: title || 'Untitled' } }] },
          Preview: { rich_text:[{ text:{ content: (preview || '').slice(0, 200) } }] }
        }
      });

      // 2. Convert HTML to markdown for Notion blocks
      const markdown = htmlToNotionMarkdown(html || '');

      // 3. Get existing block IDs and delete them all
      let cursor;
      const existingIds = [];
      do {
        const path = `/v1/blocks/${pageId}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : '');
        const r = await notionCall('GET', path, token, null);
        (r.body?.results || []).forEach(b => existingIds.push(b.id));
        cursor = r.body?.has_more ? r.body.next_cursor : null;
      } while (cursor);

      for (const bid of existingIds) {
        await notionCall('DELETE', `/v1/blocks/${bid}`, token, null);
      }

      // 4. Convert markdown to blocks and append
      if (markdown.trim()) {
        const blocks = markdownToBlocks(markdown);
        for (let i = 0; i < blocks.length; i += 100) {
          await notionCall('PATCH', `/v1/blocks/${pageId}/children`, token, {
            children: blocks.slice(i, i + 100)
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(err) {
      console.error('save-note error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── /api/notion/* ──────────────────────────────────────────────────────────
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
      const proxyReq = https.request({ hostname: 'api.notion.com', path: notionPath, method, headers: reqHeaders }, r => {
        let data = '';
        r.on('data', chunk => { data += chunk; });
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      proxyReq.on('error', err => resolve({ status: 500, body: JSON.stringify({ error: err.message }) }));
      if (body) proxyReq.write(body);
      proxyReq.end();
    });

    res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
    res.end(proxyRes.body || '{}');
    return;
  }

  // ── /api/claude ────────────────────────────────────────────────────────────
  if (pathname === '/api/claude') {
    const body = await readBody(req);
    let parsed2;
    try { parsed2 = JSON.parse(body); } catch(e) { res.writeHead(400); res.end('Bad JSON'); return; }
    const apiKey = parsed2.anthropic_api_key || '';
    delete parsed2.anthropic_api_key;
    if (!apiKey) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'No API key' } })); return; }
    const cleanBody = JSON.stringify(parsed2);
    const proxyRes = await new Promise((resolve) => {
      const proxyReq = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(cleanBody).toString(),
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey
        }
      }, r => {
        let data = '';
        r.on('data', chunk => { data += chunk; });
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      proxyReq.on('error', err => resolve({ status: 500, body: JSON.stringify({ error: err.message }) }));
      proxyReq.write(cleanBody);
      proxyReq.end();
    });
    res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
    res.end(proxyRes.body);
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────────
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

function markdownToBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ object:'block', type:'code', code:{ rich_text:[{ type:'text', text:{ content: codeLines.join('\n') } }], language:'plain text' } });
      i++;
      continue;
    }

    if (line.startsWith('# '))   { blocks.push({ object:'block', type:'heading_1', heading_1:{ rich_text: rt(line.slice(2)) } }); i++; continue; }
    if (line.startsWith('## '))  { blocks.push({ object:'block', type:'heading_2', heading_2:{ rich_text: rt(line.slice(3)) } }); i++; continue; }
    if (line.startsWith('### ')) { blocks.push({ object:'block', type:'heading_3', heading_3:{ rich_text: rt(line.slice(4)) } }); i++; continue; }
    if (line.startsWith('> '))   { blocks.push({ object:'block', type:'quote',     quote:{ rich_text: rt(line.slice(2)) } }); i++; continue; }
    if (line.startsWith('- '))   { blocks.push({ object:'block', type:'bulleted_list_item', bulleted_list_item:{ rich_text: rt(line.slice(2)) } }); i++; continue; }
    if (/^\d+\. /.test(line))    { blocks.push({ object:'block', type:'numbered_list_item', numbered_list_item:{ rich_text: rt(line.replace(/^\d+\. /,'')) } }); i++; continue; }
    if (line === '---')          { blocks.push({ object:'block', type:'divider', divider:{} }); i++; continue; }
    if (/^!\[.*?\]\((.+?)\)/.test(line)) {
      const m = line.match(/^!\[.*?\]\((.+?)\)/);
      if (m) blocks.push({ object:'block', type:'image', image:{ type:'external', external:{ url: m[1] } } });
      i++; continue;
    }

    const text = line.trim();
    if (text) blocks.push({ object:'block', type:'paragraph', paragraph:{ rich_text: rt(text) } });
    i++;
  }

  return blocks;
}

function rt(text) {
  // Parse inline markdown: bold, italic, code
  const segments = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~)/g;
  let last = 0, m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) segments.push({ type:'text', text:{ content: text.slice(last, m.index) }, annotations:{} });
    if (m[2]) segments.push({ type:'text', text:{ content: m[2] }, annotations:{ bold:true } });
    else if (m[3]) segments.push({ type:'text', text:{ content: m[3] }, annotations:{ italic:true } });
    else if (m[4]) segments.push({ type:'text', text:{ content: m[4] }, annotations:{ code:true } });
    else if (m[5]) segments.push({ type:'text', text:{ content: m[5] }, annotations:{ strikethrough:true } });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type:'text', text:{ content: text.slice(last) }, annotations:{} });
  return segments.length ? segments : [{ type:'text', text:{ content: text } }];
}

server.listen(PORT, () => console.log(`Study Hub running on port ${PORT}`));
