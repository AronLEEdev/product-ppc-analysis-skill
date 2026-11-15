// ppc.mjs — product-ppc-analysis: price a product's advertising from market click costs.
//
// Deterministic math only (Node >= 18 built-ins). The skill gathers the inputs
// (keywords + suggested bids, the cost skill's results.js) and this file turns them
// into break-even conversion, the share of sales that must come without ads, expected
// ACoS, a lowest viable price, the launch cost with its payback time, and a verdict. No input is ever guessed: a missing value is null,
// and a figure that needs it is null too (never 0 — the Number(null) === 0 trap).

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** Verdict lines — PROVISIONAL (Aron, Nov 14 2026: examples until real data calibrates them).
 *  A mature product does not pay for a click on every sale, so the verdict is the share of
 *  sales that must come WITHOUT ads for the product to break even at a mature conversion:
 *  passShare or less → PASS, above failShare → FAIL, between → TEST. A launch that takes
 *  longer than paybackMonths to earn back lowers a PASS to TEST. */
export const THRESHOLDS = { passShare: 0.5, failShare: 0.7, paybackMonths: 6 };
/** Conversion a listing with reviews is assumed to reach — an assumption, not a measurement.
 *  Override per run with the category's real rate (Search Query Performance, once the brand
 *  is registered). A new listing is assumed to convert at LAUNCH_FACTOR of it. */
export const MATURE_CONVERSION = 0.10;
export const LAUNCH_FACTOR = 0.5;
/** Conversion scenarios used when the run gives none. */
export const SCENARIOS = [0.05, 0.10, 0.15];
/** Q4 / top-of-search stress multiplier on CPC. */
export const STRESS = 1.3;
/** Minimum keywords with a bid before a weighted CPC is trusted. */
export const MIN_KEYWORDS = 5;

const num = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v, d = 4) => (v == null ? null : +v.toFixed(d));

/** Search-volume-weighted CPC from keyword bids.
 *  keywords: [{ phrase, searchVolume, bidLow, bidMid, bidHigh }]. Rows without a mid bid
 *  are skipped; rows without a volume weigh 1 (and the result says so). */
export function weightedCpc(keywords, { minKeywords = MIN_KEYWORDS } = {}) {
  const rows = (keywords || []).filter((k) => num(k.bidMid) != null && num(k.bidMid) > 0);
  if (rows.length < minKeywords) {
    throw new Error(`only ${rows.length} keywords have a suggested bid; need ${minKeywords} — stop and ask for bids`);
  }
  const unweighted = rows.some((k) => num(k.searchVolume) == null || num(k.searchVolume) <= 0);
  const w = (k) => (unweighted ? 1 : num(k.searchVolume));
  const total = rows.reduce((a, k) => a + w(k), 0);
  const avg = (pick) => {
    const have = rows.filter((k) => num(pick(k)) != null);
    if (have.length !== rows.length) return null;
    return have.reduce((a, k) => a + w(k) * num(pick(k)), 0) / total;
  };
  return {
    low: round(avg((k) => k.bidLow)),
    mid: round(avg((k) => k.bidMid)),
    high: round(avg((k) => k.bidHigh)),
    keywords: rows.length,
    weighting: unweighted ? "equal (search volume missing)" : "search volume",
  };
}

/** Helium 10's "Suggested PPC Bid" runs well below what Amazon quotes a new listing.
 *  Measured on our own two products (Helium Oct 26 vs Amazon Ads suggested bids Nov 10, 2026):
 *  2.70 ÷ 1.47 and 0.83 ÷ 0.48, both about 1.8. PROVISIONAL — refresh when real quotes exist. */
export const BID_CALIBRATION = { helium10: 1.8 };
/** Top-3 products taking more than this share of a keyword's sales = concentrated. */
export const SPREAD_FLAG = 0.30;

