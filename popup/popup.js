'use strict';

const DEFAULT_OPTIONS = { mode: 'quick', maxPages: 100, delayMs: 2500 };
const OPTIONS_VERSION = 3;
const SITE_RE = /^https:\/\/(www\.)?ingatlan\.com\//;
const LIST_RE = /^https:\/\/(www\.)?ingatlan\.com\/lista\//;
const CONTENT_FILES = ['src/parser.js', 'src/content.js'];

const $ = (id) => document.getElementById(id);

// A run that has not reported progress for 5 minutes belongs to a closed/crashed tab.
const isRunning = (s) => !!(s && s.running && Date.now() - (s.updatedAt || 0) < 5 * 60 * 1000);

let activeTab = null;
let pageState = 'checking'; // invalid | notList | empty | ready
let pageInfo = { cardCount: 0, lastPage: 1, totalResults: null };
let showStartAgain = false;
let shownCount = 0;

// ---------- options ----------

async function getOptions() {
  const { options } = await chrome.storage.local.get('options');
  const o = { ...DEFAULT_OPTIONS, ...(options || {}) };
  if (!options || !options.v || options.v < 2) o.delayMs = DEFAULT_OPTIONS.delayMs; // v1 default (1.2 s) was too fast
  if (options && !options.mode) {
    // Settings from before result types existed.
    o.mode = options.fetchDetails ? (options.revealPhones ? 'full' : 'detailed') : 'quick';
  }
  return o;
}

function selectedMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : DEFAULT_OPTIONS.mode;
}

function renderOptions(o) {
  $('maxPages').value = o.maxPages;
  $('delayMs').value = o.delayMs;
  const radio = document.querySelector(`input[name="mode"][value="${o.mode}"]`);
  if (radio) radio.checked = true;
  renderEstimates();
}

function readOptions() {
  return {
    v: OPTIONS_VERSION,
    mode: selectedMode(),
    maxPages: Math.max(1, parseInt($('maxPages').value, 10) || DEFAULT_OPTIONS.maxPages),
    delayMs: Math.max(1000, parseInt($('delayMs').value, 10) || DEFAULT_OPTIONS.delayMs),
  };
}

async function saveOptions() {
  await chrome.storage.local.set({ options: readOptions() });
}

// ---------- time estimates ----------

// Mirrors the pacing in src/content.js: a random wait of delay…1.6×delay between
// requests and a 30–60 s break every 25 requests. Load times are typical values:
// a fetched page takes ~1 s, a listing opened in a tab + phone reveal ~4–8 s.
const PACING = { breakEvery: 25, breakSec: [30, 60], delaySpread: 1.6 };
const LOAD_SEC = { page: [0.8, 1.5], phone: [4, 8] };

function searchSize(maxPages) {
  const perPage = pageInfo.cardCount || 20;
  let pages = pageInfo.lastPage || 1;
  let listings = pages * perPage;
  if (pageInfo.totalResults) {
    listings = pageInfo.totalResults;
    pages = Math.max(pages, Math.ceil(listings / perPage));
  }
  const limited = pages > maxPages;
  if (limited) {
    pages = maxPages;
    listings = Math.min(listings, maxPages * perPage);
  }
  return { pages, listings, limited, exact: !!pageInfo.totalResults };
}

const avg = ([a, b]) => (a + b) / 2;

/**
 * Typical duration from the average delay, load time and break length, shown as a
 * range around it (a bit more room upwards for security checks and slow pages).
 * @returns {[number, number]} low/high estimate in seconds
 */
function estimateSeconds(mode, pages, listings, delayMs) {
  const delay = avg([delayMs / 1000, (delayMs / 1000) * PACING.delaySpread]);
  const detailLoad = avg(mode === 'full' ? LOAD_SEC.phone : LOAD_SEC.page);
  const detailRequests = mode === 'quick' ? 0 : listings;
  const breaks = Math.floor((pages + detailRequests) / PACING.breakEvery);
  const typical =
    pages * (delay + avg(LOAD_SEC.page)) + detailRequests * (delay + detailLoad) + breaks * avg(PACING.breakSec);
  return [typical * 0.85, typical * 1.2];
}

function fmtMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Rounds nicely: 1-minute steps below 20 min, 5-minute steps above. */
function roundMinutes(sec, up) {
  const min = sec / 60;
  const step = min < 20 ? 1 : 5;
  return Math.max(1, (up ? Math.ceil(min / step) : Math.floor(min / step)) * step);
}

function fmtRange([lo, hi]) {
  if (hi < 60) return '< 1 min';
  const a = roundMinutes(lo, false);
  const b = roundMinutes(hi, true);
  if (a >= b) return `≈ ${fmtMinutes(b)}`;
  if (a >= 60) return `≈ ${fmtMinutes(a)} – ${fmtMinutes(b)}`;
  return b < 60 ? `≈ ${a}–${b} min` : `≈ ${a} min – ${fmtMinutes(b)}`;
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min < 1 ? 'less than a minute' : `≈ ${fmtMinutes(min)}`;
}

const MODE_RANK = { quick: 0, detailed: 1, full: 2 };
const MODE_WORK = { detailed: 'details', full: 'details & phones' };

/** Mirrors needsDetailVisit() in src/content.js. */
function needsVisit(row, mode) {
  if (mode === 'quick') return false;
  return row.detailStatus !== 'ok' || (mode === 'full' && !row.phoneChecked);
}

/** "Continue where it stopped" and "Collect more for these properties" cards. */
function renderNextSteps(job, rows, visible) {
  const show = visible && job && rows.length;
  $('continueBox').hidden = true;
  $('enrichBox').hidden = true;
  if (!show) return;
  const { delayMs, maxPages } = readOptions();
  const perPage = pageInfo.cardCount || 20;

  // Continue: result pages not scanned yet + listings still missing this run's data.
  const pagesLeft = job.listDone ? 0 : Math.max(1, Math.min(job.lastPageSeen || 1, maxPages) - (job.nextPage || 1) + 1);
  const pending = rows.filter((r) => needsVisit(r, job.mode)).length;
  if (pagesLeft || pending) {
    const parts = [];
    if (pagesLeft) parts.push(`Result pages from page ${job.nextPage} (of ${job.lastPageSeen}+)`);
    if (pending) parts.push(`${pending} listing${pending === 1 ? '' : 's'} still need ${MODE_WORK[job.mode]}`);
    const listings = pending + (job.mode === 'quick' ? 0 : pagesLeft * perPage);
    const eta = fmtRange(estimateSeconds(job.mode, pagesLeft, listings, delayMs));
    $('continueText').textContent = `${parts.join(' · ')} · ${eta}${pagesLeft ? '+' : ''}`;
    $('continueBox').hidden = false;
  }

  // Enrich: data levels above what this run collects, for the rows we already have.
  const rank = MODE_RANK[job.mode] || 0;
  const forDetails = rank < 1 ? rows.filter((r) => needsVisit(r, 'detailed')).length : 0;
  const forPhones = rank < 2 ? rows.filter((r) => needsVisit(r, 'full')).length : 0;
  $('enrichDetails').hidden = !forDetails;
  $('enrichPhones').hidden = !forPhones;
  if (forDetails) $('enrichDetailsEta').textContent = fmtRange(estimateSeconds('detailed', 0, forDetails, delayMs));
  if (forPhones) $('enrichPhonesEta').textContent = fmtRange(estimateSeconds('full', 0, forPhones, delayMs));
  if (forDetails || forPhones) {
    $('enrichTitle').textContent = `Collect more for these ${rows.length.toLocaleString()} properties`;
    document.querySelector('.enrich-actions').classList.toggle('single', !(forDetails && forPhones));
    $('enrichBox').hidden = false;
  }
}

