---
name: product-ppc-analysis
description: Price a product's Amazon advertising from market click costs before ordering stock. Reads a product-cost-analyze run (margins before ads), pulls the keyword table with Helium 10 Cerebro's Suggested PPC Bid (History first, so usually 0 metered lookups), tags winnable keywords, and runs a tested calculator for break-even conversion, the share of sales that must come without ads, launch payback, lowest viable price and the keyword market's shape. Renders a static HTML report beside our own reference products.
---

# Product PPC Analysis

Step 3 of the product-research pipeline: Discovery → Cost → **PPC** → Review.

The cost skill reports margins **before** advertising. This skill prices the advertising
from what the market actually charges per click, so a product whose clicks cost more than
a sale earns is caught before any stock is ordered. Our own pet hair remover glove is the
reason it exists: at $13.99 with clicks around $2.70, roughly half of all clicks had to
convert just to pay for themselves, and nothing in search volume or CPR showed it.

All arithmetic lives in `ppc.mjs` (tested, Node ≥18 built-ins only). The skill gathers
inputs, runs it once, and serves a fixed report template. No figure is ever guessed.

## Output files (per run)

Run directory: the cost run's sibling `~/Documents/product-research/<keyword>-ppc/`.

| File | Written by | Description |
|---|---|---|
| `results.js` | copied from the cost run | `window.__FBA_DATA__` — must be cost skill **2.0+** (has `profitBeforePPC`) |
| `bids.json` | Phase 1 | keyword table with suggested bids, tagged generic / brand / other |
| `ppc.js` | Phase 2 (`ppc.mjs`) | `window.__PPC_DATA__` — everything the report shows |
| `ppc-report.html` | fetched once | the static report template |
| `ppc.mjs`, `fixtures/` | fetched once | the calculator and our reference products |

## Preconditions

| Requirement | Needed for | Required? |
|---|---|---|
| A **product-cost-analyze 2.0+** run for the same keyword | profit and cash per sale | **Required** |
| Chrome + **Claude-in-Chrome MCP**, logged in to **Helium 10** | Cerebro keyword table and bids | **Required** (or the manual fallback in 1.5) |
| **Node.js ≥ 18** | runs `ppc.mjs` | **Required** |
| **Python 3** | serves the report over http | **Required** |
| A Discovery run (`opportunities.js`) for the niche | average units per seller, for the launch estimate | Recommended |

**Never act on the user's Amazon Ads account.** Reading Helium 10 is fine; creating,
saving or launching anything in Amazon Ads is the user's step (see 1.5).

## Setup (first run)

```bash
RUN=~/Documents/product-research/<keyword>-ppc
mkdir -p "$RUN/fixtures"
BASE=https://raw.githubusercontent.com/AronLEEdev/product-ppc-analysis-skill/main
for f in ppc.mjs report-template.html fixtures/reference-products.json \
         fixtures/phr-cerebro-2026-10-26.json fixtures/tote-cerebro-2026-10-26.json; do
  [ -f "$RUN/$f" ] || curl -fsSL "$BASE/$f" -o "$RUN/$f"
done
mv -n "$RUN/report-template.html" "$RUN/ppc-report.html"
cp ~/Documents/product-research/<keyword>/results.js "$RUN/results.js"
grep -q profitBeforePPC "$RUN/results.js" || echo "STOP: cost run is older than 2.0 — re-run product-cost-analyze"
```

If `results.js` has no `profitBeforePPC`, **stop** and ask the user to re-run the cost skill.

## Caching (14-day TTL)

Cache `bids.json` by keyword slug (lowercase, non-alphanumerics → `-`):

```bash
CACHE=~/Documents/product-research/_cache/ppc
HIT=$(find "$CACHE" -name "bids__<slug>.json" -mtime -14 2>/dev/null | head -1)
[ -n "$HIT" ] && cp "$HIT" "$RUN/bids.json" && echo "CACHE HIT bids"
# after a clean Phase 1 (not a cache hit):
mkdir -p "$CACHE" && cp "$RUN/bids.json" "$CACHE/bids__<slug>.json"
```

Bids drift (Q4 especially); the report always prints the capture date. Delete the cache
file to force a fresh pull. Never cache a partial table.

## Phase 1 — Keyword table with suggested bids

> **Helium 10 usage cap: at most 3 metered actions per run**, shared with the review
> skill. Reopening a saved search from **History does not count** (verified Nov 2026:
> usage stayed 16/100 across several reopenings). Keep a counter.

### 1.1 Pick the ASINs

