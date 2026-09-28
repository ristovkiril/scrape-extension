/*
 * Content script for https://ingatlan.com/lista/* pages.
 *
 * Flow:
 *   1. Walk the result pages (?page=1, 2, ...) with fetch() and collect every
 *      listing card (id, link, price, area, rooms, address, seller info).
 *   2. Optionally open every listing's detail page to get floor, advertiser
 *      type/name, phone number and all other listed parameters.
 *   3. Store everything in chrome.storage.local and offer an Excel download.
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
  const DEFAULT_OPTIONS = { mode: 'quick', maxPages: 100, delayMs: 2500 };

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
    return next;
  }

  // ---------- network ----------

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

  /** Waits between two requests: random delay, plus a longer break every BREAK_EVERY requests. */
  async function politeWait(opts) {
    pacing.requests++;
    if (pacing.requests % BREAK_EVERY === 0) {
      const ms = randomBetween(BREAK_MS[0], BREAK_MS[1]) * pacing.slowdown;
      const until = Date.now() + ms;
      while (Date.now() < until && !stopRequested) {
        await setStatus({ message: `Short break to stay under the site's limit… ${Math.ceil((until - Date.now()) / 1000)} s` });
        await pause(Math.min(5000, until - Date.now()));
      }
      return;
    }
    const base = opts.delayMs * pacing.slowdown;
    await pause(randomBetween(base, base * 1.6));
  }

  function toDoc(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  /**
   * Loads a page in the background worker tab. If Cloudflare asks for a human
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

  // ---------- scraping ----------

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

  /**
   * @param {'new'|'continue'|'enrich'} kind
   *   new      – start a fresh scrape of the current search
   *   continue – pick up a stopped run: remaining result pages, then remaining listings
   *   enrich   – no page scanning; collect `mode`-level data for the rows already collected
   * @param {string} [mode] result type for continue/enrich (defaults to the saved choice / job mode)
   */
  async function run(kind = 'new', mode) {
    if (running) return;
    running = true;
    stopRequested = false;

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
      job = {
        sourceUrl: base.href,
        mode: opts.mode,
        nextPage: 1,
        listDone: false,
        lastPageSeen: P.readPagination(document).lastPage,
        previous: [...previousById.values()],
      };
    } else {
      // continue keeps the job's type unless a higher one was asked for; enrich uses the one asked for.
      const m = kind === 'enrich' ? mode || job.mode : higherMode(job.mode, mode || job.mode);
      opts = withMode(opts, m);
      job = { ...job, mode: higherMode(job.mode, m) };
    }

    const base = new URL(job.sourceUrl);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const previousById = new Map((job.previous || []).map((r) => [r.id, r]));

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

    // The pagination only links nearby pages ("1 2 3 … 21"), so the known last page
    // is a minimum that can grow as we move forward.
    const pagesLabel = (page) =>
      `page ${page} of ${Math.min(job.lastPageSeen, opts.maxPages)}${job.lastPageSeen > page ? '+' : ''}`;

    try {
      // ---- phase 1: result pages ----
      if (kind !== 'enrich' && !job.listDone) {
        let page = job.nextPage || 1;
        for (; page <= opts.maxPages && !stopRequested; page++) {
          await setStatus({ message: `Scanning ${pagesLabel(page)}…`, page, lastPage: job.lastPageSeen, found: rows.length });
          const { doc } = await loadPage(pageUrl(base, page));
          let { listings, hasNextPage, lastPage } = P.parseListPage(doc, page);
          const viewingFirstPage = baseListUrl(location.href).href === base.href && (new URL(location.href).searchParams.get('page') || '1') === '1';
          if (page === 1 && !listings.length && viewingFirstPage) {
            // Fetched HTML had no cards (e.g. rendered client-side) — use the live page instead.
            ({ listings, hasNextPage, lastPage } = P.parseListPage(document, page));
          }
          job.lastPageSeen = Math.max(job.lastPageSeen || 1, lastPage || page);

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

          // Stop when the site has no more pages (or repeats the last one).
          const lastOne = !listings.length || !added || !hasNextPage;
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
        const what = opts.revealPhones ? 'details & phones' : 'details';
        const phaseStart = Date.now();
        for (let i = 0; i < todo.length && !stopRequested; i++) {
          const row = todo[i];
          // Time left from the real speed so far (includes breaks and human checks).
          const eta = i >= 3 ? ((Date.now() - phaseStart) / i) * (todo.length - i) : null;
          await setStatus({
            phase: 'details',
            message: `Collecting ${what} ${i + 1} / ${todo.length}…`,
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
        message: stopRequested ? 'Stopped — download what you have, or continue.' : 'Finished!',
        found: rows.length,
        finishedAt: Date.now(),
      });
    } catch (err) {
      await store.set({ rows, job });
      if (stopRequested) {
        await setStatus({ running: false, phase: 'stopped', message: 'Stopped — download what you have, or continue.', found: rows.length });
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
        stopRequested = true;
        chrome.runtime.sendMessage({ type: 'abortWorker' }).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.type === 'ping') {
        const { lastPage, totalResults } = P.readPagination(document);
        const currentPage = parseInt(new URL(location.href).searchParams.get('page') || '1', 10) || 1;
        sendResponse({ ok: true, running, cardCount: countCardsOnPage(), lastPage: Math.max(lastPage, currentPage), totalResults });
      }
    });

    // A previous run was interrupted: either this very tab was reloaded (sessionStorage
    // survives reloads), or the running tab went silent for several minutes.
    const { status, rows } = await store.get(['status', 'rows']);
    let ownRunId = null;
    try {
      ownRunId = sessionStorage.getItem('ieRunId');
    } catch (_) {}
    const stale = status && Date.now() - (status.updatedAt || 0) > 5 * 60 * 1000;
    if (status && status.running && (status.runId === ownRunId || stale)) {
      await setStatus({
        running: false,
        phase: 'stopped',
        message: `Interrupted — ${(rows || []).length} properties kept. Download them, or continue.`,
      });
    }
  }

  init();
})();
