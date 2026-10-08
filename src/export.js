/*
 * Builds the .xlsx file from scraped rows using SheetJS (lib/xlsx.full.min.js).
 * Shared by the in-page panel (content script) and the popup.
 */
(function (global) {
  'use strict';

  // [header, getter, column width]
  const COLUMNS = [
    ['Listing ID', (r) => r.id, 11],
    ['Link', (r) => r.url, 30],
    ['City', (r) => r.city, 12],
    ['District', (r) => r.district, 9],
    ['Address', (r) => r.address, 40],
    ['Price (Ft)', (r) => r.price, 14],
    ['Price text', (r) => r.priceText, 13],
    ['Price / m2 (Ft)', (r) => r.pricePerM2, 14],
    ['Area (m2)', (r) => r.area, 10],
    ['Rooms', (r) => r.rooms, 12],
    ['Floor', (r) => r.floor, 12],
    ['Building levels', (r) => r.buildingLevels, 12],
    ['Advertiser type', (r) => r.advertiserType, 18],
    ['Advertiser name', (r) => r.advertiserName, 28],
    ['Phone', (r) => (r.phones || []).join(', '), 20],
    ['Labels', (r) => r.labels, 18],
    ['Photos', (r) => r.photoCount, 8],
    ['Title', (r) => r.title, 40],
    ['Description', (r) => r.description, 60],
    ['Results page', (r) => r.page, 8],
    ['Detail status', (r) => r.detailStatus, 14],
  ];

  const NUMERIC_FORMAT = {
    'Price (Ft)': '#,##0',
    'Price / m2 (Ft)': '#,##0',
  };

  function buildWorkbook(rows) {
    const XLSX = global.XLSX;

    // Every extra key/value found on list cards or detail pages becomes its own column.
    const extraKeys = [];
    const seen = new Set();
    rows.forEach((r) => {
      Object.keys(r.listStats || {}).concat(Object.keys(r.fields || {})).forEach((k) => {
        if (!seen.has(k)) {
          seen.add(k);
          extraKeys.push(k);
        }
      });
    });

    const header = COLUMNS.map((c) => c[0]).concat(extraKeys);
    const data = rows.map((r) => {
      const base = COLUMNS.map(([, get]) => {
        const v = get(r);
        return v === undefined || v === null ? '' : v;
      });
      const extra = extraKeys.map((k) => (r.fields && r.fields[k]) || (r.listStats && r.listStats[k]) || '');
      return base.concat(extra);
    });

    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws['!cols'] = COLUMNS.map((c) => ({ wch: c[2] })).concat(extraKeys.map(() => ({ wch: 16 })));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length, c: header.length - 1 } }) };

    // Links stay plain text: a clickable hyperlink makes Excel fetch the URL itself first,
    // ingatlan.com answers that with 403, and Excel then shows a bogus "malformed URI" error.
    for (let i = 0; i < data.length; i++) {
      header.forEach((h, c) => {
        const fmt = NUMERIC_FORMAT[h];
        const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c })];
        if (fmt && cell && cell.t === 'n') cell.z = fmt;
      });
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Listings');
    return wb;
  }

  function downloadExcel(rows, sourceUrl) {
    const XLSX = global.XLSX;
    const wb = buildWorkbook(rows);
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    let slug = 'ingatlan';
    try {
      const m = new URL(sourceUrl).pathname.match(/\/lista\/([^/?#]+)/);
      if (m) slug = m[1].replace(/[^\w-]+/g, '_').slice(0, 60);
    } catch (_) {}
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ingatlan_${slug}_${stamp}.xlsx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  global.IngatlanExport = { buildWorkbook, downloadExcel };
})(typeof window !== 'undefined' ? window : self);
