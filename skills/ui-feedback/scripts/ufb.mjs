#!/usr/bin/env node
// ufb — live UI feedback receiver. Zero dependencies; Node >= 20.
// Serves the overlay + bookmarklet page, takes notes from the page, long-polls them to the agent,
// and carries the agent's replies back to the page.
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const OVERLAY = fileURLToPath(new URL('./overlay.js', import.meta.url));
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const KINDS = new Set(['element', 'page', 'end']);
const MAX_BODY = 2_000_000;
const MAX_WAIT_S = 3600;
const CORS = { 'access-control-allow-origin': '*' };

function validNote(n) {
  if (!n || typeof n !== 'object' || !KINDS.has(n.kind)) return false;
  if (n.kind === 'end') return true;
  return typeof n.comment === 'string' && n.comment.trim() !== '';
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\
<path fill="#e11d48" d="M10 8h44a8 8 0 0 1 8 8v24a8 8 0 0 1-8 8H28L14 60V48h-4a8 8 0 0 1-8-8V16a8 8 0 0 1 8-8z"/>\
<circle cx="20" cy="28" r="4" fill="#fff"/><circle cx="32" cy="28" r="4" fill="#fff"/><circle cx="44" cy="28" r="4" fill="#fff"/></svg>`;

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function bookmarklet({ origin, token }) {
  return `javascript:(()=>{const s=document.createElement('script');s.src='${origin}/ufb.js?t=${token}';document.documentElement.appendChild(s)})()`;
}

function setupPage({ origin, token }) {
  const href = escapeHtml(bookmarklet({ origin, token }));
  const icon = `data:image/svg+xml,${encodeURIComponent(FAVICON)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI feedback</title>
<link rel="icon" type="image/svg+xml" href="${icon}">
<style>
  :root{color-scheme:light dark;--fg:#111;--muted:#666;--bg:#fafafa;--card:#fff;--line:#e5e5e5}
  @media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#999;--bg:#18181b;--card:#232327;--line:#333}}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
  main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 32px;max-width:560px;box-shadow:0 8px 32px #0001}
  h1{margin:0 0 4px;font-size:22px;display:flex;gap:10px;align-items:center}
  h1 img{width:28px;height:28px}
  p.sub{margin:0 0 20px;color:var(--muted)}
  .bm{display:inline-block;padding:10px 18px;border-radius:999px;background:#e11d48;color:#fff;font-weight:600;text-decoration:none;cursor:grab}
  ol{padding-left:20px} li{margin:8px 0}
  kbd{font:12px ui-monospace,monospace;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:1px 5px}
  small{color:var(--muted)} code{font:13px ui-monospace,monospace}
</style></head>
<body><main>
<h1><img src="${icon}" alt="">UI feedback</h1>
<p class="sub">Comment on the running app; your agent receives the notes and replies here.</p>
<p><a class="bm" href="${href}" title="Drag me to the bookmarks bar">💬 Feedback</a></p>
<ol>
  <li><b>Drag</b> the button above to your bookmarks bar (once; it keeps working while this receiver runs on port ${new URL(origin).port}).</li>
  <li><b>Open</b> the app and click the <b>💬 Feedback</b> bookmark.</li>
  <li><b>Pick element</b> (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>) or <b>Page comment</b>, write, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> to queue.</li>
  <li><b>Send</b> whenever you like; press <b>Done</b> when the round is over. Agent replies appear under <b>💬</b>.</li>
</ol>
<p><small>Queued notes survive a page reload — click the bookmark again to bring the bar back. Receiver: <code>${escapeHtml(origin)}</code></small></p>
</main></body></html>
`;
}

export async function startReceiver({ port = 0, host = '127.0.0.1', token, onShutdown }) {
  if (!token) throw new Error('startReceiver needs a token');
  const notes = [];
  const replies = [];
  const boot = randomUUID(); // reply ids restart at 1 with each run; the page uses this to notice
  const waiters = { notes: new Set(), replies: new Set() };
  const wake = (set) => { for (const w of [...set]) w(); };

  // Each route: whether it needs the token, and its handler ({ req, res, u, json } => void).
  // Everything that reveals or changes notes and replies needs the token; the setup page carries it, so it does too.
  const routes = {
    'GET /': { auth: true, handle: ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(setupPage({ origin: `http://${host}:${server.address().port}`, token }));
    } },
    'GET /ufb.js': { auth: false, handle: ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', ...CORS });
      res.end(fs.readFileSync(OVERLAY));
    } },
    'GET /favicon.ico': { auth: false, handle: ({ res }) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
      res.end(FAVICON);
    } },
    'GET /health': { auth: false, handle: ({ json }) => {
      json(200, { ok: true, app: 'ufb', port: server.address().port, seq: notes.length, replies: replies.length });
    } },
    'POST /notes': { auth: true, handle: (ctx) => readJson(ctx, (parsed) => {
      const incoming = parsed?.notes;
      if (!Array.isArray(incoming) || !incoming.every(validNote)) {
        return ctx.json(400, { error: 'each note needs kind element|page|end and a comment' }, CORS);
      }
      for (const { seq: _pageSeq, ...n } of incoming) notes.push({ seq: notes.length + 1, ...n }); // seq is ours, not the page's
      wake(waiters.notes);
      ctx.json(200, { ok: true, seq: notes.length }, CORS);
    }) },
    'GET /poll': { auth: true, handle: (ctx) => {
      const after = Number(ctx.u.searchParams.get('after') || 0);
      longPoll(ctx, waiters.notes, () => notes.length > after, () => {
        const fresh = notes.filter((n) => n.seq > after);
        ctx.json(200, { seq: notes.length, notes: fresh, ended: fresh.some((n) => n.kind === 'end') });
      });
    } },
    'POST /replies': { auth: true, handle: (ctx) => readJson(ctx, (parsed) => {
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
      if (!text) return ctx.json(400, { error: 'reply needs text' });
      const re = Number.isInteger(parsed.re) ? parsed.re : null;
      replies.push({ id: replies.length + 1, text, re, at: new Date().toISOString() });
      wake(waiters.replies);
      ctx.json(200, { ok: true, id: replies.length });
    }) },
    'GET /replies': { auth: true, handle: (ctx) => {
      const after = Number(ctx.u.searchParams.get('after') || 0);
      longPoll(ctx, waiters.replies, () => replies.length > after,
        () => ctx.json(200, { boot, replies: replies.filter((r) => r.id > after) }, CORS));
    } },
    'POST /shutdown': { auth: true, handle: ({ json }) => {
      json(200, { ok: true });
      setImmediate(() => { onShutdown?.(); close(); });
    } },
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body) + '\n');
    };
    // A page that rebinds its own DNS name to 127.0.0.1 would be same-origin with us; refuse foreign Host names.
    const hostName = (req.headers.host || '').replace(/:\d+$/, '');
    if (!LOOPBACK_NAMES.has(hostName)) return json(403, { error: 'loopback host names only' });
    const route = routes[`${req.method} ${u.pathname}`];
    if (!route) return json(404, { error: 'not found' });
    if (route.auth && u.searchParams.get('t') !== token) {
      return json(403, { error: 'bad or missing token; open the setup link the agent gave you' }, CORS);
    }
    route.handle({ req, res, u, json });
  });

  const close = () => new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  return { url: `http://${host}:${actual}`, port: actual, close };
}