/** Scale a CPC range from its source's level to the level Amazon quotes. */
export function calibrate(cpc, source, table = BID_CALIBRATION) {
  const factor = (source && table[source]) || 1;
  const f = (v) => (v == null ? null : round(v * factor));
  return { ...cpc, low: f(cpc.low), mid: f(cpc.mid), high: f(cpc.high), raw: { low: cpc.low, mid: cpc.mid, high: cpc.high }, calibration: factor, source: source || null };
}

/** Tag each keyword: an explicit `tag` wins ("generic" | "brand" | "other", set by the skill
 *  with a `tagReason`); otherwise a competitor brand name in the phrase makes it "brand";
 *  everything else is "generic". Only generic keywords are winnable. */
export function tagKeywords(keywords, brands = []) {
  const names = brands.map((b) => String(b).toLowerCase().trim()).filter(Boolean);
  return (keywords || []).map((k) => {
    if (k.tag) return k;
    const phrase = String(k.phrase || "").toLowerCase();
    const hit = names.find((b) => phrase.includes(b));
    return hit ? { ...k, tag: "brand", tagReason: `competitor brand "${hit}"` } : { ...k, tag: "generic" };
  });
}

/** The shape of the keyword market, from Cerebro rows (already tagged).
 *  - winnable volume: searches on generic keywords (not a competitor's brand, not another product)
 *  - intent: estimated sales per 100 searches on winnable keywords
 *  - spread: share of a keyword's sales taken by the top 3 products, weighted by volume
 *  - affordable volume: winnable searches on keywords whose (calibrated) bid is at or under
 *    `affordableCpc` = conversion × profit per sale — how much of the market can be bought at a profit */
export function keywordMarket(keywords, { affordableCpc = null, calibration = 1, spreadFlag = SPREAD_FLAG } = {}) {
  const rows = keywords || [];
  const vol = (list) => list.reduce((a, k) => a + (num(k.searchVolume) ?? 0), 0);
  const by = (tag) => rows.filter((k) => k.tag === tag);
  const generic = by("generic");
  const total = vol(rows);
  const winnable = vol(generic);
  const withSales = generic.filter((k) => num(k.keywordSales) != null && num(k.searchVolume) > 0);
  const withSpread = generic.filter((k) => num(k.top3ConvShare) != null && num(k.searchVolume) > 0);
  const afford = num(affordableCpc);
  const cheap = afford == null ? null
    : generic.filter((k) => num(k.bidMid) != null && num(k.bidMid) * calibration <= afford);
  const spread = withSpread.length
    ? withSpread.reduce((a, k) => a + num(k.searchVolume) * num(k.top3ConvShare), 0) / vol(withSpread) : null;
  const out = {
    keywords: rows.length,
    totalVolume: total,
    winnableVolume: winnable,
    winnableShare: total > 0 ? round(winnable / total) : null,
    brandVolume: vol(by("brand")),
    otherVolume: vol(by("other")),
    salesPer100Searches: withSales.length ? round((withSales.reduce((a, k) => a + num(k.keywordSales), 0) / vol(withSales)) * 100, 2) : null,
    top3SalesShare: round(spread),
    concentrated: spread == null ? null : spread > spreadFlag,
    affordableCpc: afford,
    affordableVolume: cheap == null ? null : vol(cheap),
    affordableShare: cheap == null || winnable === 0 ? null : round(vol(cheap) / winnable),
    affordableKeywords: cheap == null ? null : cheap.map((k) => k.phrase),
  };
  out.warnings = marketWarnings(out);
  return out;
}

/** Plain-language warnings. Reported beside the verdict, not scored (two reference products
 *  are too few to set pass/fail lines for these). */
