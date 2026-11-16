# product-ppc-analysis

Prices a product's advertising from **market click costs** before you order stock — step 3 of the
[product-research-skills](https://github.com/AronLEEdev/product-research-skills) pipeline
(Discovery → Cost → **PPC** → Review).

> **Status:** usable. `SKILL.md` drives the run, `ppc.mjs` does the math (tested), and
> `report-template.html` renders `ppc.js`. The verdict lines, the 1.8 bid scaling and the 10%
> mature conversion are provisional until a product that actually passes calibrates them.

## Why

The cost skill used to assume every product's ads cost 20% of sales. That hid a whole class of
bad picks. Our own pet hair remover glove ($13.99) showed a healthy margin on that assumption;
its market clicks cost about $2.70, so roughly half of all clicks had to convert just to pay for
themselves. A canvas tote at $22.99 paid about $0.83 a click. Search volume and CPR, the numbers
we looked at during research, show none of this. The bid column in the same Helium 10 table does.

## What it computes

From the cost skill's `results.js` (margins **before** ads) and a keyword table with suggested bids:

| Figure | Meaning |
|---|---|
| Market CPC | search-volume-weighted suggested bid over the **winnable** keywords |
| Break-even conversion | CPC ÷ profit per sale — what an ad click must convert at to pay for itself |
| Required share without ads | `1 − profit per sale × mature conversion ÷ CPC` — the share of sales that must come without ads to break even. **The verdict.** |
| Payback | 12-week launch loss ÷ steady monthly profit |
| Lowest viable price | the price at which the product reaches the PASS line |
| Keyword market | winnable search volume (not a competitor's brand, not another product), sales per 100 searches, the top-3 products' share of sales, and the search volume you can afford to buy |
| Comparison rows | our own two products, in every report, so a candidate is never read alone |

**Verdict** (all lines provisional until a product that actually passes calibrates them):
PASS when 50% or less of sales must come without ads at a mature conversion (default 10%, an
assumption); TEST up to 70%; FAIL above. A 30% rise in bids (Q4, top-of-search) can lower it one
step, and a PASS whose launch takes more than 6 months to pay back becomes a TEST.

Helium 10's suggested bids run below what Amazon quotes a new listing, so they are scaled by
1.8 — the gap measured on both reference products. The report shows raw and scaled figures.

## Reference data

`fixtures/` holds real numbers from our own account, used as calibration cases in the tests and
as the comparison rows:

- `*-bids-2026-11-10.json` — Amazon Ads suggested bids for our live campaigns
- `*-cerebro-2026-10-26.json` — Helium 10 Cerebro top-50 keywords, each tagged generic / brand / other
- `reference-products.json` — unit economics and actual ad conversion of the two products

## Use

Install as a skill (see `SKILL.md`), or run the calculator directly:

```
node ppc.mjs <run-dir> "<keyword>" [--units-per-week N] [--mature-conversion 0.10]
```

Reads `<run-dir>/results.js` (cost skill 2.0+) and `<run-dir>/bids.json`
(`{ source, capturedOn, brands, keywords: [{ phrase, searchVolume, bidLow, bidMid, bidHigh, keywordSales, top3ConvShare, tag? }] }`),
writes `<run-dir>/ppc.js` (`window.__PPC_DATA__`). A missing input stops the run; nothing is guessed.

```
node --test ppc.test.mjs
```
