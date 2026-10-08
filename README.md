# Ingatlan.com Listing Exporter (Chrome extension)

Exports the results of an ingatlan.com search (for example
`https://ingatlan.com/lista/elado+lakas+40-100-m2+2-6-szoba+20-80-mFt+xi-ker`) to an Excel file.

The user filters listings on ingatlan.com as usual, then clicks the extension icon:

1. The popup checks the current tab. On an ingatlan.com results page that has properties listed, it shows **Valid page** and a **Start Scraping** button.
2. If the tab is not ingatlan.com, or no properties are listed, it asks the user to set the filters and list the properties first.
3. **Start Scraping** reads every results page (`?page=1`, `?page=2`, …) until a page has no properties or there is no next page. Optionally it opens each listing (floor, advertiser, all details) and reveals phone numbers.
4. While it runs, the popup shows a live **N properties found** counter. The same number appears as a badge on the toolbar icon, so the popup can be closed. When it finishes, a green **Download Excel** button appears.

## What ends up in the Excel file

| Column | Source |
|---|---|
| Listing ID, Link | results card (`data-listing-id`) |
| City, District, Address | results card, e.g. `Budapest XI. kerület, Sáfrány utca 46.` → `Budapest` / `XI.` |
| Price (Ft), Price text, Price / m2 (Ft) | results card (`77,70 M Ft` → `77 700 000`) |
| Area (m2), Rooms | results card |
| Floor, Building levels | detail page (`Emelet`, `Épület szintjei`) |
| Advertiser type | `Real estate agency` if the listing links to an `iroda.ingatlan.com` office page; otherwise `Private person` when the detail page says *Magánszemély*, or `Private person (probable)` when details were not opened |
| Advertiser name | office name from the detail page |
| Phone | revealed phone number(s) |
| Labels, Photos, Title, Description | results card / detail page |
| Results page, Detail status | which results page the listing was on; `ok` / `skipped` / `error: …` |
| *…one extra column for each parameter on the detail page* | e.g. `Fűtés`, `Lift`, `Erkély`, `Építés éve`, `Állapot` |

The Link column is clickable, and the header row has filters turned on.

## Project layout

```
manifest.json         Chrome extension manifest (Manifest V3)
src/parser.js         All ingatlan.com-specific parsing (selectors, Hungarian labels)
src/content.js        Runs on ingatlan.com pages: the scraping (live: one step per page load; background: a fetch loop on the results page)
src/stage.js          The live view (spotlight, highlights, cursor, Extracted data panel, control bar)
src/background.js     Service worker: drives a background "worker" tab when needed; toolbar badge count
src/export.js         Builds the .xlsx with SheetJS
popup/                Toolbar popup: page check, Start Scraping, live counter, Download Excel
lib/xlsx.full.min.js  SheetJS 0.20.3 (bundled, since Manifest V3 forbids remote code)
icons/                Extension icons (16/48/128 px)
build.ps1             Creates dist/ingatlan-exporter-<version>.zip for the Web Store
```

There is no npm/webpack build step. The folder itself is the extension.

## How it works (and why)

- **Two ways to run** (*Settings → Show the scraping live in this tab*):
  - **Live (on by default):** the tab you started in opens every result page and listing itself, one after another, like a person browsing. Each page is animated while the extension reads it (see *Live view* below). The run's position is saved after every page, so the reloads don't lose anything. No other tab is opened.
  - **Background (off):** the tab stays on the results page, and the other pages are loaded with `fetch()` from inside it. Nothing moves on screen, and it's faster. If a fetch is blocked (Cloudflare challenge, 403), the page is opened in one background **worker tab**, which is reused for the whole run.
  Both send requests from inside your browser with your cookies, including Cloudflare's clearance cookie, so they behave like normal browsing. Requests from outside a browser, such as curl or Python, get a 403 from Cloudflare.
