// Receiver behaviour for the ui-feedback skill, tested over its HTTP API and CLI.
//   node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startReceiver } from '../skills/ui-feedback/scripts/ufb.mjs';

const TOKEN = 'test-token';
const execFileAsync = promisify(execFile);

async function withReceiver(fn) {
  const r = await startReceiver({ port: 0, token: TOKEN });
  try { await fn(r.url); } finally { await r.close(); }
}

const postNotes = (url, notes, token = TOKEN) =>
  fetch(`${url}/notes?t=${token}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ notes }) });

const note = (comment, extra = {}) => ({ kind: 'page', comment, url: 'http://127.0.0.1:8080/x', ...extra });

test('sent notes come back from the poll with increasing seq', async () => {
  await withReceiver(async (url) => {
    const sent = await postNotes(url, [note('first'), note('second')]);
    assert.equal(sent.status, 200);

    const res = await fetch(`${url}/poll?t=${TOKEN}&after=0&timeout=1`);
    const body = await res.json();
    assert.deepEqual(body.notes.map((n) => [n.seq, n.comment]), [[1, 'first'], [2, 'second']]);
    assert.equal(body.seq, 2);

    const later = await (await fetch(`${url}/poll?t=${TOKEN}&after=1&timeout=1`)).json();
    assert.deepEqual(later.notes.map((n) => n.comment), ['second']);
  });
});

test('a waiting poll wakes as soon as notes arrive', async () => {
  await withReceiver(async (url) => {
    const started = Date.now();
    const pending = fetch(`${url}/poll?t=${TOKEN}&after=0&timeout=10`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 100));
    await postNotes(url, [note('wake up')]);
    const body = await pending;
    assert.deepEqual(body.notes.map((n) => n.comment), ['wake up']);
    assert.ok(Date.now() - started < 2000, 'poll should not wait for its timeout');
  });
});

test('an idle poll returns no notes when it times out', async () => {
  await withReceiver(async (url) => {
    const body = await (await fetch(`${url}/poll?t=${TOKEN}&after=0&timeout=0.2`)).json();
    assert.deepEqual(body, { seq: 0, notes: [], ended: false });
  });
});

test('an end note marks the round ended, and a later round starts fresh', async () => {
  await withReceiver(async (url) => {
    await postNotes(url, [note('last fix'), { kind: 'end', url: 'http://127.0.0.1:8080/x' }]);
    const body = await (await fetch(`${url}/poll?t=${TOKEN}&after=0&timeout=1`)).json();
    assert.equal(body.ended, true);
    assert.deepEqual(body.notes.map((n) => n.kind), ['page', 'end']);

    await postNotes(url, [note('second round')]);
    const next = await (await fetch(`${url}/poll?t=${TOKEN}&after=${body.seq}&timeout=1`)).json();
    assert.equal(next.ended, false);
    assert.deepEqual(next.notes.map((n) => n.comment), ['second round']);
  });
});

test('the setup page, which carries the token, needs the token itself', async () => {
  await withReceiver(async (url) => {
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), new RegExp(TOKEN));
  });
});

test('multi-byte characters split across chunks arrive intact', async () => {
  await withReceiver(async (url) => {
    const body = Buffer.from(JSON.stringify({ notes: [note('café 💬 ok')] }));
    const cut = body.indexOf(Buffer.from('💬')) + 2; // inside the 4-byte emoji
    await new Promise((resolve, reject) => {
      const req = http.request(`${url}/notes?t=${TOKEN}`, { method: 'POST' }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.write(body.subarray(0, cut));
      setTimeout(() => req.end(body.subarray(cut)), 50);
    });
    const polled = await (await fetch(`${url}/poll?t=${TOKEN}&after=0&timeout=1`)).json();
    assert.equal(polled.notes[0].comment, 'café 💬 ok');
  });
});

test('notes and polls without the token are refused', async () => {
  await withReceiver(async (url) => {
    assert.equal((await postNotes(url, [note('injected')], 'wrong')).status, 403);
    assert.equal((await fetch(`${url}/poll?after=0&timeout=0`)).status, 403);
    const body = await (await fetch(`${url}/poll?t=${TOKEN}&after=0&timeout=0`)).json();
    assert.deepEqual(body.notes, []);
  });
});

test('malformed notes are rejected without being stored', async () => {
  await withReceiver(async (url) => {
    const bad = await fetch(`${url}/notes?t=${TOKEN}`, { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal((await postNotes(url, [{ kind: 'page' }])).status, 400, 'a page note needs a comment');
    assert.equal((await postNotes(url, [{ kind: 'shout', comment: 'x' }])).status, 400, 'unknown kind');
    const body = await (await fetch(`${url}/poll?t=${TOKEN}&after=0&timeout=0`)).json();
    assert.equal(body.seq, 0);
  });
});

const postReply = (url, reply, token = TOKEN) =>
  fetch(`${url}/replies?t=${token}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(reply) });

