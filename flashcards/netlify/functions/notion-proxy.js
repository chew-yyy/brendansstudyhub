const https = require('https');

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Notion-Version',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // Strip /api/notion from the path to get the Notion API path
  // Handles both /:splat and direct function invocation
  const rawPath = event.path || '';
  let notionPath = rawPath.replace(/^\/api\/notion/, '');
  if (!notionPath || notionPath === '') notionPath = '/';

  // Decode body
  let body = '';
  if (event.body) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
  }

  const reqHeaders = {
    'Authorization': event.headers['authorization'] || event.headers['Authorization'] || '',
    'Notion-Version': event.headers['notion-version'] || event.headers['Notion-Version'] || '2022-06-28',
    'Content-Type': 'application/json',
  };
  if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body, 'utf8').toString();

  const options = {
    hostname: 'api.notion.com',
    path: notionPath + (event.rawQuery ? '?' + event.rawQuery : ''),
    method: event.httpMethod,
    headers: reqHeaders,
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: data || '{}',
        });
      });
    });
    req.on('error', (err) => {
      resolve({
        statusCode: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.message }),
      });
    });
    if (body) req.write(body);
    req.end();
  });
};