function readJson({ req, json }, handle) {
  let body = '', tooLarge = false;
  req.setEncoding('utf8'); // decode across chunk boundaries, so split multi-byte characters survive
  req.on('data', (c) => {
    body += c;
    if (body.length > MAX_BODY && !tooLarge) { tooLarge = true; json(413, { error: 'too large' }, CORS); req.destroy(); }
  });
  req.on('end', () => {
    if (tooLarge) return;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return json(400, { error: 'body must be JSON' }, CORS); }
    handle(parsed);
  });
}

// Long-poll: answer now if something newer exists, else when woken or when `timeout` seconds pass.
function longPoll({ res, u }, waiting, hasNew, respond) {
  let timer;
  const send = () => { clearTimeout(timer); waiting.delete(send); respond(); };
  if (hasNew()) return send();
  const seconds = Math.min(Math.max(Number(u.searchParams.get('timeout') ?? 90) || 0, 0), MAX_WAIT_S);
  timer = setTimeout(send, seconds * 1000);
  waiting.add(send);
  res.on('close', () => { clearTimeout(timer); waiting.delete(send); });
}

// --- CLI ------------------------------------------------------------------------------------

const DEFAULT_PORT = 4848;
const HELP = `ufb — live UI feedback receiver

  node ufb.mjs start            start the receiver in the background (reuses a running one)
  node ufb.mjs serve            run the receiver in the foreground
  node ufb.mjs poll [--after N] [--timeout S]
                                wait up to S seconds (default 90, max ${MAX_WAIT_S}) for notes with seq > N; prints JSON
  node ufb.mjs reply [--re SEQ] <text...>     (use - to read the text from stdin)
                                show a reply in the page, optionally tied to note SEQ
  node ufb.mjs status           print receiver health; exits 1 when it is not running
  node ufb.mjs stop             stop the receiver

Options: --port P (or UFB_PORT; default ${DEFAULT_PORT}).
State (token, logs): UFB_HOME, default \$XDG_STATE_HOME/ufb or ~/.local/state/ufb.`;

