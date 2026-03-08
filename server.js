#!/usr/bin/env node
/**
 * AI Content Coach — Local Server
 * ─────────────────────────────────────────────────────────
 * Serves the dashboard and proxies chat through Claude Code.
 * No API key needed — uses your existing Claude Code login.
 *
 * Usage:
 *   node server.js
 *   Then open: http://localhost:3000
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { spawn, execSync } = require('child_process');

const PORT = process.env.PORT || 3003;
const ROOT = __dirname;

// ─── Auth: API key OR Claude Code CLI ────────────────────────
const API_KEY = process.env.ANTHROPIC_API_KEY || null;

function findClaude() {
  try { return execSync('which claude 2>/dev/null').toString().trim(); } catch(e) {}
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.npm/bin/claude`,
    '/usr/local/bin/claude',
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}
const CLAUDE_BIN = findClaude();

if (!API_KEY && !CLAUDE_BIN) {
  console.error('\n❌  No auth method found. Need either:');
  console.error('    • ANTHROPIC_API_KEY in your environment, or');
  console.error('    • Claude Code installed (claude CLI in PATH)\n');
  process.exit(1);
}

const AUTH_METHOD = API_KEY ? 'api-key' : 'claude-cli';
console.log(`    Auth: ${AUTH_METHOD === 'api-key' ? 'Anthropic API key' : 'Claude Code CLI (' + CLAUDE_BIN + ')'}`);

// ─── Static file server ──────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); }
    else { res.writeHead(200, { 'Content-Type': contentType }); res.end(data); }
  });
}

// ─── Chat via Anthropic API (API key users) ───────────────────
function callViaApiKey(systemPrompt, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: systemPrompt, messages });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid API response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Chat via Claude Code CLI (OAuth users) ───────────────────
function callViaCli(systemPrompt, messages) {
  return new Promise((resolve, reject) => {
    const history = messages.slice(0, -1)
      .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    const latest = messages[messages.length - 1].content;
    const fullPrompt = history ? `${history}\n\nHuman: ${latest}` : latest;

    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE; // allow nesting if launched from Claude Code

    let output = '', error = '';
    const proc = spawn(CLAUDE_BIN, [
      '--print',
      '--append-system-prompt', systemPrompt,
      '--no-session-persistence',
      '--dangerously-skip-permissions',
      fullPrompt,
    ], { env: childEnv });

    proc.stdin.end();
    proc.stdout.on('data', d => output += d);
    proc.stderr.on('data', d => error  += d);
    proc.on('close', code => {
      if (code === 0 && output.trim()) resolve({ content: [{ text: output.trim() }] });
      else reject(new Error(error.trim() || `claude exited ${code}`));
    });
    proc.on('error', e => reject(new Error(`Cannot run claude: ${e.message}`)));
    setTimeout(() => { proc.kill(); reject(new Error('Claude timed out after 30s')); }, 30000);
  });
}

function callClaude(systemPrompt, messages) {
  return AUTH_METHOD === 'api-key'
    ? callViaApiKey(systemPrompt, messages)
    : callViaCli(systemPrompt, messages);
}

// ─── HTTP Server ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /api/refresh — runs fetch-data.js and streams progress via SSE
  if (req.method === 'GET' && req.url === '/api/refresh') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ line: '⟳ Starting data refresh...' });

    const child = spawn('node', [path.join(ROOT, 'fetch-data.js')], {
      cwd: ROOT,
      env: process.env,
    });

    child.stdout.on('data', chunk => {
      chunk.toString().split('\n').filter(l => l.trim()).forEach(line => send({ line }));
    });
    child.stderr.on('data', chunk => {
      chunk.toString().split('\n').filter(l => l.trim()).forEach(line => send({ error: line }));
    });
    child.on('close', code => {
      send({ done: true, success: code === 0 });
      res.end();
    });
    child.on('error', e => {
      send({ error: e.message, done: true, success: false });
      res.end();
    });

    req.on('close', () => child.kill());
    return;
  }

  // POST /api/chat — proxy to Claude Code
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { system, messages } = JSON.parse(body);
        const data = await callClaude(system, messages);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch(e) {
        console.error('Chat error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
    return;
  }

  // GET / — serve dashboard
  if (req.method === 'GET') {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/' || urlPath === '') urlPath = '/content-coach-dashboard.html';

    const filePath = path.join(ROOT, urlPath);

    // Security: stay within ROOT
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    serveFile(res, filePath);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n🚀  AI Content Coach server running');
  console.log(`    Open: http://localhost:${PORT}`);
  console.log('\n    Press Ctrl+C to stop\n');
});