export function marketWarnings(m) {
  const w = [];
  if (m.winnableShare != null && m.winnableShare < 0.5) {
    w.push(`Only ${Math.round(m.winnableShare * 100)}% of the search volume is winnable; the rest is competitor brand names or other products.`);
  }
  if (m.concentrated) {
    w.push(`Sales are concentrated: the top 3 products take ${Math.round(m.top3SalesShare * 100)}% of sales on the winnable keywords.`);
  }
  if (m.affordableShare != null && m.affordableShare < 0.2) {
    const share = Math.round(m.affordableShare * 100);
    w.push(`${share === 0 ? "None" : `Only ${share}%`} of the winnable search volume has clicks at or under the affordable $${m.affordableCpc.toFixed(2)}.`);
  }
  return w;
}

/** Conversion an ad click needs to pay for itself: CPC ÷ money per sale. */
export function breakEvenConversion(cpc, perSale) {
  const c = num(cpc), m = num(perSale);
  if (c == null || m == null) return null;
  if (m <= 0) return Infinity; // the sale loses money before any ad: no conversion is enough
  return c / m;
}

/** Share of sales that must come without ads to reach `targetMargin` (0 = break even):
 *  1 − (m − targetMargin × price) × conversion ÷ CPC. 0 = ads alone pay; 1 or more = never. */
export function requiredOrganicShare(cpc, perSale, conversion, { targetMargin = 0, price = null } = {}) {
  const c = num(cpc), m = num(perSale), cr = num(conversion);
  if (c == null || m == null || cr == null || c <= 0 || cr <= 0) return null;
  const room = m - (targetMargin ? targetMargin * (num(price) ?? NaN) : 0);
  if (!Number.isFinite(room)) return null;
  if (room <= 0) return 1; // nothing left per sale: no mix of sales can reach the target
  return Math.min(1, Math.max(0, 1 - (room * cr) / c));
}

/** Verdict band for a required share of sales without ads. */
export function band(share, t = THRESHOLDS) {
  if (share == null) return null;
  if (share <= t.passShare) return "PASS";
  if (share <= t.failShare) return "TEST";
  return "FAIL";
}

const WORSE = { PASS: "TEST", TEST: "FAIL", FAIL: "FAIL" };
const ORDER = { PASS: 0, TEST: 1, FAIL: 2 };

/** Test 1 — does it earn at maturity? Required share of sales without ads at the mature
 *  conversion, stepped down once when the stressed CPC lands in a worse band. */
export function verdict(cpc, perSale, { thresholds = THRESHOLDS, stress = STRESS, matureConversion = MATURE_CONVERSION } = {}) {
  const be = breakEvenConversion(cpc, perSale);
  const share = requiredOrganicShare(cpc, perSale, matureConversion);
  const base = band(share, thresholds);
  if (base == null) return { verdict: null, breakEven: null, requiredShare: null, requiredShareStressed: null, steppedDown: false };
  const shareStress = requiredOrganicShare(num(cpc) * stress, perSale, matureConversion);
  const steppedDown = ORDER[band(shareStress, thresholds)] > ORDER[base];
  return {
    verdict: steppedDown ? WORSE[base] : base,
    breakEven: round(be),
    matureConversion,
    requiredShare: round(share),
    requiredShareStressed: round(shareStress),
    steppedDown,
  };
}

/** Test 2 — what does the launch cost? Profit basis. Over `weeks`, the share of sales without
 *  ads climbs in a straight line from 0 to `matureShare` while conversion sits at the launch
 *  rate; after that the product earns its steady monthly profit at the mature conversion.
 *  paybackMonths = launch loss ÷ steady monthly profit (0 = no loss; null = never pays back). */