- **"Confirm you are human" checks:** Cloudflare's automatic check usually passes by itself within a few seconds. If it asks you to tick the box, scraping **pauses**. In a live run the check simply shows in the tab, with a toast in the bottom-right corner; in a background run the worker tab is brought to the front. The popup shows an orange *Please confirm you're human* banner, the icon badge shows **!**, and a desktop notification appears. Tick the box yourself; scraping continues automatically with no time limit, and nothing already collected is lost. The extension never tries to solve or bypass these checks.
- **Staying under the limit:** there are random 2.5–4 s pauses between requests, a 30–60 s break every 25 requests, and after every check or *429 Too Many Requests* the rest of the run gets slower (up to 4×). If you still see many, raise *Delay* in Settings (e.g. 5000 ms) or use the *Detailed* or *Quick* result type.
- **Phone numbers** are shown behind a button on ingatlan.com, but the listing page already contains the number in a hidden block (`<span data-number="…">`). The extension reads it from there, so nothing is clicked.
- **Live view:** on a result page, everything but the list is dimmed, every card is highlighted as it is captured, and a cursor "clicks" the next-page button before the tab opens the next page. On a listing, every value being read is spotlighted on the page and added to an *Extracted data* panel on the right. The animations use the wait between requests (*Delay* in Settings), so they don't add to it; opening each page in full takes a little longer than a background fetch, though. The bottom bar has **Stop** and an eye button that hides the animation without stopping the run. If you open another page in that tab yourself, the run stops (download or continue from the popup).
- **Progress is saved as it goes** (`chrome.storage.local`), so you can download what has been collected at any time, even after stopping. If you press Start again on the same search, listings whose details were already fetched are reused rather than fetched again.

## Install locally (developer mode)

