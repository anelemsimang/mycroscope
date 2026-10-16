import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const file = process.env.INBOX_FILE || '/data/support.jsonl';
const maxBody = 32 * 1024;
const topics = new Set([
  'Getting started',
  'Desktop app',
  'Billing',
  'Reports',
  'Privacy',
  'Something else',
]);

function clean(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBody) {
        reject(Object.assign(new Error('too big'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    send(res, 200, 'ok\n');
    return;
  }
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/support') {
    send(res, 404, 'Not found\n');
    return;
  }
  const type = String(req.headers['content-type'] ?? '');
  if (!type.includes('application/x-www-form-urlencoded')) {
    send(res, 415, 'Send the support form from the website.\n');
    return;
  }
  try {
    const params = new URLSearchParams(await readBody(req));
    if (clean(params.get('bot-field'), 200)) {
      send(res, 303, '', { Location: '/support-received.html' });
      return;
    }
    const name = clean(params.get('name'), 120);
    const email = clean(params.get('email'), 200);
    const organisation = clean(params.get('organisation'), 160);
    const topic = clean(params.get('topic'), 40);
    const message = clean(params.get('message'), 4000);
    if (!name || !email || !email.includes('@') || !topics.has(topic) || message.length < 2) {
      send(res, 400, 'Name, email, topic and question are required.\n');
      return;
    }
    const row = JSON.stringify({
      received_at: new Date().toISOString(),
      name,
      email,
      organisation,
      topic,
      message,
    });
    await store(`${row}\n`);
    send(res, 303, '', { Location: '/support-received.html' });
  } catch (error) {
    const status = error.status === 413 ? 413 : 400;
    send(res, status, status === 413 ? 'That question is too long.\n' : 'The question could not be read.\n');
  }
});

let writing = Promise.resolve();

function store(line) {
  const next = writing.then(() => fs.promises.appendFile(file, line, { encoding: 'utf8', mode: 0o600 }));
  writing = next.catch(() => {});
  return next;
}

fs.mkdirSync(path.dirname(file), { recursive: true });
server.listen(8080, '0.0.0.0');