export function payback(cpc, perSale, unitsPerWeek, { matureConversion = MATURE_CONVERSION, launchConversion = null, matureShare = THRESHOLDS.passShare, weeks = 12 } = {}) {
  const c = num(cpc), m = num(perSale), u = num(unitsPerWeek);
  const launchCr = num(launchConversion) ?? matureConversion * LAUNCH_FACTOR;
  if ([c, m, u].some((v) => v == null) || u <= 0 || launchCr <= 0 || matureConversion <= 0) return null;
  let launchNet = 0;
  const byWeek = [];
  for (let i = 0; i < weeks; i++) {
    const s = weeks > 1 ? (matureShare * i) / (weeks - 1) : matureShare;
    const net = u * (m - ((1 - s) * c) / launchCr);
    launchNet += net;
    byWeek.push({ week: i + 1, organicShare: round(s), net: round(net, 2) });
  }
  const steadyMonthly = (u * 52) / 12 * (m - ((1 - matureShare) * c) / matureConversion);
  const loss = Math.max(0, -launchNet);
  return {
    assumptions: { unitsPerWeek: u, launchConversion: launchCr, matureConversion, matureShare, weeks },
    byWeek,
    launchLoss: round(loss, 2),
    steadyMonthlyProfit: round(steadyMonthly, 2),
    paybackMonths: loss === 0 ? 0 : steadyMonthly > 0 ? round(loss / steadyMonthly, 1) : null,
  };
}

/** One conversion scenario. organicShare = share of sales not from ads (0–1). */
export function scenario(cpc, product, conversion, organicShare = 0) {
  const c = num(cpc), cr = num(conversion), price = num(product.price), m = num(product.profitBeforePPC);
  const s = num(organicShare) ?? 0;
  if ([c, cr, price, m].some((v) => v == null) || cr <= 0 || price <= 0) return null;
  const costPerAdOrder = c / cr;
  const adCostPerUnit = (1 - s) * costPerAdOrder; // spread over every unit sold
  const profitAfterAds = m - adCostPerUnit;
  return {
    conversion: cr,
    organicShare: s,
    expectedAcos: round(costPerAdOrder / price),
    affordableCpc: round(cr * m),
    adCostPerUnit: round(adCostPerUnit),
    profitAfterAds: round(profitAfterAds),
    marginAfterAds: round(profitAfterAds / price),
  };
}

/** Lowest price at which the product reaches the pass line: required share of sales without
 *  ads = passShare at the mature conversion. Referral scales with price; FBA, landed cost,
 *  inbound, storage and return loss are held at the cost run's values. */
export function lowestViablePrice(cpc, product, { matureConversion = MATURE_CONVERSION, share = THRESHOLDS.passShare } = {}) {
  const c = num(cpc), price = num(product.price), ref = num(product.referralFee);
  const fixedParts = [product.fulfillmentFee, product.landedCogs, product.inboundFee, product.storageFee, product.returnLoss].map(num);
  if (c == null || price == null || ref == null || fixedParts.some((v) => v == null) || matureConversion <= 0) return null;
  const refPct = ref / price;
  if (refPct >= 1) return null;
  const fixed = fixedParts.reduce((x, y) => x + y, 0);
  const needPerSale = (c * (1 - share)) / matureConversion; // m at which required share = share
  return round((needPerSale + fixed) / (1 - refPct), 2);
}

/** Launch cash burn, week by week, at `unitsPerWeek`, with the share of sales not from ads
 *  following `ramp` (one value per week; the last value repeats). Cash basis. */
export function launchBurn(cpc, cashPerSale, conversion, unitsPerWeek, ramp, weeks = 12) {
  const c = num(cpc), cash = num(cashPerSale), cr = num(conversion), u = num(unitsPerWeek);
  if ([c, cash, cr, u].some((v) => v == null) || cr <= 0 || !Array.isArray(ramp) || !ramp.length) return null;
  let total = 0, breakEvenWeek = null;
  const byWeek = [];
  for (let i = 0; i < weeks; i++) {
    const s = num(ramp.at(Math.min(i, ramp.length - 1))) ?? 0;
    const adUnits = u * (1 - s);
    const spend = (adUnits / cr) * c;
    const net = u * cash - spend; // negative = cash burned that week
    total += net;
    if (breakEvenWeek == null && net >= 0) breakEvenWeek = i + 1;
    byWeek.push({ week: i + 1, organicShare: s, adSpend: round(spend, 2), cashIn: round(u * cash, 2), net: round(net, 2) });
  }
  return { byWeek, total: round(total, 2), breakEvenWeek };
}

