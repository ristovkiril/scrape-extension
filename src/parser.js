/*
 * Pure parsing helpers for ingatlan.com pages.
 * Everything site-specific (selectors, label texts) lives in this file, so if
 * ingatlan.com changes its markup, this is the only place that needs updating.
 *
 * All functions work on a Document (either the live page or one produced by
 * DOMParser from fetched HTML), so they never depend on page scripts running.
 */
(function (global) {
  'use strict';

  const ORIGIN = 'https://ingatlan.com';

  // Label matchers — Hungarian (what the server sends) + English (Google Translate).
  const LABELS = {
    area: /alapter|floor area|^area|^size/i,
    rooms: /szob|room/i,
    plot: /telekter|plot/i,
    floor: /^emelet$|^floor$|^level$/i,
    buildingLevels: /épület szintjei|building levels|floors in building/i,
  };

  const PRIVATE_RE = /magánszemély|magánhirdető|private (person|individual|seller)/i;
  const AGENCY_LINK_SELECTOR = 'a[href*="iroda.ingatlan.com"]';
  const PHONE_RE = /(?:\+\s?36|06)[\s\-/()]*\d{1,2}[\s\-/()]*\d{3}[\s\-]*\d{3,4}/g;

  // ---------- small utils ----------

  function clean(text) {
    return (text || '').replace(/[\s\u00a0\u202f]+/g, ' ').trim();
  }

  function textOf(el) {
    return el ? clean(el.textContent) : '';
  }

  /** Parses "77,70", "1 726 666", "1,726,666", "1.726.666" → Number. */
  function toNumber(str) {
    if (str == null) return null;
    const m = String(str).match(/\d[\d\s\u00a0\u202f.,]*/);
    if (!m) return null;
    let s = m[0].replace(/[\s\u00a0\u202f]/g, '').replace(/[.,]$/, '');
    const hasDot = s.includes('.');
    const hasComma = s.includes(',');
    if (hasDot && hasComma) {
      // Whichever comes last is the decimal separator.
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (hasComma) {
      s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    } else if (hasDot) {
      if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /** "77,70 M Ft" → 77700000, "1,2 Mrd Ft" → 1200000000, "250 ezer Ft" → 250000. */
  function parsePrice(text) {
    const t = clean(text);
    if (!t) return null;
    const n = toNumber(t);
    if (n == null) return null;
    if (/\bmrd\b|milliárd|billion/i.test(t)) return Math.round(n * 1e9);
    if (/\bM\b|millió|million/i.test(t)) return Math.round(n * 1e6);
    if (/\bezer\b|\be\s*Ft|thousand/i.test(t)) return Math.round(n * 1e3);
    return n;
  }

  /** "1 726 666 Ft/m2" → 1726666 (strips the unit so the "2" in m2 is ignored). */
  function parsePricePerM2(text) {
    const t = clean(text).replace(/\/\s*m\s*2?/i, '').replace(/m2/i, '');
    return toNumber(t);
  }

  /** "45 m2" → 45 */
  function parseArea(text) {
    return toNumber(clean(text).replace(/m\s*2\s*$/i, ''));
  }

  /** "Budapest XI. kerület, Sáfrány utca 46." → { city, district, street } */
  function parseAddress(address) {
    const a = clean(address);
    const res = { city: '', district: '', street: '' };
    if (!a) return res;
    // Case-sensitive on purpose: "Budapest Villányi út" must not read as district "VI".
    const bp = a.match(/^Budapest\s*,?\s+([IVXLC]+)\.\s*(?:kerület|ker\.|district)?\s*,?\s*(.*)$/);
    if (bp) {
      res.city = 'Budapest';
      res.district = bp[1] + '.';
      res.street = clean(bp[2]);
      return res;
    }
    if (/^Budapest(?![a-zá-ű])/.test(a)) {
      res.city = 'Budapest';
      res.street = clean(a.replace(/^Budapest\s*,?/, ''));
      return res;
    }
    const parts = a.split(',').map(clean).filter(Boolean);
    res.city = parts[0] || '';
    res.street = parts.slice(1).join(', ');
    return res;
  }

  function normalizePhone(p) {
    const digits = p.replace(/[^\d+]/g, '');
    if (digits.length < 8) return null;
    return clean(p);
  }

  function uniq(arr) {
    return [...new Set(arr.filter(Boolean))];
  }

  function isInChrome(el) {
    return !!el.closest('header, footer, nav, [role="navigation"], [role="contentinfo"]');
  }

  /** Returns the JSON stored in the Stimulus "...-listing-value" attribute of a card. */
  function readListingJson(card) {
    for (const attr of card.attributes) {
      if (/results-listing-listing-value$/.test(attr.name)) {
        try {
          return JSON.parse(attr.value);
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }

  /** Label/value pairs rendered as <div class="d-flex flex-column"><span>label</span><span>value</span></div>. */
  function readStatPairs(root) {
    const out = [];
    root.querySelectorAll('.d-flex.flex-column').forEach((box) => {
      const spans = [...box.children].filter((c) => c.tagName === 'SPAN');
      if (spans.length !== 2 || box.children.length !== 2) return;
      const label = textOf(spans[0]);
      const value = textOf(spans[1]);
      if (label && value && label.length <= 40 && value.length <= 80) out.push([label, value]);
    });
    return out;
  }

  // ---------- list page ----------

  /**
   * Parses one results page.
   * @returns {{ listings: object[], hasNextPage: boolean }}
   */
  function parseListPage(doc, pageNumber) {
    const cards = doc.querySelectorAll('a.listing-card[data-listing-id], [data-testid="listing-card"]');
    const listings = [];
    const seen = new Set();

    cards.forEach((card) => {
      const href = card.getAttribute('href') || '';
      const id = card.getAttribute('data-listing-id') || (href.match(/\/(\d{5,})/) || [])[1];
      if (!id || seen.has(id)) return;
      seen.add(id);

      const json = readListingJson(card) || {};
      const content = card.querySelector('.listing-card-content') || card;

      const priceEl =
        content.querySelector('span.fw-bold.fs-5') ||
        [...content.querySelectorAll('span')].find((s) => /\d.*(Ft|HUF|€)/.test(textOf(s)) && !/\/\s*m/.test(textOf(s)));
      const perM2El = content.querySelector('.listing-card-area-prices');
      const addressEl =
        content.querySelector('span.d-block.fs-7') ||
        [...content.querySelectorAll('span')].find((s) => /kerület|district|utca|út\b/i.test(textOf(s)));

      const listing = {
        id,
        url: new URL(href || '/' + id, ORIGIN).href,
        page: pageNumber,
        priceText: textOf(priceEl),
        price: parsePrice(textOf(priceEl)),
        pricePerM2: parsePricePerM2(textOf(perM2El)),
        address: textOf(addressEl),
        area: null,
        rooms: '',
        labels: uniq([...card.querySelectorAll('[data-testid="listing-label"]')].map(textOf)).join(', '),
        photoCount: toNumber(textOf(card.querySelector('.gallery-additional-photos-label'))),
        imageUrl: (card.querySelector('img.listing-card-image') || {}).src || '',
        sellerWebsite: (json.seller && json.seller.websiteUrl) || '',
        clusterCount: json.clusterCount ?? null,
        listStats: {},
      };

      for (const [label, value] of readStatPairs(content)) {
        if (LABELS.area.test(label)) listing.area = parseArea(value);
        else if (LABELS.rooms.test(label)) listing.rooms = value;
        else listing.listStats[label] = value;
      }

      Object.assign(listing, parseAddress(listing.address));
      listings.push(listing);
    });

    const { lastPage, pagesExact, totalResults } = readPagination(doc);
    const nextHref = `page=${pageNumber + 1}`;
    const hasNextPage = !![...doc.querySelectorAll('a[href]')].find((a) => {
      const h = a.getAttribute('href');
      return h.includes('/lista/') && new RegExp(`[?&]${nextHref}(?:&|$)`).test(h);
    });

    return { listings, hasNextPage, lastPage: Math.max(lastPage, pageNumber), pagesExact, totalResults };
  }

  const RESULT_COUNT_RE = /(\d{1,3}(?:[\s\u00a0\u202f.]\d{3})+|\d+)\s*(?:db\s*)?(?:találat|hirdetés|results?\b|listings?\b|properties\b)/i;

  const PAGE_COUNTER_RE = /^(\d+)\s*\/\s*(\d+)$/;

  /**
   * Total number of pages from the "1 / 9" counter next to the next-page button
   * (inside data-controller="listings-page--extended-list"), or null if there is none.
   */
  function readPageCount(doc) {
    const scopes = [...doc.querySelectorAll('[data-controller~="listings-page--extended-list"]')];
    const fallback = !scopes.length;
    if (fallback) scopes.push(doc.body || doc.documentElement);
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll('div, p, span')) {
        if (isInChrome(el) || el.closest('.listing-card')) continue;
        const m = textOf(el).match(PAGE_COUNTER_RE);
        if (!m || parseInt(m[1], 10) > parseInt(m[2], 10)) continue;
        // Outside the known container, only trust a counter that sits next to a page link.
        const row = el.parentElement && el.parentElement.parentElement;
        if (fallback && !(row && row.querySelector('a[href*="/lista/"][href*="page="]'))) continue;
        return parseInt(m[2], 10);
      }
    }
    return null;
  }

  /**
   * Pagination info of a results page.
   * lastPage: from the "1 / 9" counter when there is one (pagesExact = true). Otherwise
   * the highest page number linked; the pagination may only show nearby pages
   * ("1 2 3 … 21"), so that is a minimum that can grow while moving through pages.
   * totalResults: the "412 találat" style counter, when the page shows one.
   */
  function readPagination(doc) {
    let lastPage = 1;
    doc.querySelectorAll('a[href*="/lista/"]').forEach((a) => {
      const m = a.getAttribute('href').match(/[?&]page=(\d+)/);
      if (m) lastPage = Math.max(lastPage, parseInt(m[1], 10));
    });
    const pageCount = readPageCount(doc);
    const pagesExact = pageCount != null;
    if (pagesExact) lastPage = pageCount;

    let totalResults = null;
    const candidates = [...doc.querySelectorAll('h1, h2, h3, [class*="count" i], [class*="result" i], [data-testid*="count" i]')];
    for (const el of candidates) {
      if (isInChrome(el) || el.closest('.listing-card')) continue;
      const m = textOf(el).match(RESULT_COUNT_RE);
      if (m) {
        totalResults = toNumber(m[1].replace(/[.\s\u00a0\u202f]/g, ''));
        break;
      }
    }
    return { lastPage, pagesExact, totalResults };
  }

  // ---------- detail page ----------

  /** Collects every label → value pair we can find on a listing detail page. */
  function readDetailFields(doc) {
    const fields = {};
    const put = (k, v) => {
      k = clean(k).replace(/:$/, '');
      v = clean(v);
      if (!k || !v || k.length > 60 || v.length > 200 || k === v) return;
      if (!(k in fields)) fields[k] = v;
    };

    doc.querySelectorAll('table tr').forEach((tr) => {
      if (isInChrome(tr)) return;
      const cells = tr.querySelectorAll('th, td');
      if (cells.length === 2) put(textOf(cells[0]), textOf(cells[1]));
    });

    doc.querySelectorAll('dl').forEach((dl) => {
      if (isInChrome(dl)) return;
      const dts = dl.querySelectorAll('dt');
      dts.forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') put(textOf(dt), textOf(dd));
      });
    });

    const main = doc.querySelector('main') || doc.body;
    if (main) readStatPairs(main).forEach(([k, v]) => put(k, v));

    return fields;
  }

  function findField(fields, re) {
    const key = Object.keys(fields).find((k) => re.test(k));
    return key ? fields[key] : '';
  }

  function extractPhones(doc) {
    const phones = [];
    // The detail page ships the number in a hidden block (<span data-number="+36 30 123 4567">),
    // so it can be read without clicking the "show phone number" button.
    doc.querySelectorAll('[data-number], [data-phone], [data-phone-number], [data-phonenumber]').forEach((el) => {
      if (isInChrome(el)) return;
      const v = ['data-number', 'data-phone', 'data-phone-number', 'data-phonenumber'].map((a) => el.getAttribute(a)).find(Boolean);
      if (v && /\d{6,}/.test(v.replace(/\D/g, ''))) phones.push(normalizePhone(v));
    });
    doc.querySelectorAll('a[href^="tel:"]').forEach((a) => {
      if (isInChrome(a)) return;
      const raw = a.getAttribute('href').slice(4);
      // Unfilled templates like "tel:%number%" aren't valid URI escapes; decodeURIComponent would throw.
      try {
        phones.push(normalizePhone(decodeURIComponent(raw)));
      } catch (_) {}
    });
    // The same number often appears twice ("tel:+36301234567" and "+36 30 123 4567"): keep the first.
    const byDigits = new Map();
    phones.filter(Boolean).forEach((p) => {
      const key = p.replace(/\D/g, '').replace(/^06/, '36');
      if (!byDigits.has(key)) byDigits.set(key, p);
    });
    return [...byDigits.values()];
  }

  /**
   * Parses a listing detail page (https://ingatlan.com/<id>).
   */
  function parseDetailPage(doc) {
    const fields = readDetailFields(doc);
    const bodyText = textOf(doc.body);

    const agencyLink = [...doc.querySelectorAll(AGENCY_LINK_SELECTOR)].find((a) => !isInChrome(a));
    let advertiserType = '';
    let advertiserName = '';
    if (agencyLink) {
      advertiserType = 'Real estate agency';
      const img = agencyLink.querySelector('img[alt]');
      advertiserName = textOf(agencyLink) || (img ? clean(img.alt) : '');
    } else if (PRIVATE_RE.test(bodyText)) {
      advertiserType = 'Private person';
    }

    const meta = (name) => {
      const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      return el ? clean(el.getAttribute('content')) : '';
    };

    const descEl = doc.querySelector('#listing-description, [class*="listing-description"], [data-testid*="description"]');

    return {
      title: textOf(doc.querySelector('h1')) || meta('og:title'),
      floor: findField(fields, LABELS.floor),
      buildingLevels: findField(fields, LABELS.buildingLevels),
      advertiserType,
      advertiserName,
      agencyUrl: agencyLink ? agencyLink.href : '',
      phones: extractPhones(doc),
      description: (textOf(descEl) || meta('og:description') || meta('description')).slice(0, 5000),
      fields,
    };
  }

  // ---------- misc ----------

  function isChallengePage(html) {
    return /<title>\s*(Just a moment|Egy pillanat|Attention Required)/i.test(html) || /_cf_chl_opt|id="challenge-form"/i.test(html);
  }

  global.IngatlanParser = {
    parseListPage,
    readPagination,
    parseDetailPage,
    parseAddress,
    parsePrice,
    isChallengePage,
    PHONE_RE,
  };
})(typeof window !== 'undefined' ? window : self);
