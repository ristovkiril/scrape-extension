/*
 * Background service worker.
 *
 * The scraping itself runs in content scripts (see src/content.js). In a live run
 * the tab moves from page to page by itself; this worker only tells a page which
 * tab it is in and ends the run if the tab is closed or Stop is pressed.
 * In a background run, this worker does what a content script cannot: drive a
 * separate "worker" tab that loads listing pages like a real visit. That is used
 *   - when a plain fetch() is blocked (Cloudflare challenge / 403), and
 *   - to click "show phone number" buttons, which needs the page's own JS.
 */
'use strict';

const NAV_TIMEOUT_MS = 45000;
// Cloudflare's automatic JS check usually passes within a few seconds.
const CHALLENGE_AUTO_WAIT_MS = 10000;
// One message may not keep the service worker busy for more than ~5 minutes, so a
// human check is awaited in chunks; the content script asks again with resume=true.
const HUMAN_WAIT_CHUNK_MS = 4 * 60 * 1000;

let aborted = false;

async function getWorkerTabId() {
  const { workerTabId } = await chrome.storage.session.get('workerTabId');
  if (workerTabId != null) {
    try {
      await chrome.tabs.get(workerTabId);
      return workerTabId;
    } catch (_) {
      // Tab was closed by the user; create a new one.
    }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  await chrome.storage.session.set({ workerTabId: tab.id });
  return tab.id;
}

async function closeWorkerTab() {
  const { workerTabId } = await chrome.storage.session.get('workerTabId');
  if (workerTabId != null) {
    try {
      await chrome.tabs.remove(workerTabId);
    } catch (_) {}
  }
  await chrome.storage.session.remove('workerTabId');
}

function navigateAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out loading ' + url));
    }, NAV_TIMEOUT_MS);

    function listener(id, info, tab) {
      if (id === tabId && info.status === 'complete' && tab.url && tab.url.startsWith('http')) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((err) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(err);
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function isChallenge(tabId) {
  // Throws if the user closed the tab, which ends the wait with an error for this listing.
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw new Error('The security-check tab was closed');
  });
  try {
    if (tab.status !== 'complete') return true; // still redirecting; keep waiting
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        /Just a moment|Egy pillanat|Attention Required/i.test(document.title) ||
        !!document.querySelector('#challenge-form, [name="cf-turnstile-response"]'),
    });
    return result;
  } catch (_) {
    return true; // frame replaced mid-navigation
  }
}

async function setHumanCheck(active, tabId) {
  await chrome.storage.local.set({ humanCheck: { active, tabId: tabId ?? null, since: active ? Date.now() : null } });
  if (active) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#e8710a' });
  }
}

/** The tab showing the current security check: the worker tab, or the results tab when it is shown there. */
async function checkTabId() {
  const { humanCheck } = await chrome.storage.local.get('humanCheck');
  if (humanCheck && humanCheck.active && humanCheck.tabId != null) return humanCheck.tabId;
  const { workerTabId } = await chrome.storage.session.get('workerTabId');
  return workerTabId ?? null;
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/**
 * Waits until the worker tab shows a real page instead of a Cloudflare check.
 * Automatic checks pass by themselves; for "confirm you are human" the tab is
 * brought to the front so the user can complete it. We never interact with it.
 * Once it is done, the user is taken back to `returnTabId` (the results tab, where
 * the live view only animates while it is visible).
 * @returns {Promise<{challenged: boolean, needsHuman?: boolean}>}
 */
async function waitForChallenge(tabId, resume, returnTabId) {
  let challenged = !!resume;
  if (!resume) {
    const autoUntil = Date.now() + CHALLENGE_AUTO_WAIT_MS;
    while (await isChallenge(tabId)) {
      challenged = true;
      if (Date.now() > autoUntil) break;
      await delay(1000);
    }
    if (!(await isChallenge(tabId))) return { challenged };

    // Still blocked: hand over to the user.
    await setHumanCheck(true, tabId);
    await focusTab(tabId).catch(() => {});
  }

  const until = Date.now() + HUMAN_WAIT_CHUNK_MS;
  while (await isChallenge(tabId)) {
    if (aborted) throw new Error('Stopped');
    if (Date.now() > until) return { challenged: true, needsHuman: true };
    await delay(1500);
  }
  await setHumanCheck(false);
  await returnFromCheck(tabId, returnTabId);
  return { challenged: true };
}

/** Back to the results tab, unless the user has already moved on from the check tab. */
async function returnFromCheck(checkTabId, returnTabId) {
  if (returnTabId == null || returnTabId === checkTabId) return;
  try {
    const checkTab = await chrome.tabs.get(checkTabId);
    if (checkTab.active) await focusTab(returnTabId);
  } catch (_) {}
}

/** Injected into the worker tab: returns the rendered page HTML. */
function extractInPage() {
  return { html: document.documentElement.outerHTML };
}

async function renderInWorker(url, resume, returnTabId) {
  const tabId = await getWorkerTabId();
  if (!resume) await navigateAndWait(tabId, url);
  const { challenged, needsHuman } = await waitForChallenge(tabId, resume, returnTabId);
  if (needsHuman) return { needsHuman: true, challenged: true };
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractInPage });
  return { ...result, challenged };
}