The top 2–3 products of the niche by revenue (the cost run's `products.json` or the
review run's Xray data). Our own listing is never one of them.

### 1.2 History first (0 metered)

In the logged-in Chrome, open `https://members.helium10.com/cerebro`, click **History**,
and look for a search on the same ASINs from the last 14 days. If found, click **Open**:
it reloads the full table at no cost. Otherwise run a new multi-ASIN search
(**1 metered action**) and say so.

### 1.3 Read the table

1. Scroll to the results and click the **Search Volume** column header once, so page 1
   (50 rows) is the top 50 by volume. Confirm with one probe that the first rows are in
   descending volume.
2. **Validate the column order** before reading by index. Probe the header text; the
   expected order (Nov 2026) is:
   `Keyword Phrase · ABA Total Click Share · ABA Total Conv. Share · Keyword Sales ·
   Cerebro IQ Score · Search Volume · Search Volume Trend · Suggested PPC Bid ·
   Sponsored ASINs · Competing Products · CPR · …`.
   If it differs, map by header text; never assume.
3. Rows are `[class*="datacy-row"]` elements with ≥20 children. Read cells with one
   `javascript_tool` call and return trimmed rows only:

```js
const rows=[...document.querySelectorAll('[class*="datacy-row"]')].filter(r=>r.children.length>=20)
  .map(r=>[...r.children].map(c=>(c.innerText||'').trim().replace(/\s+/g,' ')));
rows.map(x=>{const b=(x[7].match(/[\d.]+/g)||[]); const c=s=>s==='N/A'?'':s.replace(/[,%>]/g,'');
  return [x[0],c(x[5]),b[0]||'',b[1]||'',b[2]||'',c(x[3]),c(x[1]),c(x[2]),c(x[8]),c(x[10])].join('|')}).join('\n')
```

Fields per row: phrase | searchVolume | bidMid | bidLow | bidHigh | keywordSales |
top3ClickShare % | top3ConvShare % | sponsoredAsins | cpr. The bid cell reads
`$2.11($1.39 – $2.28)`: mid, then low–high. `N/A` → empty → `null`. Read in slices of
~14 rows if the result is cut off. Close the tab when done.

### 1.4 Tag the keywords and write bids.json

- **brand:** list the competitor brand names seen in the top listings' titles and in
  the keyword list (e.g. `purepath`, `pure path`, `chom chom`). Put them in `brands`;
  `ppc.mjs` tags matching phrases itself.
- **other:** a keyword for a different product (e.g. "pet hair remover for laundry" for
  a glove; "purses" for a tote). Set `"tag": "other"` with a short `tagReason`. Be
  conservative; the report lists every tag so the user can correct it.
- Everything else is **generic** (winnable).

```json
{ "source": "helium10", "capturedOn": "YYYY-MM-DD",
  "brands": ["purepath", "pure path"],
  "keywords": [
    { "phrase": "pet hair remover", "searchVolume": 34808, "bidMid": 1.48, "bidLow": 0.96,
      "bidHigh": 1.66, "keywordSales": 1274, "top3ClickShare": 0.295, "top3ConvShare": 0.189,
      "sponsoredAsins": 214, "cpr": 72 },
    { "phrase": "pet hair remover for laundry", "searchVolume": 131564, "bidMid": 1.27,
      "tag": "other", "tagReason": "laundry dryer product, not a glove" }
  ] }
```

Shares are fractions (18.9% → 0.189). `capturedOn` is the date of the Cerebro search,
not today, when it came from History.

### 1.5 Fallback — Amazon's own suggested bids (user step)

If Helium 10 is unavailable or the cap is reached, ask the user to:

1. In Amazon Ads, start a **Sponsored Products** campaign with manual keyword targeting
   using our nearest product, add the candidate's top 15 keywords, and **save it as a
   draft. Never launch it.**
2. Export or screenshot the keyword list with **Suggested bid (low / median / high)**.

Write `bids.json` with `"source": "amazon-ads"` (no scaling is applied) and the bids;
search volume, sales and share stay `null` unless the user supplies them. Never type
bids from memory. If neither source is possible, **stop** and say so.

## Phase 2 — Run the calculator

```bash
cd "$RUN" && node ppc.mjs "$RUN" "<keyword>" --units-per-week <U> [--mature-conversion <c>]
```

- **`--units-per-week`:** the Discovery niche's **average units per seller per month ÷
  4.33**. Without a Discovery run, use the median `monthlyVolume` of the cost run's top
  products ÷ 4.33 and say it is a fallback. Omit only if neither exists (the report then
  skips the launch estimate).
- **`--mature-conversion`:** default 0.10 is an **assumption**. Pass a measured category
  rate when one exists (Search Query Performance purchase ÷ click rate, once the brand is
  registered); the report labels which it used.

What it does: tags keywords; takes the click price from **generic keywords only**,
weighted by search volume; scales Helium 10 bids ×1.8 to the level Amazon quotes a new
listing (measured on our two products; Amazon bids are not scaled); then for each cost
product computes break-even conversion, the share of sales that must come without ads,
the stressed version at +30% click prices, launch payback, lowest viable price and the
keyword market (winnable volume, sales per 100 searches, top-3 share of sales,
affordable volume). It writes `ppc.js`.

It stops with a clear message, and you stop with it, when: fewer than 5 winnable
keywords have a bid; `results.js` is pre-2.0; a file is missing.

## Phase 3 — Open the report

```bash
cd "$RUN" && python3 -m http.server 7880 &
```

Then `navigate` to `http://localhost:7880/ppc-report.html` (a `file://` URL cannot load
`ppc.js`). Verify with one probe, then take one screenshot to share:

```js
JSON.stringify({ verdict: document.querySelector('.summary-bar .pill')?.textContent,
  cards: document.querySelectorAll('.card').length,
  keywords: document.querySelectorAll('.section:last-of-type tbody tr').length })
```

## Reading the verdict (tell the user this, briefly)

- **Test 1, maturity:** share of sales that must come without ads to break even at the
  mature conversion. PASS ≤ 50%, TEST ≤ 70%, FAIL above. A +30% click price can lower it
  one step.
- **Test 2, launch:** 12-week launch loss ÷ steady monthly profit. A PASS that takes over
  6 months to pay back becomes TEST.
- **These lines, the 1.8 bid scaling and the 10% conversion are provisional.** Say so in
  the summary. They were set from two products that both failed; the first product that
  actually passes should recalibrate them.
- Always mention the comparison rows (our glove and tote) and any keyword-market warning.
- Warnings (low winnable share, concentrated sales, no affordable keywords) inform; they
  do not change the verdict.

## Rules

- Never fabricate a bid, volume, sales figure or tag reason. Missing is `null`.
- Never create, save or launch anything in the user's Amazon Ads account.
- Respect the Helium 10 cap; History reopenings are free, new searches are not.
- Keyword ownership between our own products is not this skill's concern; it prices a
  candidate's market.
- Re-running with corrected tags: edit `bids.json`, re-run Phase 2 only.