function parseArgs(argv) {
  const opts = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)$/);
    if (m && m[1] === 'help') opts.help = true;
    else if (m) opts[m[1]] = argv[++i];
    else rest.push(argv[i]);
  }
  return { opts, rest };
}

function stateDir() {
  if (process.env.UFB_HOME) return process.env.UFB_HOME;
  const base = process.env.XDG_STATE_HOME || `${process.env.HOME || process.env.USERPROFILE}/.local/state`;
  return `${base}/ufb`;
}

// The token is stable across restarts so a bookmark dragged once keeps working.
function loadToken({ create }) {
  const dir = stateDir(), file = `${dir}/token`;
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (err) { if (err.code !== 'ENOENT' || !create) throw err; }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, randomBytes(16).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) { if (err.code !== 'EEXIST') throw err; } // a concurrent start won the race: use its token
  return fs.readFileSync(file, 'utf8').trim();
}

// node:http rather than fetch: fetch gives up on response headers after 300 s, and polls may wait longer.
function call(base, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${parsed.error || ''}`.trim()));
        else resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function health(base) {
  try { return await call(base, '/health'); } catch { return null; }
}

async function main(argv) {
  const { opts, rest } = parseArgs(argv);
  const cmd = rest.shift();
  if (!cmd || opts.help || cmd === 'help') { console.log(HELP); return 0; }
  const port = Number(opts.port || process.env.UFB_PORT || DEFAULT_PORT);
  const base = `http://127.0.0.1:${port}`;
  const setupUrl = (token) => `${base}/?t=${token}`;

  if (cmd === 'serve') {
    const token = loadToken({ create: true });
    await startReceiver({ port, token, onShutdown: () => console.error('ufb: shutdown requested') });
    console.error(`ufb: listening on ${base}/  (setup page)`);
    return null; // keep running
  }
  if (cmd === 'start') {
    const token = loadToken({ create: true });
    const running = await health(base);
    if (running) {
      await call(base, `/poll?t=${token}&after=${Number.MAX_SAFE_INTEGER}&timeout=0`).catch(() => {
        throw new Error(`port ${port} runs a ufb receiver with another token (another UFB_HOME); pick another --port`);
      });
      console.log(JSON.stringify({ ok: true, already: true, setup: setupUrl(token), port, seq: running.seq }));
      return 0;
    }
    const { spawn } = await import('node:child_process');
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const log = `${stateDir()}/ufb-${port}.log`;
    const fd = fs.openSync(log, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(port)],
      { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    child.unref();
    for (let i = 0; i < 50; i++) {
      if (await health(base)) {
        console.log(JSON.stringify({ ok: true, already: false, setup: setupUrl(token), port, seq: 0, log }));
        return 0;
      }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`receiver did not start on port ${port}; see ${log}`);
  }
  if (cmd === 'status') {
    const h = await health(base);
    if (!h) { console.log(JSON.stringify({ ok: false, running: false, port })); return 1; }
    console.log(JSON.stringify({ ...h, running: true }));
    return 0;
  }
  let token;
  try { token = loadToken({ create: false }); } catch { throw new Error('no receiver token yet; run `start` first'); }
  if (cmd === 'poll') {
    const after = Number(opts.after || 0), timeout = Number(opts.timeout ?? 90);
    const body = await call(base, `/poll?t=${token}&after=${after}&timeout=${timeout}`);
    // One note per line keeps the JSON valid and easy to scan.
    const lines = body.notes.map((n) => JSON.stringify(n)).join(',\n');
    console.log(`{"seq":${body.seq},"ended":${body.ended},"notes":[${lines ? '\n' + lines + '\n' : ''}]}`);
    return 0;
  }
  if (cmd === 'reply') {
    const text = rest.length === 1 && rest[0] === '-' ? fs.readFileSync(0, 'utf8') : rest.join(' ');
    const re = opts.re === undefined ? undefined : Number(opts.re);
    const body = await call(base, `/replies?t=${token}`, { method: 'POST', body: JSON.stringify({ text, re }) });
    console.log(JSON.stringify(body));
    return 0;
  }
  if (cmd === 'stop') {
    if (!(await health(base))) { console.log(JSON.stringify({ ok: true, running: false, port })); return 0; }
    await call(base, `/shutdown?t=${token}`, { method: 'POST' });
    console.log(JSON.stringify({ ok: true, stopped: true, port }));
    return 0;
  }
  throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { if (code !== null) process.exitCode = code; },
    (err) => { console.error(`ufb: ${err.message}`); process.exitCode = 1; },
  );
}