/** Default ramp for the cash view: share of units not from ads by launch week, climbing to
 *  the pass line by week 12. An assumption; override with a comparable product's history. */
export const DEFAULT_RAMP = Array.from({ length: 12 }, (_, i) => +((THRESHOLDS.passShare * i) / 11).toFixed(4));

/** Everything for one product from the cost run. */
export function analyzeProduct(cpc, product, opts = {}) {
  const t = opts.thresholds || THRESHOLDS;
  const mature = opts.matureConversion ?? MATURE_CONVERSION;
  const v = verdict(cpc.mid, product.profitBeforePPC, { ...opts, thresholds: t, matureConversion: mature });
  const cash = verdict(cpc.mid, product.cashPerSale, { ...opts, thresholds: t, matureConversion: mature });
  const unitsPerWeek = num(opts.unitsPerWeek);
  const pb = unitsPerWeek == null ? null
    : payback(cpc.mid, product.profitBeforePPC, unitsPerWeek, { matureConversion: mature, launchConversion: opts.launchConversion, matureShare: t.passShare });
  // A launch that never pays back, or takes longer than the limit, lowers a PASS to TEST.
  const slowPayback = !!pb && (pb.paybackMonths == null || pb.paybackMonths > t.paybackMonths);
  const final = v.verdict === "PASS" && slowPayback ? "TEST" : v.verdict;
  const scenarios = (opts.scenarios || SCENARIOS).map((cr) => ({
    ...scenario(cpc.mid, product, cr, 0),
    requiredShare: round(requiredOrganicShare(cpc.mid, product.profitBeforePPC, cr)),
  }));
  return {
    asin: product.asin,
    title: product.title,
    price: num(product.price),
    profitBeforePPC: num(product.profitBeforePPC),
    cashPerSale: num(product.cashPerSale),
    ...v,
    verdict: final,
    maturityVerdict: v.verdict,
    slowPayback,
    breakEvenCash: cash.breakEven,
    requiredShareCash: cash.requiredShare,
    verdictCash: cash.verdict,
    scenarios,
    lowestViablePrice: lowestViablePrice(cpc.mid, product, { matureConversion: mature, share: t.passShare }),
    payback: pb,
    launchCash: unitsPerWeek == null ? null
      : launchBurn(cpc.mid, product.cashPerSale, opts.launchConversion ?? mature * LAUNCH_FACTOR, unitsPerWeek, DEFAULT_RAMP),
  };
}

/** Tag the keywords, take the CPC from the winnable (generic) ones only, and scale it to
 *  the level Amazon quotes. Returns the CPC plus a per-product market summary. */
export function buildMarket(bids, products, opts = {}) {
  const tagged = tagKeywords(bids.keywords, bids.brands || []);
  const generic = tagged.filter((k) => k.tag === "generic");
  const cpc = calibrate(weightedCpc(generic), bids.source, opts.calibrationTable || BID_CALIBRATION);
  const mature = opts.matureConversion ?? MATURE_CONVERSION;
  const marketFor = (p, conversion = mature) => keywordMarket(tagged, {
    affordableCpc: num(p.profitBeforePPC) == null ? null : round(conversion * num(p.profitBeforePPC), 2),
    calibration: cpc.calibration,
  });
  return { cpc, tagged, marketFor };
}