const LIST_TAB_URLS = ['https://ingatlan.com/lista/*', 'https://www.ingatlan.com/lista/*'];
const CONTENT_FILES = ['src/parser.js', 'src/stage.js', 'src/content.js'];

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

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out opening the search page'));
    }, NAV_TIMEOUT_MS);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Continue / enrich a saved run. The scraping loop lives in a content script on an
 * ingatlan.com/lista/ page, so use the tab showing that search, any results tab,
 * or open the search in a new background tab.
 */
async function startSavedRun(kind, mode) {
  const { sourceUrl } = await chrome.storage.local.get('sourceUrl');
  if (!sourceUrl) throw new Error('Nothing to continue');
  const tabs = await chrome.tabs.query({ url: LIST_TAB_URLS });
  let tab = tabs.find((t) => baseListUrl(t.url) === sourceUrl) || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: sourceUrl, active: false });
    await waitForTabComplete(tab.id);
  }
  await startInTab(tab.id, kind, mode);
}

async function startInTab(tabId, kind, mode) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  }
  await chrome.tabs.sendMessage(tabId, { type: 'start', kind, mode });
}

// ---------- live runs ----------
//
// A live run moves its own tab from page to page (see src/content.js); its position
// is kept in storage.local "tabRun". Stopping it from the popup, or closing its tab,
// has to work even while the tab is between two pages, so it is handled here too.

async function stopTabRun(message) {
  const { tabRun, status } = await chrome.storage.local.get(['tabRun', 'status']);
  if (!tabRun) return;
  await chrome.storage.local.remove('tabRun');
  if (status && status.running && status.runId === tabRun.runId) {
    await chrome.storage.local.set({ status: { ...status, running: false, phase: 'stopped', message, updatedAt: Date.now() } });
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabRun } = await chrome.storage.local.get('tabRun');
  if (tabRun && tabRun.tabId === tabId) {
    await setHumanCheck(false);
    await stopTabRun('Interrupted — the tab was closed. Download what you have, or continue.');
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'startRun') {
    startSavedRun(msg.kind, msg.mode)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }
  if (msg.type === 'runStarted') {
    aborted = false;
    setHumanCheck(false).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'abortWorker') {
    aborted = true;
    stopTabRun('Stopped — download what you have, or continue.')
      .then(() => setHumanCheck(false))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'focusWorker') {
    checkTabId().then((tabId) => {
      if (tabId != null) focusTab(tabId).catch(() => {});
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'whoami') {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return false;
  }
  if (msg.type === 'humanCheck') {
    // A live run's tab is showing a "confirm you're human" check (or it passed).
    setHumanCheck(!!msg.active, sender.tab && sender.tab.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'renderPage') {
    renderInWorker(msg.url, msg.resume, sender.tab && sender.tab.id)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // async response
  }
  if (msg.type === 'closeWorker') {
    closeWorkerTab().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ---------- badge & notifications ----------

const NOTE_HUMAN = 'human-check';
const NOTE_FINISHED = 'finished';

function notify(id, title, message, sticky) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
    requireInteraction: !!sticky, // stays on screen until the user acts
  });
}

function showCountBadge(s) {
  const found = (s && s.found) || 0;
  const text = found ? (found > 999 ? Math.floor(found / 1000) + 'k' : String(found)) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: s && s.running ? '#7c3aed' : '#107c41' });
}

async function focusScrapeTab() {
  const tabs = await chrome.tabs.query({ url: ['https://ingatlan.com/lista/*', 'https://www.ingatlan.com/lista/*'] });
  if (tabs.length) await focusTab(tabs[0].id).catch(() => {});
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;

  // Human check started / finished.
  if (changes.humanCheck) {
    const was = changes.humanCheck.oldValue && changes.humanCheck.oldValue.active;
    const is = changes.humanCheck.newValue && changes.humanCheck.newValue.active;
    if (is && !was) {
      notify(NOTE_HUMAN, 'ingatlan.com needs a human check', 'Scraping is paused. Click here, tick the box, and it continues automatically.', true);
    } else if (!is && was) {
      chrome.notifications.clear(NOTE_HUMAN);
      const { status } = await chrome.storage.local.get('status');
      showCountBadge(status);
    }
  }

  if (changes.status) {
    const before = changes.status.oldValue || {};
    const s = changes.status.newValue || {};
    const { humanCheck } = await chrome.storage.local.get('humanCheck');
    if (!(humanCheck && humanCheck.active)) showCountBadge(s); // otherwise keep the "!" badge

    // A run just ended (a Stop pressed by the user needs no notification).
    if (before.running && !s.running) {
      chrome.notifications.clear(NOTE_HUMAN);
      if (s.phase === 'done') {
        notify(NOTE_FINISHED, 'Scraping finished', `${s.found || 0} properties are ready. Click to download the Excel file.`, true);
      } else if (s.phase === 'error') {
        notify(NOTE_FINISHED, 'Scraping stopped with an error', `${s.found || 0} properties were saved. Click to download them or continue.`, true);
      }
    }
  }
});

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  if (id === NOTE_HUMAN) {
    const tabId = await checkTabId();
    if (tabId != null) await focusTab(tabId).catch(() => {});
  } else if (id === NOTE_FINISHED) {
    await focusScrapeTab();
    // Opening the popup programmatically needs Chrome 127+; otherwise the user clicks the icon.
    try {
      await chrome.action.openPopup();
    } catch (_) {}
  }
});
