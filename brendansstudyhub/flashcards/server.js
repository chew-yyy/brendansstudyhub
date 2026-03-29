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

  // ── /api/calendar/* — Google Calendar with OAuth refresh ────────────────────
  if (pathname.startsWith('/api/calendar')) {
    // Get access token — either from request header (manual) or via refresh token
    async function getAccessToken() {
      // Allow manual token from client header (for testing)
      const manualToken = req.headers['x-gcal-token'];
      if (manualToken) return manualToken;

      // Use OAuth refresh token stored in Render env vars
      const clientId     = process.env.GCAL_CLIENT_ID;
      const clientSecret = process.env.GCAL_CLIENT_SECRET;
      const refreshToken = process.env.GCAL_REFRESH_TOKEN;

      if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('Google Calendar not configured. Add GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REFRESH_TOKEN to Render environment variables.');
      }

      const body = new URLSearchParams({ grant_type:'refresh_token', client_id:clientId, client_secret:clientSecret, refresh_token:refreshToken }).toString();
      return new Promise((resolve, reject) => {
        const r = https.request({ hostname:'oauth2.googleapis.com', path:'/token', method:'POST',
          headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) }
        }, res2 => {
          let d=''; res2.on('data',c=>{d+=c;}); res2.on('end',()=>{
            const j=JSON.parse(d);
            if(j.access_token) resolve(j.access_token);
            else reject(new Error(j.error_description||j.error||'Token refresh failed'));
          });
        });
        r.on('error',reject); r.write(body); r.end();
      });
    }

    function gcalCall(accessToken, method, gcalPath, body) {
      return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
        if (data) headers['Content-Length'] = Buffer.byteLength(data, 'utf8').toString();
        const r = https.request({ hostname:'www.googleapis.com', path:gcalPath, method, headers }, res2 => {
          let d=''; res2.on('data',c=>{d+=c;}); res2.on('end',()=>{
            try { resolve({ status:res2.statusCode, body:JSON.parse(d) }); }
            catch(e) { resolve({ status:res2.statusCode, body:{} }); }
          });
        });
        r.on('error',reject);
        if(data) r.write(data);
        r.end();
      });
    }

    let accessToken;
    try { accessToken = await getAccessToken(); }
    catch(err) {
      setCORS(res);
      res.writeHead(401, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    // GET /api/calendar/events
    if (pathname === '/api/calendar/events' && method === 'GET') {
      const { timeMin, timeMax } = parsed.query;
      const qs = new URLSearchParams({ singleEvents:'true', orderBy:'startTime', maxResults:'50',
        timeMin: timeMin||new Date().toISOString(), timeMax: timeMax||(new Date(Date.now()+30*86400000).toISOString())
      }).toString();
      const r = await gcalCall(accessToken, 'GET', `/calendar/v3/calendars/primary/events?${qs}`, null);
      const events = (r.body.items||[]).map(ev => ({
        id:ev.id, summary:ev.summary||'', description:ev.description||'', location:ev.location||'',
        start:ev.start, end:ev.end, allDay:!ev.start?.dateTime
      }));
      setCORS(res); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({events}));
      return;
    }

    // POST /api/calendar/create
    if (pathname === '/api/calendar/create' && method === 'POST') {
      const body = await readBody(req);
      let ev; try { ev=JSON.parse(body); } catch(e) { res.writeHead(400); res.end('Bad JSON'); return; }
      const r = await gcalCall(accessToken, 'POST', '/calendar/v3/calendars/primary/events', ev);
      setCORS(res); res.writeHead(r.status,{'Content-Type':'application/json'}); res.end(JSON.stringify(r.body));
      return;
    }

    // DELETE /api/calendar/delete
    if (pathname === '/api/calendar/delete' && method === 'DELETE') {
      const { eventId } = parsed.query;
      if (!eventId) { res.writeHead(400); res.end('Missing eventId'); return; }
      const r = await gcalCall(accessToken, 'DELETE', `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, null);
      setCORS(res); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
      return;
    }

    setCORS(res); res.writeHead(404); res.end('Not found'); return;
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

  // ── Direct weekly-planner route (bypass filesystem) ─────────────────────────
  if (pathname === '/weekly-planner.html' || pathname === '/weekly-planner') {
    const WEEKLY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Weekly Planner</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=IBM+Plex+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#242424; --surf:#2e2e2e; --surf2:#363636; --surf3:#404040;
  --bdr:#484848; --bdr2:#585858;
  --txt:#f0f0f0; --txt2:#a0a0a0; --txt3:#606060;
  --acc:#e8e8e8; --green:#6abf7b; --red:#d96b6b; --blue:#6b9fd4; --amber:#d4a96b; --purple:#a78fd4; --orange:#d4906b;
  --shadow:rgba(0,0,0,0.5);
  --safe-bottom:env(safe-area-inset-bottom,0px);
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--txt);font-family:'IBM Plex Mono',monospace}
.shell{height:100vh;display:flex;flex-direction:column}

/* ── Topbar ── */
.topbar{height:52px;border-bottom:1px solid var(--bdr);padding:0 16px;display:flex;align-items:center;gap:10px;background:var(--surf);flex-shrink:0}
.back-btn{background:none;border:1px solid var(--bdr);border-radius:3px;color:var(--txt2);font-size:0.8rem;width:32px;height:32px;display:flex;align-items:center;justify-content:center;transition:all .15s;text-decoration:none;flex-shrink:0}
.back-btn:hover{border-color:var(--bdr2);color:var(--txt)}
.topbar-title{font-family:'Syne',sans-serif;font-size:0.9rem;font-weight:700;flex:1}
.week-nav{display:flex;align-items:center;gap:8px;flex-shrink:0}
.nav-btn{background:none;border:1px solid var(--bdr);border-radius:3px;color:var(--txt2);cursor:pointer;font-size:0.75rem;padding:4px 9px;font-family:'IBM Plex Mono',monospace;transition:all .15s}
.nav-btn:hover{border-color:var(--bdr2);color:var(--txt)}
.week-lbl{font-family:'Syne',sans-serif;font-size:0.78rem;font-weight:700;min-width:130px;text-align:center;cursor:pointer;transition:color .12s}
.week-lbl:hover{color:var(--blue)}
.notion-dot{width:5px;height:5px;border-radius:50%;background:var(--bdr2);transition:background .3s;flex-shrink:0}
.notion-dot.ok{background:var(--green)}
.add-btn{background:var(--blue);border:none;border-radius:3px;color:#fff;cursor:pointer;font-size:0.65rem;letter-spacing:1px;text-transform:uppercase;padding:6px 12px;font-family:'IBM Plex Mono',monospace;transition:background .15s;white-space:nowrap;flex-shrink:0}
.add-btn:hover{background:#5a8ec3}

/* ── Main layout ── */
.main{flex:1;display:flex;overflow:hidden}

/* ── Week grid ── */
.week-grid{flex:1;display:grid;grid-template-columns:repeat(7,1fr);overflow:hidden;border-right:none}
.day-col{display:flex;flex-direction:column;border-right:1px solid var(--bdr);overflow:hidden}
.day-col:last-child{border-right:none}

/* Day header */
.day-header{padding:10px 8px 8px;border-bottom:1px solid var(--bdr);background:var(--surf);flex-shrink:0;text-align:center}
.day-name{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--txt3);margin-bottom:3px}
.day-date{font-family:'Syne',sans-serif;font-size:1rem;font-weight:700;color:var(--txt);line-height:1}
.day-header.today .day-date{color:var(--blue)}
.day-header.today{background:rgba(107,159,212,.06)}
.day-count{font-size:0.55rem;color:var(--txt3);margin-top:3px;letter-spacing:.5px}

/* Task list inside day */
.day-tasks{flex:1;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:4px;-webkit-overflow-scrolling:touch}
.day-tasks::-webkit-scrollbar{width:3px}
.day-tasks::-webkit-scrollbar-thumb{background:var(--bdr2);border-radius:2px}

/* Add task drop zone */
.day-drop-zone{min-height:32px;border:1px dashed transparent;border-radius:4px;transition:all .15s;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:auto}
.day-drop-zone:hover{border-color:var(--bdr2);background:var(--surf2)}
.day-drop-zone-icon{font-size:0.75rem;color:var(--txt3);opacity:0}
.day-drop-zone:hover .day-drop-zone-icon{opacity:1}

/* Task card */
.task-card{background:var(--surf);border:1px solid var(--bdr);border-radius:5px;padding:7px 8px;cursor:pointer;transition:border-color .12s,background .12s,opacity .15s;position:relative;overflow:hidden;border-left:3px solid transparent;flex-shrink:0}
.task-card:hover{border-color:var(--bdr2);background:var(--surf2)}
.task-card.done{opacity:.4}
.task-card.p-high{border-left-color:var(--red)}
.task-card.p-medium{border-left-color:var(--amber)}
.task-card.p-low{border-left-color:var(--txt3)}
.task-card.c-study{border-left-color:var(--blue)}
.task-card.c-assignment{border-left-color:var(--red)}
.task-card.c-exam{border-left-color:var(--orange)}
.task-card.c-personal{border-left-color:var(--purple)}
.task-card.c-work{border-left-color:var(--green)}
.task-title{font-size:0.7rem;color:var(--txt);line-height:1.35;margin-bottom:4px;padding-right:18px;font-family:'Syne',sans-serif;font-weight:600}
.task-card.done .task-title{text-decoration:line-through;color:var(--txt3)}
.task-meta{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.task-tag{font-size:0.52rem;text-transform:uppercase;letter-spacing:.8px;padding:1px 5px;border-radius:2px;border:1px solid;flex-shrink:0}
.tag-study{color:var(--blue);border-color:rgba(107,159,212,.4)}
.tag-assignment{color:var(--red);border-color:rgba(217,107,107,.4)}
.tag-exam{color:var(--orange);border-color:rgba(212,144,107,.4)}
.tag-personal{color:var(--purple);border-color:rgba(167,143,212,.4)}
.tag-work{color:var(--green);border-color:rgba(106,191,123,.4)}
.tag-other{color:var(--txt3);border-color:var(--bdr)}
.tag-high{color:var(--red);border-color:rgba(217,107,107,.4)}
.tag-medium{color:var(--amber);border-color:rgba(212,169,107,.4)}
.tag-low{color:var(--txt3);border-color:var(--bdr)}
.task-check{position:absolute;top:6px;right:6px;width:15px;height:15px;border-radius:50%;border:1.5px solid var(--bdr2);cursor:pointer;transition:all .12s;background:transparent;display:flex;align-items:center;justify-content:center;font-size:0.55rem}
.task-check:hover{border-color:var(--green)}
.task-card.done .task-check{background:var(--green);border-color:var(--green)}
.task-card.done .task-check::after{content:'✓';color:var(--bg);font-weight:700}

/* ── Sidebar summary ── */
.summary{width:190px;border-left:1px solid var(--bdr);background:var(--surf);display:flex;flex-direction:column;flex-shrink:0;overflow-y:auto;padding-bottom:var(--safe-bottom)}
.sb{padding:12px 14px 10px;border-bottom:1px solid var(--bdr)}
.sb-lbl{font-size:0.56rem;text-transform:uppercase;letter-spacing:2px;color:var(--txt3);display:block;margin-bottom:8px}
.sb-stat{display:flex;justify-content:space-between;font-size:0.68rem;margin-bottom:5px;color:var(--txt2)}
.sb-val{font-family:'Syne',sans-serif;font-weight:700;color:var(--txt)}
.prog{height:3px;background:var(--surf3);border-radius:2px;overflow:hidden;margin-top:6px}
.prog-fill{height:100%;background:var(--blue);transition:width .4s;border-radius:2px}

/* Category breakdown */
.cat-row{display:flex;align-items:center;gap:7px;margin-bottom:5px;font-size:0.67rem;color:var(--txt2)}
.cat-dot{width:7px;height:7px;border-radius:2px;flex-shrink:0}
.cat-count{margin-left:auto;font-family:'Syne',sans-serif;font-weight:700;font-size:0.7rem;color:var(--txt)}

/* Priority breakdown */
.pri-row{display:flex;align-items:center;gap:5px;font-size:0.65rem;color:var(--txt2);margin-bottom:5px}
.pri-bar-wrap{flex:1;height:4px;background:var(--surf3);border-radius:2px;overflow:hidden}
.pri-bar{height:100%;border-radius:2px;transition:width .4s}

/* Loading */
.loading-row{display:flex;align-items:center;gap:8px;padding:12px 6px;color:var(--txt3);font-size:0.68rem}
.spinner{width:11px;height:11px;border:2px solid var(--bdr);border-top-color:var(--blue);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── Modal ── */
.modal-back{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:300;align-items:flex-end;justify-content:center}
.modal-back.open{display:flex}
.modal{background:var(--surf);border:1px solid var(--bdr2);border-radius:10px 10px 0 0;padding:20px 18px calc(20px + var(--safe-bottom));width:100%;max-width:460px;box-shadow:0 -8px 32px var(--shadow);animation:slideup .2s ease}
@keyframes slideup{from{transform:translateY(100%)}to{transform:translateY(0)}}
.modal h3{font-family:'Syne',sans-serif;font-size:0.9rem;font-weight:700;margin-bottom:14px}
.mf{margin-bottom:9px}
.mf label{font-size:0.57rem;text-transform:uppercase;letter-spacing:2px;color:var(--txt3);display:block;margin-bottom:4px}
.mf input,.mf select,.mf textarea{font-family:'IBM Plex Mono',monospace;font-size:0.75rem;padding:7px 9px;border:1px solid var(--bdr);background:var(--surf2);color:var(--txt);border-radius:3px;outline:none;width:100%;-webkit-appearance:none;transition:border-color .15s}
.mf input:focus,.mf select:focus,.mf textarea:focus{border-color:var(--blue)}
.mf select option{background:var(--surf2)}
.mg{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pills{display:flex;gap:4px;flex-wrap:wrap}
.pill{font-family:'IBM Plex Mono',monospace;font-size:0.6rem;padding:3px 9px;border-radius:20px;border:1px solid var(--bdr);background:var(--surf2);color:var(--txt2);cursor:pointer;transition:all .15s}
.pill:hover{border-color:var(--bdr2);color:var(--txt)}
.pill.a-study{background:rgba(107,159,212,.2);border-color:var(--blue);color:var(--blue)}
.pill.a-assignment{background:rgba(217,107,107,.2);border-color:var(--red);color:var(--red)}
.pill.a-exam{background:rgba(212,144,107,.2);border-color:var(--orange);color:var(--orange)}
.pill.a-personal{background:rgba(167,143,212,.2);border-color:var(--purple);color:var(--purple)}
.pill.a-work{background:rgba(106,191,123,.2);border-color:var(--green);color:var(--green)}
.pill.a-other{background:var(--surf3);border-color:var(--bdr2);color:var(--txt2)}
.pill.a-high{background:rgba(217,107,107,.15);border-color:var(--red);color:var(--red)}
.pill.a-medium{background:rgba(212,169,107,.15);border-color:var(--amber);color:var(--amber)}
.pill.a-low{background:var(--surf3);border-color:var(--bdr2);color:var(--txt3)}
.macts{display:flex;gap:7px;margin-top:13px;justify-content:space-between;align-items:center}
.macts-r{display:flex;gap:7px}
.btn{font-family:'IBM Plex Mono',monospace;font-size:0.66rem;letter-spacing:1.5px;text-transform:uppercase;padding:7px 13px;border:1px solid var(--acc);background:var(--acc);color:var(--bg);cursor:pointer;border-radius:2px;transition:all .15s;font-weight:500}
.btn:hover{background:var(--txt2);border-color:var(--txt2)}
.btn:disabled{opacity:.35;cursor:not-allowed}
.btn.out{background:transparent;color:var(--txt2);border-color:var(--bdr2)}
.btn.out:hover{color:var(--txt);border-color:var(--txt);background:var(--surf2)}
.btn.del{background:transparent;border-color:var(--bdr);color:var(--txt3)}
.btn.del:hover{border-color:var(--red);color:var(--red)}
.btn.sm{padding:5px 10px;font-size:0.61rem}
@media(min-width:681px){
  .modal-back{align-items:center}
  .modal{border-radius:6px;max-width:400px;padding:20px 22px;animation:fadein .18s ease}
  @keyframes fadein{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
}

/* Toast */
.toast{position:fixed;bottom:calc(20px + var(--safe-bottom));left:50%;transform:translateX(-50%);background:var(--surf2);border:1px solid var(--bdr2);border-radius:20px;padding:8px 18px;font-size:0.72rem;color:var(--txt2);z-index:9999;animation:fadeup .2s ease;pointer-events:none;white-space:nowrap}
.toast.ok{border-color:var(--green);color:var(--green)}
.toast.err{border-color:var(--red);color:var(--red)}
@keyframes fadeup{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

/* Mobile */
@media(max-width:900px){
  .summary{display:none}
  .week-grid{grid-template-columns:repeat(7,minmax(90px,1fr));overflow-x:auto}
}
@media(max-width:600px){
  .topbar{height:48px;padding:0 10px;gap:6px}
  .week-lbl{min-width:100px;font-size:0.72rem}
}
</style>
</head>
<body>
<div class="shell">
  <div class="topbar">
    <a class="back-btn" href="index.html">←</a>
    <div class="topbar-title">Weekly Planner</div>
    <div class="week-nav">
      <button class="nav-btn" id="btn-prev">◀</button>
      <div class="week-lbl" id="week-lbl" title="Click for current week">This Week</div>
      <button class="nav-btn" id="btn-next">▶</button>
    </div>
    <div class="notion-dot" id="notion-dot" title="Notion sync"></div>
    <button class="add-btn" id="btn-add">+ Task</button>
  </div>

  <div class="main">
    <!-- Week grid -->
    <div class="week-grid" id="week-grid"></div>

    <!-- Summary sidebar -->
    <div class="summary">
      <div class="sb">
        <span class="sb-lbl">Week Summary</span>
        <div class="sb-stat"><span>Total tasks</span><span class="sb-val" id="s-total">0</span></div>
        <div class="sb-stat"><span>Completed</span><span class="sb-val" id="s-done">0</span></div>
        <div class="sb-stat"><span>Remaining</span><span class="sb-val" id="s-left">0</span></div>
        <div class="prog"><div class="prog-fill" id="s-prog" style="width:0%"></div></div>
      </div>
      <div class="sb">
        <span class="sb-lbl">By Category</span>
        <div class="cat-row"><div class="cat-dot" style="background:var(--blue)"></div>Study<span class="cat-count" id="c-study">0</span></div>
        <div class="cat-row"><div class="cat-dot" style="background:var(--red)"></div>Assignment<span class="cat-count" id="c-assignment">0</span></div>
        <div class="cat-row"><div class="cat-dot" style="background:var(--orange)"></div>Exam<span class="cat-count" id="c-exam">0</span></div>
        <div class="cat-row"><div class="cat-dot" style="background:var(--purple)"></div>Personal<span class="cat-count" id="c-personal">0</span></div>
        <div class="cat-row"><div class="cat-dot" style="background:var(--green)"></div>Work<span class="cat-count" id="c-work">0</span></div>
        <div class="cat-row"><div class="cat-dot" style="background:var(--txt3)"></div>Other<span class="cat-count" id="c-other">0</span></div>
      </div>
      <div class="sb">
        <span class="sb-lbl">By Priority</span>
        <div class="pri-row">
          <span style="width:48px;color:var(--red)">High</span>
          <div class="pri-bar-wrap"><div class="pri-bar" id="pb-high" style="background:var(--red);width:0%"></div></div>
          <span class="sb-val" id="pc-high" style="min-width:20px;text-align:right;font-size:0.65rem">0</span>
        </div>
        <div class="pri-row">
          <span style="width:48px;color:var(--amber)">Med</span>
          <div class="pri-bar-wrap"><div class="pri-bar" id="pb-med" style="background:var(--amber);width:0%"></div></div>
          <span class="sb-val" id="pc-med" style="min-width:20px;text-align:right;font-size:0.65rem">0</span>
        </div>
        <div class="pri-row">
          <span style="width:48px;color:var(--txt3)">Low</span>
          <div class="pri-bar-wrap"><div class="pri-bar" id="pb-low" style="background:var(--txt3);width:0%"></div></div>
          <span class="sb-val" id="pc-low" style="min-width:20px;text-align:right;font-size:0.65rem">0</span>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Add / Edit modal -->
<div class="modal-back" id="modal-back">
  <div class="modal">
    <h3 id="m-title">New Task</h3>
    <div class="mf"><label>Task</label><input type="text" id="m-task" placeholder="What do you need to do?"></div>
    <div class="mg">
      <div class="mf"><label>Day</label>
        <select id="m-day">
          <option>Monday</option><option>Tuesday</option><option>Wednesday</option>
          <option>Thursday</option><option>Friday</option><option>Saturday</option><option>Sunday</option>
        </select>
      </div>
      <div class="mf"><label>Priority</label>
        <div class="pills" id="pri-pills">
          <button class="pill a-high" data-p="High">🔴 High</button>
          <button class="pill" data-p="Medium">🟡 Med</button>
          <button class="pill" data-p="Low">⚪ Low</button>
        </div>
      </div>
    </div>
    <div class="mf"><label>Category</label>
      <div class="pills" id="cat-pills">
        <button class="pill a-study" data-c="Study">📚 Study</button>
        <button class="pill" data-c="Assignment">📝 Assignment</button>
        <button class="pill" data-c="Exam">🎯 Exam</button>
        <button class="pill" data-c="Personal">⭐ Personal</button>
        <button class="pill" data-c="Work">💼 Work</button>
        <button class="pill" data-c="Other">📌 Other</button>
      </div>
    </div>
    <div class="mf"><label>Notes</label><textarea id="m-notes" rows="2" placeholder="Optional notes…"></textarea></div>
    <div class="macts">
      <button class="btn del sm" id="m-del" style="display:none">Delete</button>
      <div class="macts-r">
        <button class="btn out sm" id="m-cancel">Cancel</button>
        <button class="btn sm" id="m-save">Save</button>
      </div>
    </div>
  </div>
</div>

<script>
// ── Config ────────────────────────────────────────────────────────────────────
const WEEKLY_DB  = 'a574928b6106459cbfc37b5f0f016a7a';
const PROXY      = '/api/notion';
const NOTION_VER = '2022-06-28';

let NOTION_TOKEN = localStorage.getItem('fc_notion_token') || '';
const nhdr = () => ({ 'Authorization':\`Bearer \${NOTION_TOKEN}\`, 'Content-Type':'application/json', 'Notion-Version':NOTION_VER });

async function nPost(path, body) {
  const r = await fetch(PROXY+\`/v1\${path}\`, { method:'POST', headers:nhdr(), body:JSON.stringify(body) });
  if (!r.ok) { const e = await r.json(); throw new Error(e.message||r.status); }
  return r.json();
}
async function nPatch(path, body) {
  const r = await fetch(PROXY+\`/v1\${path}\`, { method:'PATCH', headers:nhdr(), body:JSON.stringify(body) });
  if (!r.ok) { const e = await r.json(); throw new Error(e.message||r.status); }
  return r.json();
}

// ── State ─────────────────────────────────────────────────────────────────────
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
let weekOffset = 0;
let tasks = [];
let editId = null;
let mCat = 'Study';
let mPri = 'High';

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const uid = () => Math.random().toString(36).slice(2,10);

function toast(msg,type='') {
  const el=document.createElement('div'); el.className='toast'+(type?' '+type:''); el.textContent=msg;
  document.body.appendChild(el); setTimeout(()=>el.remove(),2800);
}
function setConnected(ok) { document.getElementById('notion-dot').classList.toggle('ok',ok); }

// ── Week helpers ──────────────────────────────────────────────────────────────
function getWeekMonday(offset=0) {
  const now = new Date(); now.setHours(0,0,0,0);
  const day = now.getDay(); // 0=Sun
  const diff = (day===0?-6:1-day); // adjust to Monday
  const monday = new Date(now); monday.setDate(now.getDate()+diff+offset*7);
  return monday;
}
function fmtDate(d) { return \`\${d.getFullYear()}-\${String(d.getMonth()+1).padStart(2,'0')}-\${String(d.getDate()).padStart(2,'0')}\`; }
function addDays(d,n) { const r=new Date(d); r.setDate(r.getDate()+n); return r; }
function isToday(d) { const t=new Date(); return d.getDate()===t.getDate()&&d.getMonth()===t.getMonth()&&d.getFullYear()===t.getFullYear(); }

// ── Week label ────────────────────────────────────────────────────────────────
function updateWeekLabel() {
  const mon = getWeekMonday(weekOffset);
  const sun = addDays(mon,6);
  const el = document.getElementById('week-lbl');
  if (weekOffset===0) el.textContent='This Week';
  else if (weekOffset===1) el.textContent='Next Week';
  else if (weekOffset===-1) el.textContent='Last Week';
  else el.textContent=\`\${mon.getDate()} \${MONTHS[mon.getMonth()]} – \${sun.getDate()} \${MONTHS[sun.getMonth()]}\`;
}

// ── Load from Notion ──────────────────────────────────────────────────────────
async function loadWeek() {
  const mon = getWeekMonday(weekOffset);
  const sun = addDays(mon,6);
  const monStr = fmtDate(mon);
  const sunStr = fmtDate(sun);

  renderGrid([]); // show loading state
  if (!NOTION_TOKEN) { setConnected(false); tasks=[]; renderGrid([]); return; }

  try {
    const r = await nPost(\`/databases/\${WEEKLY_DB}/query\`, {
      filter: { and: [
        { property:'Week', date:{ on_or_after: monStr } },
        { property:'Week', date:{ on_or_before: sunStr } }
      ]},
      sorts: [{ property:'Day', direction:'ascending' }],
      page_size: 200
    });
    tasks = (r.results||[]).map(p => ({
      id:       p.id,
      notionId: p.id,
      task:     p.properties?.Task?.title?.[0]?.plain_text || '',
      day:      p.properties?.Day?.select?.name || 'Monday',
      category: p.properties?.Category?.select?.name || 'Other',
      priority: p.properties?.Priority?.select?.name || 'Medium',
      done:     p.properties?.Done?.checkbox || false,
      notes:    p.properties?.Notes?.rich_text?.[0]?.plain_text || '',
      week:     p.properties?.Week?.date?.start || monStr,
    }));
    setConnected(true);
    renderGrid(tasks);
  } catch(err) {
    setConnected(false);
    toast('Could not load from Notion','err');
    renderGrid([]);
  }
}

// ── Save to Notion ────────────────────────────────────────────────────────────
async function saveToNotion(task) {
  const mon = getWeekMonday(weekOffset);
  const weekStr = fmtDate(mon);
  const props = {
    Task:     { title:[{ text:{ content: task.task } }] },
    Day:      { select:{ name: task.day } },
    Category: { select:{ name: task.category } },
    Priority: { select:{ name: task.priority } },
    Done:     { checkbox: task.done||false },
    Notes:    { rich_text: task.notes?[{ text:{ content: task.notes } }]:[] },
    Week:     { date:{ start: weekStr } }
  };
  if (task.notionId) {
    await nPatch(\`/pages/\${task.notionId}\`, { properties: props });
  } else {
    const p = await nPost('/pages', { parent:{ database_id: WEEKLY_DB }, properties: props });
    task.notionId = p.id;
    task.id = p.id;
  }
}

// ── Render grid ───────────────────────────────────────────────────────────────
function renderGrid(taskList) {
  updateWeekLabel();
  const mon = getWeekMonday(weekOffset);
  const grid = document.getElementById('week-grid');
  grid.innerHTML='';

  DAYS.forEach((day, i) => {
    const date = addDays(mon, i);
    const dayTasks = taskList.filter(t=>t.day===day);

    const col = document.createElement('div'); col.className='day-col';

    // Header
    const hdr = document.createElement('div');
    hdr.className='day-header'+(isToday(date)?' today':'');
    hdr.innerHTML=\`<div class="day-name">\${day.slice(0,3)}</div><div class="day-date">\${date.getDate()}</div><div class="day-count">\${dayTasks.length} task\${dayTasks.length!==1?'s':''}</div>\`;
    col.appendChild(hdr);

    // Tasks
    const taskWrap = document.createElement('div'); taskWrap.className='day-tasks';

    if (dayTasks.length===0 && !NOTION_TOKEN) {
      const lr=document.createElement('div'); lr.className='loading-row';
      lr.innerHTML='<div style="font-size:0.62rem;color:var(--txt3)">Add token in Settings</div>';
      taskWrap.appendChild(lr);
    } else if (dayTasks.length===0) {
      // Empty — just show drop zone
    } else {
      dayTasks.forEach(t => taskWrap.appendChild(makeTaskCard(t)));
    }

    // Drop zone / add button
    const dz = document.createElement('div'); dz.className='day-drop-zone';
    dz.innerHTML='<div class="day-drop-zone-icon">+</div>';
    dz.addEventListener('click', ()=>openAdd(day));
    taskWrap.appendChild(dz);

    col.appendChild(taskWrap);
    grid.appendChild(col);
  });

  updateSummary(taskList);
}

function makeTaskCard(task) {
  const card = document.createElement('div');
  const catClass = 'c-'+(task.category||'other').toLowerCase();
  const priClass = 'p-'+(task.priority||'medium').toLowerCase();
  card.className=\`task-card \${catClass} \${priClass}\${task.done?' done':''}\`;

  const catTag = \`<span class="task-tag tag-\${(task.category||'other').toLowerCase()}">\${task.category||'Other'}</span>\`;
  const priTag = \`<span class="task-tag tag-\${(task.priority||'medium').toLowerCase()}">\${task.priority||'Med'}</span>\`;

  card.innerHTML=\`
    <div class="task-title">\${esc(task.task)}</div>
    <div class="task-meta">\${catTag}\${priTag}</div>
    <div class="task-check"></div>
  \`;

  card.querySelector('.task-check').addEventListener('click', e=>{ e.stopPropagation(); toggleDone(task); });
  card.addEventListener('click', ()=>openEdit(task));
  return card;
}

// ── Summary ───────────────────────────────────────────────────────────────────
function updateSummary(taskList) {
  const total=taskList.length, done=taskList.filter(t=>t.done).length, left=total-done;
  const pct=total?Math.round(done/total*100):0;
  document.getElementById('s-total').textContent=total;
  document.getElementById('s-done').textContent=done;
  document.getElementById('s-left').textContent=left;
  document.getElementById('s-prog').style.width=pct+'%';

  ['study','assignment','exam','personal','work','other'].forEach(c=>{
    document.getElementById('c-'+c).textContent=taskList.filter(t=>(t.category||'Other').toLowerCase()===c).length;
  });

  const hi=taskList.filter(t=>t.priority==='High').length;
  const me=taskList.filter(t=>t.priority==='Medium').length;
  const lo=taskList.filter(t=>t.priority==='Low').length;
  const mx=Math.max(hi,me,lo,1);
  document.getElementById('pc-high').textContent=hi; document.getElementById('pb-high').style.width=(hi/mx*100)+'%';
  document.getElementById('pc-med').textContent=me;  document.getElementById('pb-med').style.width=(me/mx*100)+'%';
  document.getElementById('pc-low').textContent=lo;  document.getElementById('pb-low').style.width=(lo/mx*100)+'%';
}

// ── Toggle done ───────────────────────────────────────────────────────────────
async function toggleDone(task) {
  task.done=!task.done;
  renderGrid(tasks);
  try {
    await nPatch(\`/pages/\${task.notionId}\`, { properties:{ Done:{ checkbox:task.done } } });
  } catch(e) { task.done=!task.done; renderGrid(tasks); toast('Sync failed','err'); }
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function setPri(p) {
  mPri=p;
  document.querySelectorAll('#pri-pills .pill').forEach(pl=>{
    pl.className='pill'; if(pl.dataset.p===p) pl.classList.add('a-'+p.toLowerCase());
  });
}
function setCat(c) {
  mCat=c;
  document.querySelectorAll('#cat-pills .pill').forEach(pl=>{
    pl.className='pill'; if(pl.dataset.c===c) pl.classList.add('a-'+c.toLowerCase());
  });
}

function openAdd(day='Monday') {
  editId=null;
  document.getElementById('m-title').textContent='New Task';
  document.getElementById('m-task').value='';
  document.getElementById('m-day').value=day;
  document.getElementById('m-notes').value='';
  document.getElementById('m-del').style.display='none';
  setPri('High'); setCat('Study');
  document.getElementById('modal-back').classList.add('open');
  setTimeout(()=>document.getElementById('m-task').focus(),80);
}

function openEdit(task) {
  editId=task.id;
  document.getElementById('m-title').textContent='Edit Task';
  document.getElementById('m-task').value=task.task;
  document.getElementById('m-day').value=task.day;
  document.getElementById('m-notes').value=task.notes||'';
  document.getElementById('m-del').style.display='';
  setPri(task.priority||'Medium');
  setCat(task.category||'Other');
  document.getElementById('modal-back').classList.add('open');
}

function closeModal() { document.getElementById('modal-back').classList.remove('open'); }

document.getElementById('m-cancel').addEventListener('click',closeModal);
document.getElementById('modal-back').addEventListener('click',e=>{if(e.target===document.getElementById('modal-back'))closeModal();});
document.getElementById('m-task').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('m-save').click();});
document.querySelectorAll('#pri-pills .pill').forEach(p=>p.addEventListener('click',()=>setPri(p.dataset.p)));
document.querySelectorAll('#cat-pills .pill').forEach(p=>p.addEventListener('click',()=>setCat(p.dataset.c)));

document.getElementById('m-save').addEventListener('click', async()=>{
  const taskName=document.getElementById('m-task').value.trim();
  if(!taskName){ toast('Enter a task name','err'); return; }
  const day=document.getElementById('m-day').value;
  const notes=document.getElementById('m-notes').value.trim();
  const btn=document.getElementById('m-save'); btn.disabled=true; btn.textContent='Saving…';

  if(editId) {
    const task=tasks.find(t=>t.id===editId);
    if(task){ task.task=taskName; task.day=day; task.category=mCat; task.priority=mPri; task.notes=notes; }
    closeModal(); renderGrid(tasks);
    try { await saveToNotion(task); toast('Updated ✓','ok'); }
    catch(e){ toast('Sync failed: '+e.message,'err'); }
  } else {
    const task={id:uid(),task:taskName,day,category:mCat,priority:mPri,notes,done:false};
    tasks.push(task);
    closeModal(); renderGrid(tasks);
    try { await saveToNotion(task); toast('Task added ✓','ok'); }
    catch(e){ toast('Sync failed: '+e.message,'err'); }
  }
  btn.disabled=false; btn.textContent='Save';
});

document.getElementById('m-del').addEventListener('click',async()=>{
  const task=tasks.find(t=>t.id===editId); if(!task) return;
  tasks=tasks.filter(t=>t.id!==editId);
  closeModal(); renderGrid(tasks);
  try { await nPatch(\`/pages/\${task.notionId}\`,{archived:true}); toast('Deleted ✓'); }
  catch(e){ toast('Delete sync failed','err'); }
});

// ── Nav ───────────────────────────────────────────────────────────────────────
document.getElementById('btn-prev').addEventListener('click',()=>{ weekOffset--; loadWeek(); });
document.getElementById('btn-next').addEventListener('click',()=>{ weekOffset++; loadWeek(); });
document.getElementById('week-lbl').addEventListener('click',()=>{ weekOffset=0; loadWeek(); });
document.getElementById('btn-add').addEventListener('click',()=>openAdd());

// ── Init ──────────────────────────────────────────────────────────────────────
loadWeek();
</script>
</body>
</html>
`;
    setCORS(res);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(WEEKLY_HTML);
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  // Decode URL encoding (e.g. %20 → space)
  try { filePath = decodeURIComponent(filePath); } catch(e) {}
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Try with .html extension if not present
      if (!path.extname(pathname)) {
        const withHtml = filePath + '.html';
        return fs.readFile(withHtml, (err2, data2) => {
          if (err2) {
            console.error(`404: ${pathname} (tried ${filePath} and ${withHtml})`);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data2);
        });
      }
      console.error(`404: ${pathname} -> ${filePath}: ${err.message}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
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

// v1.0.2 - forced cache bust
server.listen(PORT, () => {
  console.log(`Study Hub running on port ${PORT}`);
  console.log(`Serving files from: ${__dirname}`);
  const fs2 = require('fs');
  try {
    const files = fs2.readdirSync(__dirname);
    console.log(`All files in __dirname: ${files.join(', ')}`);
    console.log(`HTML files: ${files.filter(f => f.endsWith('.html')).join(', ')}`);
  } catch(e) { console.log('Could not list files:', e.message); }
});