function renderEstimates() {
  if (pageState !== 'ready') return;
  const { maxPages, delayMs } = readOptions();
  const { pages, listings, limited, exact } = searchSize(maxPages);

  document.querySelectorAll('[data-eta]').forEach((el) => {
    el.textContent = fmtRange(estimateSeconds(el.dataset.eta, pages, listings, delayMs));
  });

  const pagesText = `${pages} page${pages === 1 ? '' : 's'}`;
  $('searchSize').innerHTML = exact
    ? `<strong>${listings.toLocaleString()}</strong> properties on <strong>${pagesText}</strong>`
    : `<strong>${pageInfo.cardCount}</strong> properties on this page · at least <strong>${pagesText}</strong> (~${listings.toLocaleString()} properties)`;

  $('estimateNote').textContent = limited
    ? `Limited to ${maxPages} pages (see Settings).`
    : exact
      ? 'Times include short breaks. New pages can still appear while scanning, so the time may grow a little.'
      : 'The site only shows nearby page numbers, so more pages may appear once the scan reaches them. Treat these times as a minimum.';
}

// ---------- page check ----------

function baseListUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('page');
    u.hash = '';
    return u.href;
  } catch (_) {
    return '';
  }
}

/** Makes sure the content script is present (e.g. the tab was open before the extension was installed). */
async function pingContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (res && res.ok) return res;
  } catch (_) {}
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  return chrome.tabs.sendMessage(tabId, { type: 'ping' });
}

async function checkPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  const url = (tab && tab.url) || '';
  if (!SITE_RE.test(url)) return (pageState = 'invalid');
  if (!LIST_RE.test(url)) return (pageState = 'notList');
  try {
    const res = await pingContentScript(tab.id);
    pageInfo = {
      cardCount: (res && res.cardCount) || 0,
      lastPage: (res && res.lastPage) || 1,
      totalResults: (res && res.totalResults) || null,
    };
  } catch (_) {
    pageInfo = { cardCount: 0, lastPage: 1, totalResults: null };
  }
  return (pageState = pageInfo.cardCount > 0 ? 'ready' : 'empty');
}

// ---------- rendering ----------

function setBadge(text, kind) {
  const b = $('pageBadge');
  b.textContent = text;
  b.className = 'pill pill-' + kind;
}

function animateCounter(to) {
  const el = $('counter');
  const from = shownCount;
  if (to === from) {
    el.textContent = to.toLocaleString();
    return;
  }
  shownCount = to;
  el.classList.remove('bump');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('bump');
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 450);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function render() {
  const { status, rows, sourceUrl, humanCheck, job } = await chrome.storage.local.get(['status', 'rows', 'sourceUrl', 'humanCheck', 'job']);
  const s = status || {};
  const count = (rows || []).length;
  const running = isRunning(s);
  const sameSearch = activeTab && sourceUrl && baseListUrl(activeTab.url) === sourceUrl;

  const needsHuman = running && !!(humanCheck && humanCheck.active);
  $('viewHuman').hidden = !needsHuman;

  // Header badge
  if (needsHuman) setBadge('Action needed', 'warn');
  else if (running) setBadge('Scraping…', 'ok');
  else if (pageState === 'ready') setBadge('Valid page', 'ok');
  else if (pageState === 'checking') setBadge('Checking…', 'muted');
  else if (pageState === 'invalid') setBadge('Not ingatlan.com', 'warn');
  else setBadge('No results', 'warn');

  // 1. Not a usable page
  const invalid = !running && pageState !== 'ready' && pageState !== 'checking';
  $('viewInvalid').hidden = !invalid;
  if (invalid) {
    if (pageState === 'invalid') {
      $('invalidTitle').textContent = 'This is not ingatlan.com';
      $('invalidText').textContent = 'Open ingatlan.com, set your filters and list the properties. Then click the extension again.';
      $('openSite').hidden = false;
    } else {
      $('invalidTitle').textContent = 'No properties on this page';
      $('invalidText').textContent = 'Please set the filters and list the properties (search results page), then click the extension again.';
      $('openSite').hidden = true;
    }
  }

  // 2. Ready to start: choose a result type
  const hasResults = count > 0;
  $('viewReady').hidden = running || pageState !== 'ready' || (hasResults && sameSearch && !showStartAgain);
  $('start').disabled = false;
  renderEstimates();

  // 3. Progress / result counter
  const showProgress = running || (hasResults && $('viewReady').hidden);
  $('viewProgress').hidden = !showProgress;
  $('viewProgress').classList.toggle('done', !running);
  $('stop').hidden = !running;
  if (showProgress) {
    animateCounter(running ? s.found || count : count);
    let text = s.message || (running ? 'Working…' : 'Ready to download.');
    if (needsHuman) text = 'Paused — waiting for the security check…';
    else if (running && s.phase === 'details' && s.etaMs) text += ` · ${fmtDuration(s.etaMs)} left`;
    $('progressText').textContent = text;
    const bar = $('viewProgress').querySelector('.bar');
    const determinate = !running || (s.phase === 'details' && s.total);
    bar.classList.toggle('indeterminate', !determinate);
    $('barFill').style.width = running ? (determinate ? (100 * s.current) / s.total : 0) + '%' : '100%';
  }

  // 4. Download
  $('viewDone').hidden = running || !hasResults;
  const aboutThisSearch = sameSearch || pageState !== 'ready';
  $('downloadLabel').textContent = aboutThisSearch ? `Download Excel (${count})` : `Download previous results (${count})`;
  renderNextSteps(job, rows || [], !running && aboutThisSearch);
  $('again').hidden = !(pageState === 'ready' && sameSearch && !showStartAgain);
}