1. Open `chrome://extensions` in Chrome (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project folder (the one that contains `manifest.json`).
4. Pin the extension: puzzle-piece icon → pin *Ingatlan.com Listing Exporter*.

After editing any file, click the **↻ reload** icon on the extension's card in `chrome://extensions`, then reload the ingatlan.com tab.

## Usage

1. Go to <https://ingatlan.com>, search, and set your filters until properties are listed (URL `https://ingatlan.com/lista/...`).
2. Click the extension icon. The popup shows **Valid page** and how many properties are on the current page.
3. Choose what to collect. Each option shows an estimated time for **your** search:

   | Result type | What you get | Typical time for ~400 properties |
   |---|---|---|
   | **Quick** | Price, m², price/m², rooms, city/district, address, agency or private, labels | ≈ 1–2 min |
   | **Detailed** | Quick + floor, building levels, advertiser name, description and every listing parameter | ≈ 35–55 min |
   | **Full** | Detailed + advertiser phone numbers (read from each listing page) | ≈ 1–1.5 h |

   The estimate uses the result counter on the page (e.g. "412 találat") when there is one. Otherwise it uses the highest page number in the pagination. The pagination only shows nearby pages, so more pages can appear once the scan gets there. That is why the estimate is a minimum and the popup shows "page 7 of 21+" while scanning. In the details phase, the popup shows the time left based on the real speed so far.

   Your choice is remembered. Under **Settings**, **Max pages** caps how many result pages are read (20 listings per page) and **Delay (ms)** sets the pause between requests. Both change the estimates immediately.
4. Click **Start Scraping**. You can close the popup; keep the ingatlan.com tab open (it can be in the background). The icon badge shows the running count, and reopening the popup shows the live counter.
5. When it finishes, click **Download Excel (N)**. **New scrape** runs the same search again from the start. Listings whose details were already collected are reused.

### Stop, continue, collect more

Progress is saved after every page and every few listings. After **Stop**, or if the tab was closed or reloaded, the popup offers:

- **Download Excel (N)**: everything collected so far.
- **Continue where it stopped**: scans the remaining result pages (from the next page, not from page 1), then the listings still missing data for the chosen result type. Listings that failed earlier are retried.
- **Collect more for these N properties**: adds a higher level of data to the rows you already have, without scanning the result pages again:
  - **+ Details** after a Quick run: floor, advertiser, all parameters.
  - **+ Phones** after a Quick or Detailed run: phone numbers, plus details for rows that don't have them yet.

Each option shows its estimated time. If the ingatlan.com tab isn't open any more, the extension reopens the search in a background tab and continues there.

### Notifications

You can start a long run and do something else. The extension shows a desktop notification when:

- **ingatlan.com needs a human check.** Scraping is paused. Click the notification to jump to the tab, tick the box, and scraping continues on its own. There is no time limit.
- **Scraping finished**, or stopped with an error. Click it to open the tab and the popup, then download.

Chrome must keep running and the computer must stay awake (not in sleep mode) during the run. If Windows notifications are off for Chrome (Settings → System → Notifications), the badge on the icon still shows **!** or the count.

## Building the zip

**Windows (PowerShell)**, from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

This creates `dist\ingatlan-exporter-<version>.zip` with `manifest.json` at the zip root, which is the format the Chrome Web Store expects.
(Don't use `Compress-Archive` on Windows PowerShell 5.1: it can write backslashes into the zip paths, and the Web Store rejects those.)

**macOS / Linux (Terminal)** only. The `zip` command does not exist in Windows PowerShell:

```bash
mkdir -p dist && zip -r dist/ingatlan-exporter.zip manifest.json icons lib popup src
```

To share the extension without the store, send the zip. The recipient unzips it and uses **Load unpacked** as described above.

## Publishing to the Chrome Web Store

1. **Create a developer account** at <https://chrome.google.com/webstore/devconsole>. Sign in with a Google account and pay the one-time **US$5** registration fee. Verify your contact email.
2. **Bump the version** in `manifest.json` (every upload needs a higher `version`), then run `build.ps1`.
3. In the Developer Dashboard click **New item** → upload `dist/ingatlan-exporter-<version>.zip`.
4. Fill in the **Store listing** tab:
   - Description (what it does, which site it works on).
   - Category: *Productivity* (or *Tools*).
   - At least one **screenshot** (1280×800 or 640×400) — e.g. the popup showing the found count and the Download Excel button.
   - A **128×128 icon** (`icons/icon128.png`) is already included; a 440×280 small promo tile is optional.
5. Fill in the **Privacy** tab:
   - **Single purpose**: "Export ingatlan.com search results to an Excel file."
   - **Permission justifications**:
     - `storage`, `unlimitedStorage`: store scraped results and progress locally until the user downloads them.
     - `scripting`: inject the exporter into ingatlan.com result pages and read listing pages in the worker tab.
     - `tabs`: open/navigate/close the background worker tab used to load listing pages and reveal phone numbers, and reopen the search tab to continue a stopped run.
     - `notifications`: tell the user when a security check needs them, and when a run has finished.
     - Host permission `https://ingatlan.com/*`: the extension only works on ingatlan.com.
   - **Remote code**: No. SheetJS is bundled locally.
   - **Data usage**: the extension handles *personally identifiable information* (advertiser names and phone numbers). Declare it, and state that data is stored only locally in the browser and never sent to any server.
   - A **privacy policy URL** is required when you declare user data. A simple GitHub Pages / Google Sites page stating "all data stays in your browser, nothing is transmitted" is enough.
6. **Distribution** tab: choose visibility:
   - **Public**: anyone can find it.
   - **Unlisted**: only people with the link can install it (good for a team or clients).
   - **Private**: only specific Google accounts or your Google Workspace domain.
7. Click **Submit for review**. Review usually takes from a few days to a couple of weeks. Scraping extensions that touch personal data often get extra questions, so clear permission justifications help.

To publish an update: raise `version` in `manifest.json`, run `build.ps1`, then in the dashboard open the item → **Package** → **Upload new package** → **Submit for review**.

## If something stops working

ingatlan.com changes its HTML from time to time. All selectors and label texts are in `src/parser.js`:

- `parseListPage`: results cards (`a.listing-card[data-listing-id]`), price, address, stats, next-page detection.
- `parseDetailPage`: parameter tables / definition lists, floor (`LABELS.floor`), advertiser (`iroda.ingatlan.com` link or *Magánszemély* text).
- `extractPhones` in `src/parser.js`: where the phone number is read from (the hidden `data-number` attribute, then `tel:` links).

To debug, open DevTools on the results page and run, for example:

```js
// In the ingatlan.com tab's console, choose the extension's context
// ("Ingatlan.com Listing Exporter") in the context dropdown first:
IngatlanParser.parseListPage(document, 1)
const html = await (await fetch('/35594767')).text();
IngatlanParser.parseDetailPage(new DOMParser().parseFromString(html, 'text/html'))
```

The service worker's logs are available from `chrome://extensions` → the extension's card → **service worker** link.

**Known limitations**

- The phone-number button and the detail page layout could not be inspected while this was written (ingatlan.com blocks non-browser requests), so phone and floor detection rely on generic rules: `tel:` links, phone-number patterns near the button, and parameter tables labelled *Emelet*. If the Phone or Floor column is empty for every row, adjust those rules in `parser.js` / `background.js` as described above.
- If Chrome's page translation is on, the on-page texts are translated, but fetched pages are always parsed in Hungarian, so the data stays consistent.

## Legal note

Use this tool responsibly and only for your own research. Check ingatlan.com's terms of use before scraping at scale. Advertisers' names and phone numbers are personal data under the GDPR. Don't republish them, and don't use them for unsolicited marketing.
