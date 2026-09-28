/*
 * Background service worker.
 *
 * The scraping loop itself runs in the content script of the results tab (it
 * lives as long as that tab, and its fetches carry the user's cookies). This
 * worker only does what a content script cannot: drive a separate "worker" tab
 * that loads listing pages like a real visit. That is used
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

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/**
 * Waits until the worker tab shows a real page instead of a Cloudflare check.
 * Automatic checks pass by themselves; for "confirm you are human" the tab is
 * brought to the front so the user can complete it. We never interact with it.
 * @returns {Promise<{challenged: boolean, needsHuman?: boolean}>}
 */
async function waitForChallenge(tabId, resume) {
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
  return { challenged: true };
}

/**
 * Injected into the worker tab. Must be self-contained (no closures).
 * Optionally clicks the "show phone number" button(s), then returns the page HTML
 * and any phone numbers visible near those buttons.
 */
async function extractInPage(revealPhone) {
  const PHONE_RE = /(?:\+\s?36|06)[\s\-/()]*\d{1,2}[\s\-/()]*\d{3}[\s\-]*\d{3,4}/g;
  const BUTTON_RE = /telefonsz[aá]m|telefon|phone/i;
  const inChrome = (el) => !!el.closest('header, footer, nav');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const buttons = [...document.querySelectorAll('button, a[role="button"], a[href="#"], [data-action*="phone" i]')].filter(
    (b) => !inChrome(b) && !(b.getAttribute('href') || '').startsWith('tel:') && BUTTON_RE.test(b.textContent + ' ' + (b.getAttribute('aria-label') || ''))
  );

  const collect = () => {
    const found = [];
    document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
      if (!inChrome(a)) found.push(decodeURIComponent(a.getAttribute('href').slice(4)).trim());
    });
    const zones = buttons.map((b) => b.parentElement && b.parentElement.parentElement).filter(Boolean);
    document.querySelectorAll('.modal.show, [role="dialog"]').forEach((m) => zones.push(m));
    zones.forEach((z) => (z.textContent.match(PHONE_RE) || []).forEach((p) => found.push(p.trim())));
    return [...new Set(found)];
  };

  let clicked = 0;
  if (revealPhone && buttons.length) {
    const before = collect().length;
    for (const b of buttons.slice(0, 2)) {
      b.click();
      clicked++;
    }
    for (let waited = 0; waited < 8000 && collect().length <= before; waited += 300) await sleep(300);
    await sleep(300);
  }

  return { html: document.documentElement.outerHTML, phones: collect(), clicked };
}

async function renderInWorker(url, revealPhone, resume) {
  const tabId = await getWorkerTabId();
  if (!resume) await navigateAndWait(tabId, url);
  const { challenged, needsHuman } = await waitForChallenge(tabId, resume);
  if (needsHuman) return { needsHuman: true, challenged: true };
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractInPage,
    args: [!!revealPhone],
  });
  return { ...result, challenged };
}

const LIST_TAB_URLS = ['https://ingatlan.com/lista/*', 'https://www.ingatlan.com/lista/*'];
const CONTENT_FILES = ['src/parser.js', 'src/content.js'];

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
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'start', kind, mode });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    setHumanCheck(false).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'focusWorker') {
    chrome.storage.session.get('workerTabId').then(({ workerTabId }) => {
      if (workerTabId != null) focusTab(workerTabId).catch(() => {});
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'renderPage') {
    renderInWorker(msg.url, msg.revealPhone, msg.resume)
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
    const { workerTabId } = await chrome.storage.session.get('workerTabId');
    if (workerTabId != null) await focusTab(workerTabId).catch(() => {});
  } else if (id === NOTE_FINISHED) {
    await focusScrapeTab();
    // Opening the popup programmatically needs Chrome 127+; otherwise the user clicks the icon.
    try {
      await chrome.action.openPopup();
    } catch (_) {}
  }
});