// ---------- actions ----------

async function init() {
  renderOptions(await getOptions());
  await render();
  await checkPage();
  await render();

  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', saveOptions));
  ['maxPages', 'delayMs'].forEach((id) =>
    $(id).addEventListener('input', () => {
      renderEstimates();
      saveOptions();
    })
  );

  $('focusWorker').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'focusWorker' }));
  $('openSite').addEventListener('click', () => chrome.tabs.create({ url: 'https://ingatlan.com/' }));

  $('start').addEventListener('click', async () => {
    if (!activeTab || pageState !== 'ready') return;
    $('start').disabled = true;
    showStartAgain = false;
    shownCount = 0;
    await saveOptions();
    await pingContentScript(activeTab.id);
    await chrome.tabs.sendMessage(activeTab.id, { type: 'start' });
  });

  $('stop').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: ['https://ingatlan.com/lista/*', 'https://www.ingatlan.com/lista/*'] });
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'stop' }).catch(() => {})));
  });

  $('download').addEventListener('click', async () => {
    const { rows, sourceUrl } = await chrome.storage.local.get(['rows', 'sourceUrl']);
    if (rows && rows.length) window.IngatlanExport.downloadExcel(rows, sourceUrl || '');
  });

  // Continue / enrich run in the search's tab; the background opens it if needed,
  // because the popup may close while a tab is being opened.
  const startFromBackground = (kind, mode) => {
    shownCount = 0;
    chrome.runtime.sendMessage({ type: 'startRun', kind, mode });
  };
  $('continue').addEventListener('click', () => startFromBackground('continue'));
  $('enrichDetails').addEventListener('click', () => startFromBackground('enrich', 'detailed'));
  $('enrichPhones').addEventListener('click', () => startFromBackground('enrich', 'full'));

  $('again').addEventListener('click', () => {
    showStartAgain = true;
    render();
  });

  $('clear').addEventListener('click', async () => {
    const { status } = await chrome.storage.local.get('status');
    if (isRunning(status)) return;
    await chrome.storage.local.remove(['rows', 'status', 'sourceUrl', 'job']);
    chrome.action.setBadgeText({ text: '' });
    shownCount = 0;
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.status || changes.rows || changes.humanCheck || changes.job) render();
  });
}

init();
