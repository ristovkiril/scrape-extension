/*
 * On-page "stage": shows a live run as it happens, on the real pages the tab opens.
 *
 *   - Result pages: everything but the list is dimmed, each card is highlighted as
 *     it is captured, and a cursor "clicks" the next-page button before the tab
 *     opens the next page.
 *   - Listings: every value that is read is spotlighted on the page and added to an
 *     "Extracted data" panel; in Full mode the cursor clicks the phone button.
 *   - A bar at the bottom shows progress, with Stop and "hide animation".
 *
 * Animations are sized to fit the wait between two requests, so they don't make a
 * run slower. Everything lives in a closed shadow root so the site's CSS cannot
 * touch it. A new page means a new stage: content.js calls begin() on every load.
 */
(function () {
  'use strict';

  if (window.IngatlanStage) return;

  const CARD_SELECTOR = 'a.listing-card[data-listing-id], [data-testid="listing-card"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (t) => (t || '').replace(/[\s  ]+/g, ' ').trim();
  const inChrome = (el) => !!el.closest('header, footer, nav');

  class Stopped extends Error {}

  let ui = null;
  let host = null;
  let raf = 0;
  let isStopped = () => false;
  let onStop = () => {};
  let unmountTimer = 0;
  let toastTimer = 0;
  const movers = new Set();
  let marks = [];
  let cursorAt = null;
  // The HUD counter counts up card by card while a page is scanned.
  const counter = { shown: 0, real: 0, scanning: false };

  /** Waits, but gives up as soon as the run is stopped. */
  async function wait(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (isStopped()) throw new Stopped('Stopped');
      await sleep(Math.min(100, until - Date.now()));
    }
    if (isStopped()) throw new Stopped('Stopped');
  }

  // ---------- markup ----------

  const CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .layer {
      position: fixed; inset: 0; pointer-events: none;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f4f2ff;
      --accent: #8b5cf6; --accent-2: #db2777; --ok: #10b981; --glass: rgba(18, 14, 38, .84);
      opacity: 0; transition: opacity .35s ease;
    }
    .layer.on { opacity: 1; }
    .layer.instant { transition: none; }

    /* Spotlight: a box whose huge shadow darkens everything around it. */
    .hole {
      position: fixed; left: 0; top: 0; border-radius: 16px; opacity: 0;
      box-shadow: 0 0 0 2px rgba(167, 139, 250, .9), 0 0 28px 6px rgba(124, 58, 237, .45), 0 0 0 200vmax rgba(9, 7, 22, .62);
      transition: opacity .45s ease;
    }
    .hole.on { opacity: 1; }

    /* Highlight ring for the item being read. */
    .ring {
      position: fixed; left: 0; top: 0; border-radius: 12px; opacity: 0;
      box-shadow: 0 0 0 3px #a78bfa, 0 0 0 9px rgba(167, 139, 250, .25), 0 12px 40px rgba(124, 58, 237, .5);
      background: rgba(167, 139, 250, .1);
      transition: opacity .2s ease;
    }
    .ring.on { opacity: 1; }
    .ring::after {
      content: ''; position: absolute; left: 0; right: 0; height: 36%; top: 0; border-radius: inherit;
      background: linear-gradient(180deg, transparent, rgba(167, 139, 250, .35), transparent);
      animation: scan 1.1s ease-in-out infinite;
    }
    @keyframes scan { 0% { transform: translateY(-40%); } 100% { transform: translateY(220%); } }
    .ring.pressed { animation: press .35s ease; }
    @keyframes press { 50% { box-shadow: 0 0 0 5px #f0abfc, 0 0 0 16px rgba(240, 171, 252, .3), 0 12px 40px rgba(219, 39, 119, .5); } }
    .chip {
      position: absolute; left: -3px; bottom: calc(100% + 10px); max-width: 420px;
      padding: 5px 11px; border-radius: 999px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff;
      font-weight: 600; font-size: 12px; box-shadow: 0 6px 20px rgba(124, 58, 237, .45);
    }
    .chip:empty { display: none; }
    .ring.below .chip { bottom: auto; top: calc(100% + 10px); }

    /* Captured-card check marks. */
    .mark {
      position: fixed; left: 0; top: 0; width: 26px; height: 26px; border-radius: 50%;
      display: grid; place-items: center; background: var(--ok); color: #fff;
      box-shadow: 0 0 0 3px rgba(16, 185, 129, .3), 0 4px 14px rgba(0, 0, 0, .35);
      animation: pop .4s cubic-bezier(.3, 1.6, .5, 1);
    }
    @keyframes pop { from { scale: 0; } to { scale: 1; } }
    .plus {
      position: fixed; left: 0; top: 0; padding: 2px 8px; border-radius: 999px;
      background: var(--ok); color: #fff; font-weight: 700; font-size: 12px;
    }

    /* Fake cursor. */
    .cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; opacity: 0; transition: opacity .25s; filter: drop-shadow(0 3px 6px rgba(0, 0, 0, .45)); }
    .cursor.on { opacity: 1; }
    .cursor svg { transition: transform .12s ease; transform-origin: 4px 3px; }
    .cursor.down svg { transform: scale(.82); }
    .ripple {
      position: fixed; left: 0; top: 0; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
      border: 3px solid #f0abfc; animation: ripple .6s ease-out forwards;
    }
    @keyframes ripple { from { scale: .2; opacity: 1; } to { scale: 1.6; opacity: 0; } }

    /* "Extracted data" panel on listing pages. */
    .panel {
      position: fixed; top: 20px; right: 20px; bottom: 104px; width: 320px;
      display: flex; flex-direction: column; gap: 12px; padding: 16px;
      border-radius: 18px; background: var(--glass); backdrop-filter: blur(16px) saturate(1.4);
      border: 1px solid rgba(255, 255, 255, .1); box-shadow: 0 20px 60px rgba(0, 0, 0, .5);
      opacity: 0; transform: translateX(24px); transition: opacity .4s ease, transform .5s cubic-bezier(.2, .8, .2, 1);
    }
    .panel.on { opacity: 1; transform: none; }
    .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .panel-title { font-weight: 700; font-size: 14px; }
    .panel-sub { color: #a5a1c7; font-size: 12px; }
    .panel-sub b { color: #fff; }
    .step {
      align-self: flex-start; display: flex; align-items: center; gap: 8px; padding: 4px 11px; border-radius: 999px;
      background: rgba(139, 92, 246, .18); color: #ddd6fe; font-weight: 600; font-size: 12px;
    }
    .step.ok { background: rgba(16, 185, 129, .18); color: #a7f3d0; }
    .step.err { background: rgba(244, 63, 94, .18); color: #fecdd3; }
    .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
    .step.ok .spin, .step.err .spin { display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .card { display: flex; gap: 10px; align-items: center; padding: 10px; border-radius: 12px; background: rgba(255, 255, 255, .05); }
    .thumb { width: 64px; height: 48px; border-radius: 8px; object-fit: cover; background: #2a2450; flex: none; }
    .price { font-weight: 700; font-size: 15px; }
    .place { color: #b9b5d8; font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .rows { list-style: none; margin: 0; padding: 0 2px 0 0; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 0; scroll-behavior: smooth; }
    .rows::-webkit-scrollbar { width: 6px; }
    .rows::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .15); border-radius: 3px; }
    .row { padding: 7px 10px; border-radius: 10px; background: rgba(255, 255, 255, .04); border: 1px solid rgba(255, 255, 255, .05); animation: rowIn .45s cubic-bezier(.2, .8, .2, 1); }
    .row.fresh { animation: rowIn .45s cubic-bezier(.2, .8, .2, 1), flash 1.2s ease; }
    .row .k { color: #a5a1c7; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; }
    .row .v { font-weight: 600; word-break: break-word; }
    .row.more { color: #a5a1c7; text-align: center; font-size: 12px; }
    @keyframes rowIn { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
    @keyframes flash { 0%, 30% { background: rgba(139, 92, 246, .35); border-color: rgba(167, 139, 250, .6); } }

    /* Bottom control bar. */
    .hud {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); width: min(760px, calc(100vw - 32px));
      display: flex; align-items: center; gap: 16px; padding: 12px 14px 12px 18px; pointer-events: auto;
      border-radius: 18px; background: var(--glass); backdrop-filter: blur(16px) saturate(1.4);
      border: 1px solid rgba(255, 255, 255, .1); box-shadow: 0 20px 60px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .06);
    }
    .live { display: flex; align-items: center; gap: 7px; font-weight: 800; font-size: 11px; letter-spacing: .12em; color: #c4b5fd; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #a78bfa; box-shadow: 0 0 0 0 rgba(167, 139, 250, .7); animation: pulse 1.6s infinite; }
    .hud.idle .dot { animation: none; background: var(--ok); }
    @keyframes pulse { 70% { box-shadow: 0 0 0 9px rgba(167, 139, 250, 0); } 100% { box-shadow: 0 0 0 0 rgba(167, 139, 250, 0); } }
    .hud-main { flex: 1; min-width: 0; }
    .phase { font-weight: 700; font-size: 13.5px; }
    .msg { color: #bdb8de; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track { margin-top: 7px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, .1); overflow: hidden; }
    .fill { height: 100%; width: 0; border-radius: inherit; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .5s ease; }
    .count { text-align: right; line-height: 1.1; }
    .count b { display: block; font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .count b.bump { animation: bump .35s ease; }
    @keyframes bump { 40% { transform: scale(1.18); color: #6ee7b7; } }
    .count span { color: #a5a1c7; font-size: 11px; }
    .btn {
      all: unset; cursor: pointer; display: grid; place-items: center; height: 34px; padding: 0 14px; border-radius: 10px;
      font-weight: 700; font-size: 12.5px; color: #fff; background: rgba(255, 255, 255, .08); border: 1px solid rgba(255, 255, 255, .1);
    }
    .btn:hover { background: rgba(255, 255, 255, .14); }
    .btn.icon { width: 34px; padding: 0; }
    .btn.stop { background: rgba(244, 63, 94, .2); border-color: rgba(244, 63, 94, .35); color: #fecdd3; }
    .btn.stop:hover { background: rgba(244, 63, 94, .32); }
    .hud.idle .btn { display: none; }

    /* "Confirm you're human" toast (bottom right, above the bar). */
    .toast {
      position: fixed; right: 20px; bottom: 104px; width: 340px;
      display: grid; grid-template-columns: 40px 1fr; gap: 12px; padding: 16px;
      border-radius: 16px; background: var(--glass); backdrop-filter: blur(16px) saturate(1.4);
      border: 1px solid rgba(251, 146, 60, .45);
      box-shadow: 0 20px 60px rgba(0, 0, 0, .5), 0 0 0 0 rgba(251, 146, 60, .5);
      opacity: 0; transform: translateY(16px) scale(.97); visibility: hidden;
      transition: opacity .35s ease, transform .45s cubic-bezier(.2, .8, .2, 1), visibility 0s .45s;
    }
    .toast.on {
      opacity: 1; transform: none; visibility: visible; transition-delay: 0s;
      animation: attention 2s ease-out infinite;
    }
    @keyframes attention { 0% { box-shadow: 0 20px 60px rgba(0, 0, 0, .5), 0 0 0 0 rgba(251, 146, 60, .55); } 70%, 100% { box-shadow: 0 20px 60px rgba(0, 0, 0, .5), 0 0 0 14px rgba(251, 146, 60, 0); } }
    .toast-icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: rgba(251, 146, 60, .18); color: #fdba74; }
    .toast-title { font-weight: 700; font-size: 14px; }
    .toast-text { margin-top: 4px; color: #c9c5e6; font-size: 12.5px; }

    /* "Hide animation": keep only the bar (and the toast). */
    .muted .hole, .muted .ring, .muted .mark, .muted .plus, .muted .cursor, .muted .ripple, .muted .panel { visibility: hidden; }
    .resting .hole, .resting .ring { opacity: 0; }

    @media (prefers-reduced-motion: reduce) {
      .ring::after, .dot, .toast.on { animation: none; }
    }
  `;

  const HTML = `
    <div class="layer">
      <div class="hole"></div>
      <div class="marks"></div>
      <div class="ring"><span class="chip"></span></div>
      <aside class="panel" aria-label="Extracted data">
        <div class="panel-head"><span class="panel-title">Extracted data</span><span class="panel-sub">Listing <b class="no">1</b> / <span class="of">1</span></span></div>
        <span class="step"><span class="spin"></span><span class="step-text">Reading data…</span></span>
        <div class="card"><img class="thumb" alt="" /><div><div class="price"></div><div class="place"></div></div></div>
        <ul class="rows"></ul>
      </aside>
      <div class="hud">
        <div class="live"><span class="dot"></span>LIVE</div>
        <div class="hud-main">
          <div class="phase">Starting…</div>
          <div class="msg"></div>
          <div class="track"><div class="fill"></div></div>
        </div>
        <div class="count"><b>0</b><span>properties</span></div>
        <button class="btn icon hide" title="Hide the animation (keeps scraping)">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>
        </button>
        <button class="btn stop">Stop</button>
      </div>
      <div class="toast" role="alert">
        <div class="toast-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 9.5C8 19.3 5 15.5 5 11V6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div>
          <div class="toast-title">Please confirm you're human</div>
          <div class="toast-text">ingatlan.com's security check paused the scraping. Tick the box on this page, and it continues by itself. Nothing is lost.</div>
        </div>
      </div>
      <div class="cursor">
        <svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2.5l15.5 9.2-6.9 1.5 3.9 7.4-3 1.5-3.8-7.5L4.5 19z" fill="#fff" stroke="#1e1b4b" stroke-width="1.4" stroke-linejoin="round"/></svg>
      </div>
    </div>
  `;

  // ---------- mounting & the animation loop ----------

  function mount(instant) {
    unmount();
    host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style>${HTML}`;
    document.documentElement.appendChild(host);

    const q = (s) => shadow.querySelector(s);
    ui = {
      layer: q('.layer'),
      marks: q('.marks'),
      panel: q('.panel'),
      step: q('.step'),
      stepText: q('.step-text'),
      no: q('.no'),
      of: q('.of'),
      thumb: q('.thumb'),
      price: q('.price'),
      place: q('.place'),
      rows: q('.rows'),
      hud: q('.hud'),
      phase: q('.phase'),
      msg: q('.msg'),
      fill: q('.fill'),
      count: q('.count b'),
      cursor: q('.cursor'),
      toast: q('.toast'),
    };
    ui.hole = mover(q('.hole'), 12, 0.2);
    ui.ring = mover(q('.ring'), 6, 0.3);

    q('.stop').addEventListener('click', () => onStop());
    q('.hide').addEventListener('click', () => ui.layer.classList.toggle('muted'));

    // A run moving to the next page shouldn't fade the bar out and in again.
    if (instant) ui.layer.classList.add('instant', 'on');
    else requestAnimationFrame(() => ui && ui.layer.classList.add('on'));
    raf = requestAnimationFrame(tick);
  }

  function unmount() {
    clearTimeout(unmountTimer);
    clearTimeout(toastTimer);
    cancelAnimationFrame(raf);
    movers.clear();
    marks = [];
    cursorAt = null;
    if (host) host.remove();
    host = null;
    ui = null;
  }

  /** An overlay box that follows an element (smoothly, so it glides between targets). */
  function mover(node, pad, lerp) {
    const m = { node, el: null, pad, lerp, cur: null };
    movers.add(m);
    return m;
  }

  function aim(m, el, chip) {
    m.el = el || null;
    const c = m.node.querySelector('.chip');
    if (c) c.textContent = chip || '';
  }

  function tick() {
    for (const m of movers) {
      const el = m.el;
      if (!el || !el.isConnected) {
        m.node.classList.remove('on');
        m.cur = null;
        continue;
      }
      const r = el.getBoundingClientRect();
      const t = { x: r.left - m.pad, y: r.top - m.pad, w: r.width + 2 * m.pad, h: r.height + 2 * m.pad };
      if (!m.cur) m.cur = t;
      else for (const k in t) m.cur[k] += (t[k] - m.cur[k]) * m.lerp;
      const c = m.cur;
      m.node.style.transform = `translate(${c.x}px, ${c.y}px)`;
      m.node.style.width = c.w + 'px';
      m.node.style.height = c.h + 'px';
      m.node.classList.toggle('below', c.y < 48);
      m.node.classList.add('on');
    }
    for (const mk of marks) {
      const r = mk.el.getBoundingClientRect();
      mk.node.style.transform = `translate(${r.right - 34}px, ${r.top + 8}px)`;
    }
    raf = requestAnimationFrame(tick);
  }

  async function moveCursor(x, y, ms) {
    const c = ui.cursor;
    if (!cursorAt) {
      cursorAt = { x: innerWidth * 0.72, y: innerHeight * 0.78 };
      c.style.transition = 'none';
      c.style.transform = `translate(${cursorAt.x}px, ${cursorAt.y}px)`;
      void c.offsetWidth;
    }
    c.classList.add('on');
    c.style.transition = `transform ${ms}ms cubic-bezier(.3, .7, .15, 1), opacity .25s`;
    c.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
    cursorAt = { x, y };
    await wait(ms);
  }

  async function press(x, y) {
    ui.cursor.classList.add('down');
    const rip = document.createElement('div');
    rip.className = 'ripple';
    rip.style.transform = `translate(${x}px, ${y}px)`;
    ui.layer.appendChild(rip);
    setTimeout(() => rip.remove(), 700);
    await wait(170);
    ui.cursor.classList.remove('down');
  }

  function hideCursor() {
    if (ui) ui.cursor.classList.remove('on');
  }

  /** Cursor glides to the element and clicks it (visually; the caller does any real click). */
  async function clickAt(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    await moveCursor(x, y, 650);
    ui.ring.node.classList.remove('pressed');
    void ui.ring.node.offsetWidth;
    ui.ring.node.classList.add('pressed');
    await press(x, y);
  }

  // ---------- HUD ----------

  const PHASES = {
    list: 'Scanning result pages',
    details: 'Reading listings',
    done: 'Finished',
    stopped: 'Stopped',
    error: 'Stopped with an error',
  };

  function showCount(n, bump = true) {
    if (!ui || n === counter.shown) return;
    counter.shown = n;
    ui.count.textContent = n.toLocaleString();
    if (!bump) return;
    ui.count.classList.remove('bump');
    void ui.count.offsetWidth;
    ui.count.classList.add('bump');
  }

  /** Mirrors the run status (called from setStatus in content.js). */
  function hud(s) {
    if (!ui) return;
    ui.phase.textContent = PHASES[s.phase] || 'Working…';
    ui.msg.textContent = s.message || '';
    ui.hud.classList.toggle('idle', !s.running);
    let pct = 0;
    if (!s.running) pct = 100;
    else if (s.phase === 'details' && s.total) pct = (100 * (s.current - 1)) / s.total;
    else if (s.phase === 'list' && s.lastPage) pct = (100 * Math.max(0, (s.page || 1) - 1)) / s.lastPage;
    ui.fill.style.width = Math.min(100, pct) + '%';
    counter.real = s.found || 0;
    if (!counter.scanning) showCount(counter.real, counter.shown !== 0);
  }

  function rest(on) {
    if (ui) ui.layer.classList.toggle('resting', !!on);
  }

  /** Shows or hides the "confirm you're human" toast. The user ticks the box themselves. */
  function humanCheck(active) {
    if (!ui) return;
    clearTimeout(toastTimer);
    ui.toast.classList.toggle('on', !!active);
  }

  // ---------- result pages ----------

  function liveCards() {
    return [...document.querySelectorAll(CARD_SELECTOR)];
  }

  function cardId(card) {
    return card.getAttribute('data-listing-id') || ((card.getAttribute('href') || '').match(/\/(\d{5,})/) || [])[1] || '';
  }

  /** Smallest element holding all the nodes (a single card counts as its own box's child). */
  function commonBox(nodes) {
    if (!nodes.length) return null;
    let box = nodes.length === 1 ? nodes[0].parentElement : nodes[0];
    while (box && !nodes.every((n) => box.contains(n))) box = box.parentElement;
    return box && box !== document.body && box !== document.documentElement ? box : null;
  }

  function findNextLink(nextPage) {
    const re = new RegExp(`[?&]page=${nextPage}(?:&|$)`);
    const links = [...document.querySelectorAll('a[href*="/lista/"]')].filter((a) => re.test(a.getAttribute('href')) && !inChrome(a));
    // Prefer the "next" arrow ("Következő oldal") over the plain page number.
    return links.find((a) => !/^\d+$/.test(clean(a.textContent))) || links[links.length - 1] || null;
  }

  function cardChip(l) {
    const parts = [l.priceText, l.area ? `${l.area} m²` : '', l.district || l.city].filter(Boolean);
    return '✓ ' + (parts.join(' · ') || 'Captured');
  }

  function addMark(el) {
    const node = document.createElement('div');
    node.className = 'mark';
    node.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    ui.marks.appendChild(node);
    marks.push({ node, el });
  }

  /** A "+1" that flies from the card into the counter. */
  function flyPlus(el) {
    const r = el.getBoundingClientRect();
    const to = ui.count.getBoundingClientRect();
    const node = document.createElement('div');
    node.className = 'plus';
    node.textContent = '+1';
    ui.layer.appendChild(node);
    const from = `translate(${r.left + r.width / 2}px, ${r.top + r.height / 2}px)`;
    node
      .animate(
        [
          { transform: from + ' scale(.6)', opacity: 0 },
          { transform: from + ' scale(1.1)', opacity: 1, offset: 0.2 },
          { transform: `translate(${to.left + to.width / 2}px, ${to.top}px) scale(.7)`, opacity: 0.2 },
        ],
        { duration: 750, easing: 'cubic-bezier(.5, 0, .2, 1)' }
      )
      .finished.finally(() => node.remove());
  }

  /**
   * Highlights the cards on this page one by one, then "clicks" the next-page
   * button (the caller then opens that page). Takes about `ms`.
   */
  async function scanList(listings, ms, nextPage) {
    if (!ui || document.hidden) return;
    const byId = new Map(liveCards().map((c) => [cardId(c), c]));
    const cards = listings.map((l) => ({ l, el: byId.get(l.id) })).filter((c) => c.el);
    if (!cards.length) return;
    rest(false);
    aim(ui.hole, commonBox(cards.map((c) => c.el)));
    const next = nextPage ? findNextLink(nextPage) : null;
    const tail = next ? Math.min(1800, ms * 0.3) : 0;
    const per = Math.max(60, Math.min(900, (ms - tail - 300) / cards.length));

    counter.scanning = true;
    let shown = Math.max(0, counter.real - cards.length);
    showCount(shown, false);
    try {
      await wait(300);
      for (const { l, el } of cards) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        aim(ui.ring, el, cardChip(l));
        await wait(per * 0.55);
        addMark(el);
        flyPlus(el);
        showCount((shown = Math.min(counter.real, shown + 1)));
        await wait(per * 0.45);
      }
    } finally {
      counter.scanning = false;
      showCount(counter.real);
      aim(ui.ring, null);
    }

    if (next) {
      next.scrollIntoView({ block: 'center', behavior: 'smooth' });
      aim(ui.hole, next);
      aim(ui.ring, next, 'Next page →');
      await wait(tail * 0.35);
      await clickAt(next);
      await wait(Math.max(0, tail * 0.3 - 170));
    }
  }

  // ---------- listing pages ----------

  function setStep(text, kind) {
    ui.stepText.textContent = text;
    ui.step.className = 'step' + (kind ? ' ' + kind : '');
  }

  /** Opens the "Extracted data" panel for the listing on this page. */
  function openListing(row, index, total) {
    if (!ui) return;
    ui.no.textContent = index;
    ui.of.textContent = total;
    if (row.imageUrl) ui.thumb.src = row.imageUrl;
    else ui.thumb.removeAttribute('src');
    ui.price.textContent = row.priceText || '';
    ui.place.textContent = row.address || '';
    ui.rows.replaceChildren();
    setStep('Reading data…');
    ui.panel.classList.add('on');
  }

  /** Animated click on an element on this page. The caller does the real click. */
  async function click(el, label) {
    if (!ui || document.hidden) return;
    setStep('Revealing phone number…');
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
    aim(ui.hole, el);
    aim(ui.ring, el, label);
    await wait(250);
    await clickAt(el);
    await wait(150);
    hideCursor();
  }

  const FIELD_PRIORITY = [
    [/emelet|floor|level/i, 4],
    [/szob|room|alapter|area/i, 3],
  ];

  /** The values to highlight, each with the element on the page it was read from (if found). */
  function dataEntries(row, detail, phones) {
    const root = document.querySelector('main') || document.body;
    const leaves = [...root.querySelectorAll('th, td, dt, dd, span, div, p, strong, b, h2, h3, li, a')].filter(
      (e) => !e.firstElementChild && !inChrome(e) && !host.contains(e)
    );
    const byText = (text) => {
      const t = clean(text);
      return t ? leaves.find((e) => clean(e.textContent).replace(/:$/, '') === t) || null : null;
    };

    const entries = [];
    const push = (label, value, el, priority) => value && entries.push({ label, value: clean(String(value)), el, priority });

    push('Title', detail.title, document.querySelector('h1'), 5);
    push('Price', row.priceText, byText(row.priceText), 5);
    for (const [k, v] of Object.entries(detail.fields || {})) {
      const label = byText(k);
      const box = label && (label.closest('tr') || label.parentElement);
      const p = (FIELD_PRIORITY.find(([re]) => re.test(k)) || [null, 1])[1];
      push(k, v, box, p);
    }
    const agency = [...document.querySelectorAll('a[href*="iroda.ingatlan.com"]')].find((a) => !inChrome(a));
    push('Advertiser', detail.advertiserName || detail.advertiserType, agency || null, 4);
    if (phones && phones.length) {
      const re = new RegExp(window.IngatlanParser.PHONE_RE.source);
      const tel = [...document.querySelectorAll('a[href^="tel:"]')].find((a) => !inChrome(a)) || leaves.find((e) => re.test(e.textContent));
      push('Phone', phones.join(', '), tel || null, 5);
    }
    const desc = document.querySelector('#listing-description, [class*="listing-description"], [data-testid*="description"]');
    push('Description', detail.description && detail.description.slice(0, 90) + (detail.description.length > 90 ? '…' : ''), desc, 2);
    return entries;
  }

  function addRow(label, value) {
    const li = document.createElement('li');
    li.className = 'row fresh';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = label;
    const v = document.createElement('div');
    v.className = 'v';
    v.textContent = value.length > 120 ? value.slice(0, 120) + '…' : value;
    li.append(k, v);
    ui.rows.appendChild(li);
    ui.rows.scrollTop = ui.rows.scrollHeight;
  }

  /**
   * Walks through the values read from this listing: scrolls to each one, spotlights
   * it and adds it to the panel. Takes about `ms`.
   */
  async function inspect(row, detail, phones, ms) {
    if (!ui) return;
    const all = dataEntries(row, detail, phones);
    const room = Math.max(3, Math.floor((ms - 500) / 320));
    // Most interesting values first, then shown top to bottom like a person reading the page.
    const picked = all
      .map((e, i) => ({ ...e, i }))
      .sort((a, b) => b.priority - a.priority || a.i - b.i)
      .slice(0, room)
      .sort((a, b) => {
        if (a.el && b.el) return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        return a.el ? -1 : b.el ? 1 : a.i - b.i;
      });
    const per = Math.max(120, Math.min(1100, (ms - 500) / Math.max(1, picked.length)));
    const animate = !document.hidden;

    setStep('Reading data…');
    for (const e of picked) {
      if (animate && e.el) {
        e.el.scrollIntoView({ block: 'center', behavior: per > 500 ? 'smooth' : 'auto' });
        aim(ui.hole, e.el);
        aim(ui.ring, e.el, `${e.label}: ${e.value}`);
      } else {
        aim(ui.hole, null);
        aim(ui.ring, null);
      }
      addRow(e.label, e.value);
      await wait(animate ? per : 0);
    }
    const others = all.length - picked.length;
    if (others > 0) {
      const li = document.createElement('li');
      li.className = 'row more';
      li.textContent = `+ ${others} more value${others === 1 ? '' : 's'} saved`;
      ui.rows.appendChild(li);
    }
    aim(ui.hole, null);
    aim(ui.ring, null);
    setStep('Saved', 'ok');
    await wait(animate ? 300 : 0);
  }

  function failed(message) {
    if (!ui) return;
    aim(ui.hole, null);
    aim(ui.ring, null);
    setStep(message.length > 40 ? 'Could not read this listing' : message, 'err');
  }

  // ---------- lifecycle ----------

  /**
   * Puts the stage on this page.
   * @param {{ onStop: Function, isStopped: () => boolean, instant?: boolean }} hooks
   *   instant: the run just moved here from another page, so show the bar without fading in.
   */
  function begin(hooks) {
    onStop = hooks.onStop || (() => {});
    isStopped = hooks.isStopped || (() => false);
    counter.shown = 0;
    counter.real = 0;
    counter.scanning = false;
    mount(!!hooks.instant);
  }

  /** Leaves the final status on screen for a moment, then fades out. */
  function end() {
    if (!ui) return;
    aim(ui.hole, null);
    aim(ui.ring, null);
    hideCursor();
    rest(false);
    humanCheck(false);
    ui.panel.classList.remove('on');
    ui.layer.classList.remove('instant');
    unmountTimer = setTimeout(() => {
      if (!ui) return;
      ui.layer.classList.remove('on');
      unmountTimer = setTimeout(unmount, 400);
    }, 3500);
  }

  window.IngatlanStage = {
    Stopped,
    get active() {
      return !!ui;
    },
    begin,
    end,
    hud,
    rest,
    humanCheck,
    scanList,
    openListing,
    click,
    inspect,
    failed,
  };
})();
