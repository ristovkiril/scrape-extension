/*
 * Content script for ingatlan.com pages.
 *
 * Flow:
 *   1. Walk the result pages (?page=1, 2, ...) and collect every listing card
 *      (id, link, price, area, rooms, address, seller info).
 *   2. Optionally open every listing's detail page to get floor, advertiser
 *      type/name, phone number and all other listed parameters.
 *   3. Store everything in chrome.storage.local and offer an Excel download.
 *
 * Two ways to run:
 *   - Live (Settings → "Show the scraping live on the page", the default): the tab
 *     itself opens every result page and listing, like a person browsing, and the
 *     stage (src/stage.js) animates each one. Every page load runs one step, and the
 *     position is kept in storage ("tabRun"), so the run survives the reloads.
 *   - Background: the run stays on the results page and loads the other pages with
 *     fetch() (falling back to a worker tab when blocked). Faster, nothing to watch.
 *
 * Progress is stored as it goes ("job" = where the run is, "rows" = what was
 * collected), so a stopped or interrupted run can be downloaded, continued where
 * it stopped, or enriched with more data later.
 */
(function () {
  'use strict';

  if (window.__ingatlanExporterLoaded) return;
  window.__ingatlanExporterLoaded = true;

  const P = window.IngatlanParser;
  const S = window.IngatlanStage;
  const DEFAULT_OPTIONS = { mode: 'quick', maxPages: 100, delayMs: 2500, showOnPage: true };

  // Result types the user picks in the popup.
  const MODES = {
    quick: { fetchDetails: false, revealPhones: false }, // result pages only
    detailed: { fetchDetails: true, revealPhones: false }, // + floor & all parameters
    full: { fetchDetails: true, revealPhones: true }, // + phone numbers
  };
  const MODE_RANK = { quick: 0, detailed: 1, full: 2 };
  const higherMode = (a, b) => ((MODE_RANK[a] || 0) >= (MODE_RANK[b] || 0) ? a : b);

  // Pacing that keeps Cloudflare's "confirm you are human" check rare.
  const BREAK_EVERY = 25; // requests
  const BREAK_MS = [30000, 60000];
  const MAX_SLOWDOWN = 4;

  const STOPPED_MESSAGE = 'Stopped — download what you have, or continue.';

  let stopRequested = false;
  let running = false;

  // ---------- storage helpers ----------

  const store = {
    get: (keys) => chrome.storage.local.get(keys),
    set: (obj) => chrome.storage.local.set(obj),
  };

  async function getOptions() {
    const { options } = await store.get('options');
    const o = { ...DEFAULT_OPTIONS, ...(options || {}) };
    if (!options || !options.v || options.v < 2) o.delayMs = DEFAULT_OPTIONS.delayMs; // v1 default (1.2 s) was too fast
    return o;
  }

  const withMode = (opts, mode) => ({ ...opts, mode, ...(MODES[mode] || MODES.quick) });

  async function setStatus(patch) {
    const { status } = await store.get('status');
    const next = { ...(status || {}), ...patch, updatedAt: Date.now() };
    await store.set({ status: next });
    S.hud(next);
    return next;
  }

  // ---------- pacing ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomBetween = (a, b) => a + Math.floor(Math.random() * (b - a));

  /** Sleeps in small steps so Stop takes effect immediately. */
  async function pause(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !stopRequested) await sleep(Math.min(500, until - Date.now()));
  }

  // Adaptive pacing: every human check / rate limit makes the rest of the run slower.
  const pacing = { requests: 0, slowdown: 1 };

  function noteBlocked() {
    pacing.slowdown = Math.min(MAX_SLOWDOWN, pacing.slowdown * 1.5);
  }

  /**
   * Waits between two requests: random delay, plus a longer break every BREAK_EVERY requests.
   * `animate(ms)` plays the on-page animation during the wait; it never makes the wait longer.
   */
  async function politeWait(opts, animate) {
    pacing.requests++;
    if (pacing.requests % BREAK_EVERY === 0) {
      const ms = randomBetween(BREAK_MS[0], BREAK_MS[1]) * pacing.slowdown;
      const until = Date.now() + ms;
      if (animate) await animate(8000).catch(() => {});
      S.rest(true);
      while (Date.now() < until && !stopRequested) {
        await setStatus({ message: `Short break to stay under the site's limit… ${Math.ceil((until - Date.now()) / 1000)} s` });
        await pause(Math.min(5000, until - Date.now()));
      }
      S.rest(false);
      return;
    }
    const base = opts.delayMs * pacing.slowdown;
    const ms = randomBetween(base, base * 1.6);
    await Promise.all([pause(ms), animate ? animate(ms).catch(() => {}) : null]);
  }

  // ---------- shared scraping helpers ----------

  function baseListUrl(href) {
    const u = new URL(href);
    u.searchParams.delete('page');
    u.hash = '';
    return u;
  }

  function pageUrl(base, n) {
    const u = new URL(base.href);
    if (n > 1) u.searchParams.set('page', String(n));
    return u.href;
  }

  function pageOf(href) {
    return parseInt(new URL(href).searchParams.get('page') || '1', 10) || 1;
  }

  function advertiserFromWebsite(website) {
    const m = (website || '').match(/iroda\.ingatlan\.com\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function applyDetail(row, detail, workerPhones) {
    row.title = detail.title;
    row.floor = detail.floor;
    row.buildingLevels = detail.buildingLevels;
    row.description = detail.description;
    row.fields = detail.fields;
    row.agencyUrl = detail.agencyUrl;
    if (!row.sellerWebsite && detail.advertiserType) row.advertiserType = detail.advertiserType;
    row.advertiserName = detail.advertiserName || row.advertiserName;
    row.phones = [...new Set([...(workerPhones || []), ...(detail.phones || [])])];
  }

  /** Does this row still need a visit to its listing page for the given options? */
  function needsDetailVisit(row, opts) {
    if (!opts.fetchDetails) return false;
    return row.detailStatus !== 'ok' || (opts.revealPhones && !row.phoneChecked);
  }

  function pick(obj, keys) {
    const out = {};
    keys.forEach((k) => obj[k] !== undefined && (out[k] = obj[k]));
    return out;
  }

  /** Adds the cards of one result page to `rows`. @returns {number} how many were new */
  function addListings(listings, { rows, byId, previousById, opts }) {
    let added = 0;
    for (const l of listings) {
      if (byId.has(l.id)) continue;
      l.advertiserType = l.sellerWebsite ? 'Real estate agency' : 'Private person (probable)';
      l.advertiserName = advertiserFromWebsite(l.sellerWebsite);
      l.phones = [];
      l.detailStatus = opts.fetchDetails ? 'pending' : 'skipped';
      const old = previousById.get(l.id);
      // Reuse details from an earlier run, unless this run also needs phones and that one didn't get them.
      if (old && opts.fetchDetails && (!opts.revealPhones || old.phoneChecked)) {
        Object.assign(l, pick(old, ['title', 'floor', 'buildingLevels', 'description', 'fields', 'agencyUrl', 'advertiserType', 'advertiserName', 'phones', 'phoneChecked']));
        l.detailStatus = 'ok';
      }
      byId.set(l.id, l);
      rows.push(l);
      added++;
    }
    return added;
  }

  /** Updates the job's known page count from a parsed result page. */
  function notePageCount(job, { lastPage, pagesExact }, page) {
    // The "1 / 9" counter is exact (and may shrink if listings were removed meanwhile).
    if (pagesExact) job.lastPageSeen = Math.max(lastPage, page);
    else job.lastPageSeen = Math.max(job.lastPageSeen || 1, lastPage || page);
    job.pagesExact = !!pagesExact;
  }

  // Without the "1 / 9" counter the pagination only links nearby pages ("1 2 3 … 21"),
  // so the known last page is a minimum that can grow as we move forward.
  function pagesLabel(job, opts, page) {
    return `page ${page} of ${Math.min(job.lastPageSeen, opts.maxPages)}${!job.pagesExact && job.lastPageSeen > page ? '+' : ''}`;
  }

  function detailsLabel(opts) {
    return opts.revealPhones ? 'details & phones' : 'details';
  }

  /**
   * Sets up a run: the options, the job (where it is) and the rows collected so far.
   * @param {'new'|'continue'|'enrich'} kind
   *   new      – start a fresh scrape of the current search
   *   continue – pick up a stopped run: remaining result pages, then remaining listings
   *   enrich   – no page scanning; collect `mode`-level data for the rows already collected
   * @param {string} [mode] result type for continue/enrich (defaults to the saved choice / job mode)
   */
  async function prepareRun(kind, mode) {
    let opts = await getOptions();
    const saved = await store.get(['rows', 'sourceUrl', 'job']);
    let job = saved.job;
    let rows = Array.isArray(saved.rows) ? saved.rows : [];
    if (kind !== 'new' && (!job || !rows.length)) kind = 'new';

    if (kind === 'new') {
      const base = baseListUrl(location.href);
      opts = withMode(opts, opts.mode);
      // Same search scraped before → reuse details already fetched for a listing.
      const previousById = new Map();
      if (saved.sourceUrl === base.href) rows.forEach((r) => r.detailStatus === 'ok' && previousById.set(r.id, r));
      rows = [];
      const pagination = P.readPagination(document);
      job = {
        sourceUrl: base.href,
        mode: opts.mode,
        nextPage: 1,
        listDone: false,
        lastPageSeen: pagination.lastPage,
        pagesExact: pagination.pagesExact,
        previous: [...previousById.values()],
      };
    } else {
      // continue keeps the job's type unless a higher one was asked for; enrich uses the one asked for.
      const m = kind === 'enrich' ? mode || job.mode : higherMode(job.mode, mode || job.mode);
      opts = withMode(opts, m);
      job = { ...job, mode: higherMode(job.mode, m) };
    }

    const runId = String(Date.now());
    try {
      sessionStorage.setItem('ieRunId', runId);
    } catch (_) {}
    pacing.requests = 0;
    pacing.slowdown = 1;
    await chrome.runtime.sendMessage({ type: 'runStarted' }).catch(() => {});
    await store.set({ rows, sourceUrl: job.sourceUrl, job });
    await setStatus({
      running: true,
      runId,
      kind,
      phase: 'list',
      message: kind === 'new' ? 'Scanning result pages…' : 'Continuing…',
      found: rows.length,
      page: 0,
      lastPage: job.lastPageSeen,
      current: 0,
      total: 0,
      etaMs: null,
      mode: opts.mode,
      error: '',
    });
    return { kind, opts, job, rows, runId };
  }

  async function run(kind = 'new', mode) {
    if (running) return;
    running = true;
    stopRequested = false;
    const ctx = await prepareRun(kind, mode);
    if (ctx.opts.showOnPage !== false) await startTabRun(ctx);
    else await runInBackground(ctx);
  }

  function requestStop() {
    stopRequested = true;
    chrome.runtime.sendMessage({ type: 'abortWorker' }).catch(() => {});
  }

  // ---------- live: the run walks through the pages in this tab ----------

  // A page that loads this soon after we navigated is ours, even if the site redirected it.
  const OUR_NAVIGATION_MS = 20000;
  // Cloudflare's automatic check usually passes within a few seconds; after that, ask the user.
  const CHALLENGE_AUTO_WAIT_MS = 6000;

  const myTabId = () => chrome.runtime.sendMessage({ type: 'whoami' }).then((r) => r && r.tabId);

  function isChallengeHere() {
    return P.isChallengePage(document.documentElement.outerHTML);
  }

  function beginStage(instant) {
    S.begin({ onStop: requestStop, isStopped: () => stopRequested, instant });
  }

  /** Saves the tab run, unless it was stopped (removed) in the meantime. */
  async function saveTabRun(tr) {
    const { tabRun } = await store.get('tabRun');
    if (!tabRun || tabRun.runId !== tr.runId) {
      stopRequested = true;
      throw new Error('Stopped');
    }
    tr.pacing = { requests: pacing.requests, slowdown: pacing.slowdown };
    await store.set({ tabRun: tr });
  }

  function planDetails(tr, rows) {
    tr.todo = tr.opts.fetchDetails ? rows.filter((r) => needsDetailVisit(r, tr.opts)).map((r) => r.id) : [];
    tr.index = 0;
    tr.detailsStart = Date.now();
    tr.phase = tr.todo.length ? 'details' : 'finish';
  }

  function targetUrl(tr, byId) {
    if (tr.phase === 'list') return pageUrl(new URL(tr.sourceUrl), tr.page);
    if (tr.phase === 'details') {
      const row = byId.get(tr.todo[tr.index]);
      if (row) return row.url;
    }
    return tr.returnUrl;
  }

  function isHere(url) {
    const a = new URL(url);
    const b = new URL(location.href);
    a.hash = b.hash = '';
    return a.href === b.href;
  }

  /** Opens the page of the run's next step in this tab, or runs the step right away if it is already open. */
  async function goNext(tr, byId) {
    const url = targetUrl(tr, byId);
    tr.navAt = Date.now();
    await saveTabRun(tr);
    if (isHere(url)) return tabStep(tr);
    location.href = url;
  }

  async function startTabRun({ kind, opts, job, rows, runId }) {
    const tr = {
      runId,
      tabId: await myTabId(),
      kind,
      opts,
      sourceUrl: job.sourceUrl,
      returnUrl: location.href,
      phase: kind !== 'enrich' && !job.listDone ? 'list' : 'details',
      page: job.nextPage || 1,
      todo: [],
      index: 0,
    };
    if (tr.phase === 'details') planDetails(tr, rows);
    await store.set({ tabRun: tr });
    beginStage(false);
    await stepSafely(() => goNext(tr, new Map(rows.map((r) => [r.id, r]))));
  }

  /** On every page load: if this tab is running a live run, do its next step here. */
  async function resumeTabRun() {
    const { tabRun: tr, status } = await store.get(['tabRun', 'status']);
    if (!tr || !status || !status.running || status.runId !== tr.runId) return false;
    if ((await myTabId().catch(() => null)) !== tr.tabId) return false;

    running = true;
    stopRequested = false;
    if (tr.pacing) Object.assign(pacing, tr.pacing);
    try {
      sessionStorage.setItem('ieRunId', tr.runId);
    } catch (_) {}

    if (isChallengeHere()) {
      await stepSafely(() => waitOutChallenge(tr));
      return true;
    }
    beginStage(true);
    S.hud(status);
    await stepSafely(() => tabStep(tr));
    return true;
  }

  /** Runs a step; turns Stop and errors into a finished run. */
  async function stepSafely(fn) {
    try {
      await fn();
    } catch (err) {
      if (!stopRequested) {
        await finishTabRun('error', `Error: ${err && err.message ? err.message : err}. Download what you have, or continue.`);
        return;
      }
    }
    if (stopRequested) await finishTabRun('stopped');
  }

  /**
   * A Cloudflare check is showing instead of the page. Automatic checks pass by
   * themselves; otherwise the user is asked to tick the box (we never touch it).
   * Either way the page reloads when it passes, and the next load runs the step.
   */
  async function waitOutChallenge(tr) {
    if (!tr.challenged) noteBlocked();
    tr.challenged = true;
    await saveTabRun(tr);
    await setStatus({ message: 'Waiting for the security check…' });
    await pause(CHALLENGE_AUTO_WAIT_MS);
    if (stopRequested || !isChallengeHere()) return;

    beginStage(true);
    S.humanCheck(true);
    chrome.runtime.sendMessage({ type: 'humanCheck', active: true }).catch(() => {});
    // Keep the status fresh so the run doesn't look abandoned while the user gets to it.
    while (!stopRequested && isChallengeHere()) {
      await setStatus({ message: "Paused — tick the box to confirm you're human, and it continues by itself." });
      await pause(30000);
    }
  }

  async function tabStep(tr) {
    const { rows: savedRows, job } = await store.get(['rows', 'job']);
    const rows = savedRows || [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (tr.challenged) {
      tr.challenged = false;
      chrome.runtime.sendMessage({ type: 'humanCheck', active: false }).catch(() => {});
      await setStatus({ message: 'Security check passed — continuing a bit slower…' });
    }
    const ours = Date.now() - (tr.navAt || 0) < OUR_NAVIGATION_MS;
    const ctx = { rows, job, byId, ours };
    if (tr.phase === 'list') return listStep(tr, ctx);
    if (tr.phase === 'details') return detailStep(tr, ctx);
    return finishTabRun('done');
  }

  async function listStep(tr, { rows, job, byId, ours }) {
    const opts = tr.opts;
    const page = tr.page;
    const onTarget = baseListUrl(location.href).href === tr.sourceUrl && pageOf(location.href) === page;
    if (!onTarget) {
      if (!ours) return finishTabRun('stopped', 'Stopped — the tab went to another page. Download what you have, or continue.');
      // The site redirected (e.g. no such page any more): the result pages are done.
      job.listDone = true;
      delete job.previous;
      await store.set({ job });
      planDetails(tr, rows);
      return goNext(tr, byId);
    }

    await setStatus({ phase: 'list', message: `Scanning ${pagesLabel(job, opts, page)}…`, page, lastPage: job.lastPageSeen, found: rows.length });
    const parsed = P.parseListPage(document, page);
    if (!parsed.listings.length && !tr.retried) {
      // No cards can be a hiccup; look once more before treating it as the end.
      tr.retried = true;
      await saveTabRun(tr);
      await pause(3000);
      if (!stopRequested) location.reload();
      return;
    }
    tr.retried = false;
    notePageCount(job, parsed, page);
    const previousById = new Map((job.previous || []).map((r) => [r.id, r]));
    const added = addListings(parsed.listings, { rows, byId, previousById, opts });

    // Stop when the site has no more pages (or repeats the last one), or at "Max pages".
    const lastOne = !parsed.listings.length || !added || !parsed.hasNextPage || page >= opts.maxPages;
    job.nextPage = page + 1;
    if (lastOne) {
      job.listDone = true;
      delete job.previous; // only needed while new rows are still being added
    }
    await store.set({ rows, job });
    await setStatus({ found: rows.length, page, lastPage: job.lastPageSeen });

    if (lastOne) {
      await S.scanList(parsed.listings, Math.min(4000, 300 + parsed.listings.length * 150), null).catch(() => {});
      planDetails(tr, rows);
    } else {
      // The animation ends by "clicking" the next-page button; then we open that page.
      await politeWait(opts, (ms) => S.scanList(parsed.listings, ms, page + 1));
      tr.page = page + 1;
    }
    if (stopRequested) return;
    await goNext(tr, byId);
  }

  async function detailStep(tr, { rows, byId, ours }) {
    const opts = tr.opts;
    const id = tr.todo[tr.index];
    const row = byId.get(id);
    const i = tr.index;
    const total = tr.todo.length;
    // Time left from the real speed so far (includes breaks and human checks).
    const eta = i >= 3 ? ((Date.now() - tr.detailsStart) / i) * (total - i) : null;
    await setStatus({
      phase: 'details',
      message: `Collecting ${detailsLabel(opts)} ${i + 1} / ${total}…`,
      found: rows.length,
      current: i + 1,
      total,
      etaMs: eta,
    });

    let animate = null;
    if (row) {
      if (!location.href.includes(id) && !ours) {
        return finishTabRun('stopped', 'Stopped — the tab went to another page. Download what you have, or continue.');
      }
      S.openListing(row, i + 1, total);
      try {
        if (!location.href.includes(id)) throw new Error('Listing not available');
        let phones = [];
        if (opts.revealPhones) {
          await pause(800); // let the page's scripts set up the phone button
          ({ phones } = await P.revealPhoneNumbers(document, { beforeClick: (b) => S.click(b, 'Show phone number') }));
        }
        const detail = P.parseDetailPage(document);
        if (!detail.title && !Object.keys(detail.fields).length) throw new Error('Listing not available');
        applyDetail(row, detail, phones);
        row.detailStatus = 'ok';
        if (opts.revealPhones) row.phoneChecked = true;
        animate = (ms) => S.inspect(row, detail, row.phones, ms);
      } catch (err) {
        if (stopRequested) return;
        row.detailStatus = 'error: ' + (err && err.message ? err.message : err);
        S.failed(row.detailStatus);
      }
      await store.set({ rows });
    }

    tr.index++;
    if (tr.index < total) {
      await politeWait(opts, animate);
    } else {
      if (animate) await animate(2500).catch(() => {});
      tr.phase = 'finish';
    }
    if (stopRequested) return;
    await goNext(tr, byId);
  }

  async function finishTabRun(phase, message) {
    await chrome.storage.local.remove('tabRun');
    const { rows } = await store.get('rows');
    await setStatus({
      running: false,
      phase,
      message: message || (phase === 'done' ? 'Finished!' : STOPPED_MESSAGE),
      found: (rows || []).length,
      finishedAt: Date.now(),
    });
    chrome.runtime.sendMessage({ type: 'humanCheck', active: false }).catch(() => {});
    running = false;
    S.end();
  }

  // ---------- background: fetch the pages, stay on the results page ----------

  function toDoc(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  /**
   * Loads a page in the worker tab (one tab, reused for the whole run). If Cloudflare asks for a human
   * check, the popup shows a banner and we keep waiting (without reloading the
   * check) until the user completes it or presses Stop.
   */
  async function renderInWorker(url, revealPhone) {
    let res = await chrome.runtime.sendMessage({ type: 'renderPage', url, revealPhone });
    while (res && res.ok && res.needsHuman && !stopRequested) {
      res = await chrome.runtime.sendMessage({ type: 'renderPage', url, revealPhone, resume: true });
    }
    if (stopRequested) throw new Error('Stopped');
    if (!res || !res.ok) throw new Error((res && res.error) || 'Worker tab failed');
    if (res.challenged) {
      noteBlocked();
      await setStatus({ message: 'Security check passed — continuing a bit slower…' });
    }
    return res;
  }

  /**
   * Loads a page as a Document. Tries a same-origin fetch first (fast, uses the
   * user's cookies); falls back to loading it in the worker tab if blocked.
   */
  async function loadPage(url, { revealPhone = false } = {}) {
    if (!revealPhone) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } });
          if (res.status === 429) {
            noteBlocked();
            await setStatus({ message: 'The site asked us to slow down, waiting 60 s…' });
            await pause(60000);
            continue;
          }
          if (res.ok) {
            const html = await res.text();
            if (!P.isChallengePage(html)) return { doc: toDoc(html), phones: [] };
          }
          noteBlocked(); // 403 / challenge page → the worker tab will show the check
        } catch (_) {
          // network error → fall through to the worker tab
        }
        break;
      }
    }
    const res = await renderInWorker(url, revealPhone);
    return { doc: toDoc(res.html), phones: res.phones || [] };
  }

  async function runInBackground({ kind, opts, job, rows }) {
    const base = new URL(job.sourceUrl);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const previousById = new Map((job.previous || []).map((r) => [r.id, r]));

    try {
      // ---- phase 1: result pages ----
      if (kind !== 'enrich' && !job.listDone) {
        let page = job.nextPage || 1;
        const viewingFirstPage = baseListUrl(location.href).href === base.href && pageOf(location.href) === 1;
        for (; page <= opts.maxPages && !stopRequested; page++) {
          await setStatus({ message: `Scanning ${pagesLabel(job, opts, page)}…`, page, lastPage: job.lastPageSeen, found: rows.length });
          const { doc } = await loadPage(pageUrl(base, page));
          let parsed = P.parseListPage(doc, page);
          if (page === 1 && !parsed.listings.length && viewingFirstPage) {
            // Fetched HTML had no cards (e.g. rendered client-side) — use the live page instead.
            parsed = P.parseListPage(document, page);
          }
          notePageCount(job, parsed, page);
          const added = addListings(parsed.listings, { rows, byId, previousById, opts });

          // Stop when the site has no more pages (or repeats the last one).
          const lastOne = !parsed.listings.length || !added || !parsed.hasNextPage;
          job.nextPage = page + 1;
          if (lastOne) {
            job.listDone = true;
            delete job.previous; // only needed while new rows are still being added
          }
          await store.set({ rows, job });
          await setStatus({ found: rows.length, page, lastPage: job.lastPageSeen });

          if (lastOne) break;
          await politeWait(opts);
        }
        if (page > opts.maxPages) {
          job.listDone = true; // reached the "Max pages" setting
          delete job.previous;
          await store.set({ job });
        }
      }

      // ---- phase 2: detail pages ----
      if (opts.fetchDetails && !stopRequested) {
        const todo = rows.filter((r) => needsDetailVisit(r, opts));
        const phaseStart = Date.now();
        for (let i = 0; i < todo.length && !stopRequested; i++) {
          const row = todo[i];
          // Time left from the real speed so far (includes breaks and human checks).
          const eta = i >= 3 ? ((Date.now() - phaseStart) / i) * (todo.length - i) : null;
          await setStatus({
            phase: 'details',
            message: `Collecting ${detailsLabel(opts)} ${i + 1} / ${todo.length}…`,
            found: rows.length,
            current: i + 1,
            total: todo.length,
            etaMs: eta,
          });
          try {
            const { doc, phones } = await loadPage(row.url, { revealPhone: opts.revealPhones });
            applyDetail(row, P.parseDetailPage(doc), phones);
            row.detailStatus = 'ok';
            if (opts.revealPhones) row.phoneChecked = true;
          } catch (err) {
            if (stopRequested) break;
            row.detailStatus = 'error: ' + (err && err.message ? err.message : err);
          }
          if (i % 3 === 0 || i === todo.length - 1) await store.set({ rows });
          if (i < todo.length - 1) await politeWait(opts);
        }
      }

      await store.set({ rows, job });
      await setStatus({
        running: false,
        phase: stopRequested ? 'stopped' : 'done',
        message: stopRequested ? STOPPED_MESSAGE : 'Finished!',
        found: rows.length,
        finishedAt: Date.now(),
      });
    } catch (err) {
      await store.set({ rows, job });
      if (stopRequested) {
        await setStatus({ running: false, phase: 'stopped', message: STOPPED_MESSAGE, found: rows.length });
        return;
      }
      await setStatus({
        running: false,
        phase: 'error',
        message: `Error: ${err && err.message ? err.message : err}. Download what you have, or continue.`,
        found: rows.length,
      });
    } finally {
      running = false;
      chrome.runtime.sendMessage({ type: 'closeWorker' }).catch(() => {});
    }
  }

  // ---------- messages & start-up ----------

  const CARD_SELECTOR = 'a.listing-card[data-listing-id], [data-testid="listing-card"]';

  /** Number of property cards visible on the live page (0 = no search results listed). */
  function countCardsOnPage() {
    return new Set([...document.querySelectorAll(CARD_SELECTOR)].map((c) => c.getAttribute('data-listing-id') || c.getAttribute('href'))).size;
  }

  async function init() {
    // Registered before any await, so the popup can talk to a freshly injected script.
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'start') {
        run(msg.kind || 'new', msg.mode);
        sendResponse({ ok: true });
      } else if (msg.type === 'stop') {
        requestStop();
        sendResponse({ ok: true });
      } else if (msg.type === 'ping') {
        const { lastPage, pagesExact, totalResults } = P.readPagination(document);
        sendResponse({ ok: true, running, cardCount: countCardsOnPage(), lastPage: Math.max(lastPage, pageOf(location.href)), pagesExact, totalResults });
      }
    });

    if (await resumeTabRun()) return;

    // A previous run was interrupted: either this very tab was reloaded (sessionStorage
    // survives reloads), or the running tab went silent for several minutes.
    const { status, rows } = await store.get(['status', 'rows']);
    let ownRunId = null;
    try {
      ownRunId = sessionStorage.getItem('ieRunId');
    } catch (_) {}
    const stale = status && Date.now() - (status.updatedAt || 0) > 5 * 60 * 1000;
    if (status && status.running && (status.runId === ownRunId || stale)) {
      await chrome.storage.local.remove('tabRun');
      await setStatus({
        running: false,
        phase: 'stopped',
        message: `Interrupted — ${(rows || []).length} properties kept. Download them, or continue.`,
      });
    }
  }

  init();
})();