/** Comparison rows: our own products, shown in every report so a candidate is never read alone. */
export async function loadReferences(opts = {}) {
  const dir = opts.fixturesDir || join(dirname(fileURLToPath(import.meta.url)), "fixtures");
  let ref;
  try { ref = JSON.parse(await readFile(join(dir, "reference-products.json"), "utf8")); } catch { return []; }
  const rows = [];
  for (const r of ref.products) {
    const bids = JSON.parse(await readFile(join(dir, r.cerebro), "utf8"));
    const { cpc, marketFor } = buildMarket(bids, [r.product], opts);
    const a = analyzeProduct(cpc, r.product, { ...opts, matureConversion: r.actualConversion, unitsPerWeek: null });
    rows.push({
      key: r.key, name: r.name, conversion: r.actualConversion, conversionNote: r.conversionNote,
      cpc, breakEven: a.breakEven, requiredShare: a.requiredShare, verdict: a.verdict,
      market: marketFor(r.product, r.actualConversion),
    });
  }
  return rows;
}

function loadWindowJs(text, name) {
  const m = text.match(new RegExp(`window\\.${name}\\s*=\\s*([\\s\\S]*?);?\\s*$`));
  if (!m) throw new Error(`${name} not found`);
  return JSON.parse(m[1]);
}

/** CLI: node ppc.mjs <run-dir> "<keyword>" [--units-per-week N]
 *  Reads <run-dir>/results.js (cost skill 2.0+) and <run-dir>/bids.json, writes ppc.js. */
export async function main(runDir, keyword, opts = {}) {
  const cost = loadWindowJs(await readFile(join(runDir, "results.js"), "utf8"), "__FBA_DATA__");
  const bids = JSON.parse(await readFile(join(runDir, "bids.json"), "utf8"));
  const products = [...(cost.survivors || []), ...(cost.eliminated || [])];
  if (!products.length) throw new Error("results.js has no products");
  if (products.some((p) => p.profitBeforePPC == null)) {
    throw new Error("results.js is from the old cost skill (no profitBeforePPC) — re-run product-cost-analyze 2.0+");
  }
  const built = buildMarket(bids, products, opts);
  const { cpc, tagged } = built;
  const results = products
    .map((p) => ({ ...analyzeProduct(cpc, p, opts), market: built.marketFor(p) }))
    .sort((a, b) => (a.requiredShare ?? Infinity) - (b.requiredShare ?? Infinity));
  // sorted by required share of sales without ads, so the first one is the best case
  const best = results.find((r) => r.verdict) || null;
  const data = {
    keyword,
    date: new Date().toISOString().slice(0, 10),
    bidsCapturedOn: bids.capturedOn || null,
    bidsSource: bids.source || null,
    cpc,
    references: await loadReferences(opts),
    thresholds: opts.thresholds || THRESHOLDS,
    thresholdsProvisional: true,
    matureConversion: opts.matureConversion ?? MATURE_CONVERSION,
    matureConversionSource: opts.matureConversionSource || "assumption (no category data supplied)",
    stress: opts.stress || STRESS,
    unitsPerWeek: num(opts.unitsPerWeek),
    keywords: tagged,
    results,
    verdict: best ? best.verdict : null,
    bestAsin: best ? best.asin : null,
    counts: Object.fromEntries(["PASS", "TEST", "FAIL"].map((k) => [k, results.filter((r) => r.verdict === k).length])),
  };
  await writeFile(join(runDir, "ppc.js"), "window.__PPC_DATA__ = " + JSON.stringify(data, null, 2) + ";");
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const [runDir, keyword] = argv;
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : undefined; };
  if (!runDir || !keyword) {
    console.error('Usage: node ppc.mjs <run-dir> "<keyword>" [--units-per-week N] [--mature-conversion 0.10]');
    process.exit(1);
  }
  const opts = {};
  if (flag("--units-per-week") !== undefined) opts.unitsPerWeek = flag("--units-per-week");
  if (flag("--mature-conversion") !== undefined) {
    opts.matureConversion = flag("--mature-conversion");
    opts.matureConversionSource = "supplied for this run";
  }
  main(runDir, keyword, opts)
    .then((d) => console.log(`Wrote ppc.js — CPC $${d.cpc.mid} (${d.cpc.keywords} keywords), verdict ${d.verdict}.`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