test('agent replies reach the page, readable cross-origin', async () => {
  await withReceiver(async (url) => {
    assert.equal((await postReply(url, { text: 'Fixed the heading', re: 1 })).status, 200);
    await postReply(url, { text: 'All done' });

    const res = await fetch(`${url}/replies?t=${TOKEN}&after=0&timeout=1`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.deepEqual(body.replies.map((r) => [r.id, r.text, r.re ?? null]), [[1, 'Fixed the heading', 1], [2, 'All done', null]]);

    const later = await (await fetch(`${url}/replies?t=${TOKEN}&after=1&timeout=1`)).json();
    assert.deepEqual(later.replies.map((r) => r.text), ['All done']);
  });
});

test('a waiting page wakes when the agent replies', async () => {
  await withReceiver(async (url) => {
    const pending = fetch(`${url}/replies?t=${TOKEN}&after=0&timeout=10`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 100));
    await postReply(url, { text: 'On it' });
    assert.deepEqual((await pending).replies.map((r) => r.text), ['On it']);
  });
});

test('replies need the token and some text', async () => {
  await withReceiver(async (url) => {
    assert.equal((await postReply(url, { text: 'spoofed' }, 'wrong')).status, 403);
    assert.equal((await postReply(url, { text: '  ' })).status, 400);
    assert.equal((await fetch(`${url}/replies?after=0&timeout=0`)).status, 403);
  });
});

const rawGet = (url, path, headers) => new Promise((resolve, reject) => {
  http.get(`${url}${path}`, { headers }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});

test('requests addressed to a foreign host name are refused (DNS rebinding)', async () => {
  await withReceiver(async (url) => {
    const port = new URL(url).port;
    const setup = `/?t=${TOKEN}`;
    assert.equal((await rawGet(url, setup, { host: `evil.example:${port}` })).status, 403);
    assert.equal((await rawGet(url, setup, { host: `localhost:${port}` })).status, 200);
    assert.equal((await rawGet(url, setup, { host: `127.0.0.1:${port}` })).status, 200);
  });
});

test('the setup page offers a bookmarklet that loads the overlay with the token', async () => {
  await withReceiver(async (url) => {
    const page = await (await fetch(`${url}/?t=${TOKEN}`)).text();
    const href = page.match(/href="(javascript:[^"]+)"/)?.[1];
    assert.ok(href, 'page has a javascript: bookmarklet link');
    const decoded = decodeURIComponent(href);
    assert.match(decoded, new RegExp(`${url}/ufb\\.js\\?t=${TOKEN}`));
    assert.match(page, /rel="icon"/, 'page has a favicon');

    const overlay = await fetch(`${url}/ufb.js?t=${TOKEN}`);
    assert.equal(overlay.status, 200);
    assert.match(overlay.headers.get('content-type'), /javascript/);
    assert.match(await overlay.text(), /__ufb/);
  });
});

test('health identifies the receiver without the token', async () => {
  await withReceiver(async (url) => {
    const body = await (await fetch(`${url}/health`)).json();
    assert.equal(body.app, 'ufb');
    assert.equal(body.port, Number(new URL(url).port));
    assert.equal(body.token, undefined);
  });
});

test('shutdown needs the token and stops the receiver', async () => {
  const r = await startReceiver({ port: 0, token: TOKEN });
  try {
    assert.equal((await fetch(`${r.url}/shutdown?t=wrong`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${r.url}/shutdown?t=${TOKEN}`, { method: 'POST' })).status, 200);
    await new Promise((res) => setTimeout(res, 100));
    await assert.rejects(fetch(`${r.url}/health`));
  } finally { await r.close().catch(() => {}); }
});

// --- CLI: what the agent actually runs -------------------------------------------------------

const CLI = fileURLToPath(new URL('../skills/ui-feedback/scripts/ufb.mjs', import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('the CLI starts a background receiver, polls, replies and stops it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ufb-test-'));
  const port = await freePort();
  const env = { ...process.env, UFB_HOME: home, UFB_PORT: String(port) };
  const ufb = (...args) => execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 20000 });
  try {
    const started = JSON.parse((await ufb('start')).stdout);
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    assert.equal(started.setup, `http://127.0.0.1:${port}/?t=${token}`);
    assert.equal(started.port, port);
    assert.equal(started.seq, 0);

    await postNotes(`http://127.0.0.1:${port}`, [note('from the page')], token);

    const polled = JSON.parse((await ufb('poll', '--after', '0', '--timeout', '1')).stdout);
    assert.deepEqual(polled.notes.map((n) => [n.seq, n.comment]), [[1, 'from the page']]);

    const again = JSON.parse((await ufb('start')).stdout);
    assert.equal(again.already, true, 'a second start reuses the running receiver');
    assert.equal(again.seq, 1, 'and reports where its notes are, so the next round polls after them');

    await ufb('reply', '--re', '1', 'Fixed', 'it');
    const replies = await (await fetch(`http://127.0.0.1:${port}/replies?t=${token}&after=0&timeout=0`)).json();
    assert.deepEqual(replies.replies.map((r) => [r.text, r.re]), [['Fixed it', 1]]);

    await ufb('stop');
    await assert.rejects(ufb('status'), 'status fails once stopped');
  } finally {
    await ufb('stop').catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('each receiver run has its own boot id so a page can tell a restart from no news', async () => {
  const boots = [];
  for (let i = 0; i < 2; i++) {
    await withReceiver(async (url) => {
      boots.push((await (await fetch(`${url}/replies?t=${TOKEN}&after=0&timeout=0`)).json()).boot);
    });
  }
  assert.ok(boots[0] && boots[1]);
  assert.notEqual(boots[0], boots[1]);
});
