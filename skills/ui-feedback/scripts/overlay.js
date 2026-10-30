// ufb overlay — dev-only UI feedback. Loaded by the bookmarklet from the local receiver; zero deps.
// Shadow DOM keeps the app's CSS out; capture-phase listeners keep picking clicks away from the app.
(() => {
  if (window.__ufb) { window.__ufb.toggle(); return; }
  const SRC = new URL(document.currentScript.src);
  const ORIGIN = SRC.origin;
  const TOKEN = SRC.searchParams.get('t') || '';
  const api = (path, params = '') => `${ORIGIN}${path}?t=${encodeURIComponent(TOKEN)}${params}`;
  const QUEUE_KEY = `ufb:queue:${ORIGIN}`;
  const SEEN_KEY = `ufb:seen-reply:${ORIGIN}`;
  const TOKEN_CHANGED = 'Receiver token changed — open the setup link from your agent and drag the bookmark again';

  const store = {
    get: (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: keep in memory */ } },
  };
  const queue = store.get(QUEUE_KEY, []);
  const saveQueue = () => store.set(QUEUE_KEY, queue);
  let picking = false, pinned = null, lastReply = 0, ended = false, sending = false;
  const seenState = store.get(SEEN_KEY, null);
  let boot = seenState?.boot ?? null, seenReply = Number(seenState?.seen) || 0;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:0;pointer-events:none';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font:13px/1.35 system-ui,sans-serif}
    #hl{position:fixed;border:2px solid #e11d48;background:#e11d4822;pointer-events:none;display:none;border-radius:3px}
    #bar{position:fixed;right:16px;bottom:16px;display:flex;gap:6px;pointer-events:auto;background:#111;color:#fff;padding:6px;border-radius:10px;box-shadow:0 4px 16px #0006}
    button{cursor:pointer;border:0;border-radius:6px;padding:6px 10px;background:#333;color:#fff}
    button.on{background:#e11d48} button:disabled{opacity:.4;cursor:default} button.ok{background:#15803d}
    #card,#replies{position:fixed;display:none;pointer-events:auto;background:#fff;color:#111;border-radius:8px;box-shadow:0 6px 24px #0008}
    #card{width:300px;padding:8px}
    #card textarea{width:100%;height:80px;resize:vertical;border:1px solid #ccc;border-radius:4px;padding:4px}
    #card .t{font-size:11px;color:#666;margin-bottom:4px;word-break:break-all}
    .row{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}
    #replies{right:16px;bottom:64px;width:340px;max-height:50vh;overflow:auto;padding:8px}
    #replies h4{margin:0 0 6px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
    #replies h4 button{padding:2px 8px;background:#eee;color:#111}
    #replies .r{border-top:1px solid #eee;padding:6px 0;white-space:pre-wrap;word-break:break-word}
    #replies .r small{display:block;color:#666;font-size:11px}
    #msg{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:6px 12px;border-radius:6px;display:none;max-width:420px;box-shadow:0 4px 16px #0006}
  </style>
  <div id="hl"></div>
  <div id="card"><div class="t"></div><textarea placeholder="Comment… (Ctrl/⌘+Enter to queue)"></textarea>
    <div class="row"><button id="cancel">Cancel</button><button id="add" class="on">Queue</button></div></div>
  <div id="replies"><h4>Agent replies <button id="rclose">Hide</button></h4><div id="rlist"></div></div>
  <div id="msg"></div>
  <div id="bar"><button id="pick" title="Alt+Shift+C">Pick element</button><button id="page">Page comment</button>
    <button id="send" disabled>Send (0)</button><button id="done" class="ok" title="Send what is queued and end the session">Done</button>
    <button id="rbtn" title="Agent replies">💬 0</button><button id="close" title="Hide (click the bookmark again to show)">✕</button></div>`;
  const $ = (s) => root.querySelector(s);
  const highlight = $('#hl'), card = $('#card'), textarea = card.querySelector('textarea'), panel = $('#replies');

  const cssPath = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (; el && el.nodeType === 1 && el !== document.documentElement; el = el.parentElement) {
      for (const a of ['data-testid', 'data-test', 'name', 'aria-label']) {
        const v = el.getAttribute(a);
        if (v) { parts.unshift(`${el.localName}[${a}="${CSS.escape(v)}"]`); return parts.join(' > '); }
      }
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); return parts.join(' > '); }
      let i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.localName === el.localName) i++;
      const same = el.parentElement && [...el.parentElement.children].filter((c) => c.localName === el.localName).length > 1;
      parts.unshift(same ? `${el.localName}:nth-of-type(${i})` : el.localName);
    }
    return parts.join(' > ');
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      selector: cssPath(el), tag: el.localName,
      classes: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
      text: (el.innerText || (el.type === 'password' ? '' : el.value) || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      html: el.outerHTML.slice(0, 400),
      rect: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    };
  };
  const ctx = () => ({ url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scrollX, scrollY } });
  let flashTimer;
  const flash = (t) => { const m = $('#msg'); m.textContent = t; m.style.display = 'block'; clearTimeout(flashTimer); flashTimer = setTimeout(() => (m.style.display = 'none'), 3000); };
  const refresh = () => {
    $('#send').textContent = `Send (${queue.length})`;
    $('#send').disabled = !queue.length || ended || sending;
    $('#done').disabled = ended || sending;
    $('#pick').classList.toggle('on', picking);
    $('#rbtn').textContent = `💬 ${lastReply}`;
    $('#rbtn').classList.toggle('on', lastReply > seenReply);
  };

  const openCard = (el) => {
    pinned = el;
    card.querySelector('.t').textContent = el ? describe(el).selector : 'Page comment · ' + location.pathname;
    const r = el ? el.getBoundingClientRect() : { left: innerWidth / 2 - 150, bottom: innerHeight / 3 };
    card.style.left = Math.min(Math.max(8, r.left), innerWidth - 310) + 'px';
    card.style.top = Math.max(8, Math.min(r.bottom + 6, innerHeight - 160)) + 'px';
    card.style.display = 'block'; textarea.value = ''; textarea.focus();
  };
  const closeCard = () => { card.style.display = 'none'; pinned = null; if (!picking) highlight.style.display = 'none'; };
  const addNote = () => {
    const comment = textarea.value.trim(); if (!comment) return;
    queue.push({ kind: pinned ? 'element' : 'page', comment, ...ctx(), element: pinned ? describe(pinned) : null, at: new Date().toISOString() });
    saveQueue(); closeCard(); refresh();
  };

  const post = async (notes) => {
    const res = await fetch(api('/notes'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ notes }) });
    if (!res.ok) throw new Error(res.status === 403 ? TOKEN_CHANGED : `HTTP ${res.status}`);
    return (await res.json()).seq;
  };
  const send = async (end) => {
    if (sending) return;
    const sent = queue.length; // notes queued while the POST is in flight stay queued
    const batch = end ? [...queue, { kind: 'end', ...ctx(), at: new Date().toISOString() }] : [...queue];
    if (!batch.length) return;
    sending = true; refresh();
    try {
      const last = await post(batch);
      queue.splice(0, sent); saveQueue();
      const range = sent ? ` (#${last - batch.length + 1}${sent > 1 ? '–#' + (last - batch.length + sent) : ''})` : '';
      if (end) { ended = true; setPicking(false); flash(`Session ended${sent ? `, sent ${sent} note(s)${range}` : ''}. Replies still show here.`); }
      else flash(`Sent ${sent} note(s) to the agent${range}`);
    } catch (err) { flash('Send failed: ' + err.message + ' — notes kept'); }
    sending = false;
    refresh();
  };

  const markSeen = (seen) => { seenReply = seen; store.set(SEEN_KEY, { boot, seen }); };
  const showReplies = () => { panel.style.display = 'block'; markSeen(lastReply); refresh(); };
  const addReplies = (replies) => {
    for (const r of replies) {
      const div = document.createElement('div'); div.className = 'r';
      const meta = document.createElement('small');
      meta.textContent = `${new Date(r.at).toLocaleTimeString()}${r.re ? ` · re #${r.re}` : ''}`;
      div.append(meta, document.createTextNode(r.text));
      $('#rlist').prepend(div);
      lastReply = Math.max(lastReply, r.id);
    }
    if (lastReply > seenReply && host.style.display !== 'none') showReplies(); else refresh();
  };
  const pollReplies = async () => {
    for (;;) {
      try {
        const res = await fetch(api('/replies', `&after=${lastReply}&timeout=25`));
        if (res.status === 403) { flash(TOKEN_CHANGED); return; }
        if (!res.ok) throw new Error(res.status);
        const body = await res.json();
        if (body.boot !== boot) {
          // The receiver restarted (reply ids start over), or this is the first answer from it.
          const restarted = boot !== null;
          boot = body.boot;
          if (restarted || lastReply > 0) { lastReply = 0; markSeen(0); $('#rlist').replaceChildren(); continue; }
        }
        addReplies(body.replies);
      } catch { await new Promise((r) => setTimeout(r, 2000)); } // receiver down or restarting: retry quietly
    }
  };

  const inUi = (e) => e.composedPath().includes(host);
  const onMove = (e) => {
    if (!picking || pinned || inUi(e)) return;
    const r = e.target.getBoundingClientRect();
    Object.assign(highlight.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const setPicking = (v) => { picking = v; if (!v && !pinned) highlight.style.display = 'none'; refresh(); };
  // Capture phase so the app (Dioxus, htmx, React…) never sees the picking click.
  for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    addEventListener(t, (e) => {
      if (!picking || inUi(e)) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (t === 'click' && !pinned) openCard(e.target);
    }, true);
  }
  addEventListener('mousemove', onMove, true);
  addEventListener('keydown', (e) => {
    if (host.style.display === 'none') return;
    if (e.altKey && e.shiftKey && e.code === 'KeyC') { e.preventDefault(); setPicking(!picking); }
    else if (e.key === 'Escape') { if (card.style.display === 'block') closeCard(); else setPicking(false); }
  }, true);
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addNote(); });

  $('#pick').onclick = () => setPicking(!picking);
  $('#page').onclick = () => openCard(null);
  $('#add').onclick = addNote;
  $('#cancel').onclick = closeCard;
  $('#send').onclick = () => send(false);
  $('#done').onclick = () => send(true);
  $('#rbtn').onclick = () => (panel.style.display === 'block' ? (panel.style.display = 'none') : showReplies());
  $('#rclose').onclick = () => { panel.style.display = 'none'; };
  $('#close').onclick = () => toggle();
  const toggle = () => {
    const hide = host.style.display !== 'none';
    host.style.display = hide ? 'none' : '';
    if (hide) { setPicking(false); closeCard(); } else if (lastReply > seenReply) showReplies();
  };
  window.__ufb = { toggle };
  refresh();
  flash(queue.length ? `UI feedback ready — ${queue.length} queued note(s) restored` : 'UI feedback ready — Alt+Shift+C to pick');
  pollReplies();
})();
