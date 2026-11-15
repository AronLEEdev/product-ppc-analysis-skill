// ppc.test.mjs — node --test ppc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  weightedCpc, breakEvenConversion, requiredOrganicShare, band, verdict, scenario,
  lowestViablePrice, launchBurn, payback, analyzeProduct, main, THRESHOLDS,
  tagKeywords, calibrate, keywordMarket, buildMarket, loadReferences, BID_CALIBRATION,
} from "./ppc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => JSON.parse(await readFile(join(here, "fixtures", name), "utf8"));
const near = (a, b, tol = 1e-3) => assert.ok(a != null && Math.abs(a - b) <= tol, `expected ≈${b}, got ${a}`);

// ---- calibration products (NaturalBenefit actual cost rows, Nov 2026) ----
// PHR 1PC: $13.99, referral 15.92%, FBA $5.06, landed $1.25, return provision $0.25 → $5.20 profit before ads.
const PHR = {
  asin: "PHR-1PC", title: "Pet hair remover glove", price: 13.99,
  referralFee: 2.2272, fulfillmentFee: 5.06, landedCogs: 1.25, inboundFee: 0, storageFee: 0, returnLoss: 0.25,
  profitBeforePPC: 5.2028, cashPerSale: 6.4528,
};
// Canvas Tote: $22.99 less a $1.79 average coupon = $21.20 effective price; referral 15.75%,
// FBA $8.06, landed $5.18, return provision $0.65 → $3.97 profit before ads.
const TOTE = {
  asin: "TOTE", title: "Canvas tote", price: 21.20,
  referralFee: 3.339, fulfillmentFee: 8.0644, landedCogs: 5.176, inboundFee: 0, storageFee: 0, returnLoss: 0.65,
  profitBeforePPC: 3.9706, cashPerSale: 9.1466,
};

test("calibration: PHR fails even at its own strong 18.1% conversion", async () => {
  const cpc = weightedCpc((await fixture("phr-bids-2026-11-10.json")).keywords);
  assert.ok(cpc.mid > 2 && cpc.mid < 3.2, `PHR CPC ${cpc.mid}`);
  const r = analyzeProduct(cpc, PHR, { matureConversion: 0.181 });
  // about two-thirds of sales would have to come without ads just to break even
  assert.ok(r.requiredShare > 0.6 && r.requiredShare < 0.7, `required share ${r.requiredShare}`);
  assert.equal(r.verdict, "FAIL"); // TEST at today's bids, FAIL once bids rise 30%
  assert.equal(r.steppedDown, true);
  assert.ok(r.breakEven > 0.45, `break-even conversion ${r.breakEven}`);
});

test("calibration: Tote is a TEST at a mature 10% conversion, a FAIL at its launch 3.8%", async () => {
  const cpc = weightedCpc((await fixture("tote-bids-2026-11-10.json")).keywords);
  assert.ok(cpc.mid > 0.7 && cpc.mid < 1.0, `Tote CPC ${cpc.mid}`);
  const mature = analyzeProduct(cpc, TOTE, { matureConversion: 0.10 });
  assert.ok(mature.requiredShare > 0.5 && mature.requiredShare < 0.55, `required share ${mature.requiredShare}`);
  assert.equal(mature.verdict, "TEST");
  assert.equal(mature.verdictCash, "PASS"); // it nearly covers its cash: stock already paid
  const launch = analyzeProduct(cpc, TOTE, { matureConversion: 0.038 });
  assert.ok(launch.requiredShare > 0.8);
  assert.equal(launch.verdict, "FAIL");
});

test("calibration: PHR's clicks cost about 3x the Tote's", async () => {
  const phr = weightedCpc((await fixture("phr-bids-2026-11-10.json")).keywords);
  const tote = weightedCpc((await fixture("tote-bids-2026-11-10.json")).keywords);
  assert.ok(phr.mid / tote.mid > 2.5 && phr.mid / tote.mid < 3.5);
});

test("calibration: Helium 10 bids × 1.8 land within 10% of Amazon's own quotes", async () => {
  for (const n of ["phr", "tote"]) {
    const amazon = weightedCpc((await fixture(`${n}-bids-2026-11-10.json`)).keywords).mid;
    const { cpc } = buildMarket(await fixture(`${n}-cerebro-2026-10-26.json`), []);
    assert.equal(cpc.calibration, BID_CALIBRATION.helium10);
    assert.ok(Math.abs(cpc.mid / amazon - 1) < 0.10, `${n}: Helium calibrated ${cpc.mid} vs Amazon ${amazon}`);
    assert.ok(cpc.raw.mid < cpc.mid);
  }
});

test("calibration: the keyword market — PHR is narrow and high-intent, the Tote wide and spread out", async () => {
  const refs = await loadReferences();
  const phr = refs.find((r) => r.key === "phr").market;
  const tote = refs.find((r) => r.key === "tote").market;
  assert.equal(phr.totalVolume, 439880);
  assert.equal(tote.totalVolume, 1356075);
  // most of PHR's top-50 volume is competitor brands or other products
  assert.ok(phr.winnableShare < 0.3, `PHR winnable ${phr.winnableShare}`);
  assert.ok(tote.winnableShare > 0.7, `Tote winnable ${tote.winnableShare}`);
  assert.ok(tote.winnableVolume / phr.winnableVolume > 8);
  // PHR searchers buy far more often per search; its sales sit with fewer products
  assert.ok(phr.salesPer100Searches / tote.salesPer100Searches > 3);
  assert.ok(phr.top3SalesShare > 4 * tote.top3SalesShare);
  // at its own conversion, PHR has no winnable keyword it can afford
  assert.equal(phr.affordableVolume, 0);
  assert.ok(phr.warnings.some((w) => /winnable/.test(w)));
});

test("tagKeywords: an explicit tag wins, a brand name tags brand, the rest are generic", () => {
  const t = tagKeywords([
    { phrase: "Pure Path glove" }, { phrase: "pet hair remover" },
    { phrase: "purepath wipes", tag: "other", tagReason: "wipes" }, { phrase: "glove", tag: "generic" },
  ], ["pure path", "PurePath "]);
  assert.deepEqual(t.map((k) => k.tag), ["brand", "generic", "other", "generic"]);
  assert.match(t[0].tagReason, /pure path/);
});

test("calibrate scales a known source, leaves an unknown one, and keeps the raw figures", () => {
  const c = calibrate({ low: 1, mid: 2, high: null, keywords: 9 }, "helium10");
  assert.deepEqual([c.low, c.mid, c.high, c.calibration], [1.8, 3.6, null, 1.8]);
  assert.deepEqual(c.raw, { low: 1, mid: 2, high: null });
  assert.equal(calibrate({ low: 1, mid: 2, high: 3 }, "Amazon Ads").mid, 2);
  assert.equal(calibrate({ low: 1, mid: 2, high: 3 }, undefined).calibration, 1);
});

test("keywordMarket: winnable volume, intent, spread and affordable volume", () => {
  const kws = [
    { phrase: "a", tag: "generic", searchVolume: 1000, keywordSales: 30, top3ConvShare: 0.5, bidMid: 1.0 },
    { phrase: "b", tag: "generic", searchVolume: 3000, keywordSales: 30, top3ConvShare: 0.1, bidMid: 0.4 },
    { phrase: "c", tag: "brand", searchVolume: 4000, keywordSales: 500, top3ConvShare: 0.9, bidMid: 0.1 },
    { phrase: "d", tag: "other", searchVolume: 2000, keywordSales: 9, top3ConvShare: 0.2, bidMid: 0.1 },
    { phrase: "e", tag: "generic", searchVolume: 1000, keywordSales: null, top3ConvShare: null, bidMid: null },
  ];
  const m = keywordMarket(kws, { affordableCpc: 1.0, calibration: 2 });
  assert.equal(m.totalVolume, 11000);
  assert.equal(m.winnableVolume, 5000);
  near(m.winnableShare, 5000 / 11000);
  assert.equal(m.brandVolume, 4000);
  assert.equal(m.otherVolume, 2000);
  near(m.salesPer100Searches, 1.5); // 60 sales on 4,000 searches; the unknown row is left out
  near(m.top3SalesShare, (1000 * 0.5 + 3000 * 0.1) / 4000);
  assert.equal(m.concentrated, false);
  // calibrated bids: a = $2.00 (too dear), b = $0.80 (affordable); e has no bid → not counted
  assert.equal(m.affordableVolume, 3000);
  assert.deepEqual(m.affordableKeywords, ["b"]);
  assert.equal(keywordMarket(kws).affordableVolume, null); // no affordable CPC given: unknown, not 0
});

test("weightedCpc weights by search volume", () => {
  const kws = [
    { searchVolume: 9000, bidLow: 1, bidMid: 1, bidHigh: 1 },
    { searchVolume: 1000, bidLow: 3, bidMid: 3, bidHigh: 3 },
    ...Array.from({ length: 3 }, () => ({ searchVolume: 0.0001, bidLow: 2, bidMid: 2, bidHigh: 2 })),
  ];
  near(weightedCpc(kws).mid, (9000 * 1 + 1000 * 3 + 0.0003 * 2) / 10000.0003);
  assert.equal(weightedCpc(kws).weighting, "search volume");
});

test("weightedCpc falls back to equal weights when any volume is missing, and says so", () => {
  const kws = [1, 2, 3, 4, 5].map((b) => ({ searchVolume: b === 3 ? null : 100, bidLow: b, bidMid: b, bidHigh: b }));
  near(weightedCpc(kws).mid, 3);
  assert.match(weightedCpc(kws).weighting, /equal/);
});

test("weightedCpc stops (throws) with too few bids — never guesses", () => {
  const kws = [{ bidMid: 1 }, { bidMid: null }, { bidMid: "" }, { bidMid: 2 }];
  assert.throws(() => weightedCpc(kws), /stop and ask/);
});

test("weightedCpc leaves low/high unknown when some rows lack them", () => {
  const kws = [1, 2, 3, 4, 5].map((b) => ({ searchVolume: 1, bidLow: b === 1 ? null : b, bidMid: b, bidHigh: b }));
  assert.equal(weightedCpc(kws).low, null);
  near(weightedCpc(kws).mid, 3);
});

test("breakEvenConversion = CPC ÷ money per sale; a losing sale needs infinite conversion", () => {
  near(breakEvenConversion(0.87, 9.8), 0.0888, 1e-4);
  assert.equal(breakEvenConversion(1, 0), Infinity);
  assert.equal(breakEvenConversion(1, -2), Infinity);
  assert.equal(breakEvenConversion(null, 5), null);
  assert.equal(breakEvenConversion(1, null), null);
});

test("requiredOrganicShare = 1 − (money per sale × conversion ÷ CPC)", () => {
  near(requiredOrganicShare(2, 5, 0.1), 0.75);
  assert.equal(requiredOrganicShare(0.4, 5, 0.1), 0); // ads alone pay: clamps at 0
  assert.equal(requiredOrganicShare(2, 0, 0.1), 1); // nothing left per sale: never
  assert.equal(requiredOrganicShare(2, -1, 0.1), 1);
  assert.equal(requiredOrganicShare(null, 5, 0.1), null);
  assert.equal(requiredOrganicShare(2, 5, 0), null);
  // a 10% target margin on a $20 item leaves $3 of the $5 for ads
  near(requiredOrganicShare(2, 5, 0.1, { targetMargin: 0.1, price: 20 }), 0.85);
  assert.equal(requiredOrganicShare(2, 5, 0.1, { targetMargin: 0.1 }), null); // price unknown
});

test("band edges are inclusive at the threshold", () => {
  assert.equal(band(THRESHOLDS.passShare), "PASS");
  assert.equal(band(THRESHOLDS.passShare + 1e-9), "TEST");
  assert.equal(band(THRESHOLDS.failShare), "TEST");
  assert.equal(band(THRESHOLDS.failShare + 1e-9), "FAIL");
  assert.equal(band(1), "FAIL");
  assert.equal(band(null), null);
});

test("verdict steps down one band when the stressed CPC crosses a line", () => {
  // share = 1 − 10×0.1/1.9 = 0.474 PASS; stressed 1 − 1/2.47 = 0.595 TEST → TEST
  const v = verdict(1.9, 10);
  assert.equal(v.verdict, "TEST");
  assert.equal(v.steppedDown, true);
  // share 0 stays PASS under stress
  assert.equal(verdict(0.5, 10).verdict, "PASS");
  // never raised: FAIL stays FAIL
  assert.equal(verdict(5, 10).verdict, "FAIL");
  assert.equal(verdict(null, 10).verdict, null);
});

test("payback: launch loss ÷ steady monthly profit; null when it never earns", () => {
  // m 10, CPC 1, mature 10% (launch 5%), 10 units/week, mature share 0.5, 2 weeks
  // week 1: share 0 → 10 × (10 − 1/0.05) = −100; week 2: share 0.5 → 10 × (10 − 0.5/0.05) = 0
  const r = payback(1, 10, 10, { weeks: 2 });
  near(r.launchLoss, 100);
  // steady: 10 × 52/12 × (10 − 0.5 × 1/0.1) = 216.67 a month
  near(r.steadyMonthlyProfit, 216.67, 0.01);
  near(r.paybackMonths, 0.5, 0.05);
  assert.equal(payback(5, 10, 10).paybackMonths, null); // steady profit negative
  assert.equal(payback(0.1, 10, 10).paybackMonths, 0); // no launch loss at all
  assert.equal(payback(1, null, 10), null);
});

test("a PASS with a launch that never pays back is lowered to TEST", () => {
  const cpc = { low: 1, mid: 1.9, high: 2 };
  const product = { asin: "X", price: 40, profitBeforePPC: 10.5, cashPerSale: 15 };
  const noLaunch = analyzeProduct(cpc, product, { stress: 1 });
  assert.equal(noLaunch.verdict, "PASS");
  const slow = analyzeProduct(cpc, product, { stress: 1, unitsPerWeek: 10, thresholds: { ...THRESHOLDS, paybackMonths: 0.01 } });
  assert.equal(slow.maturityVerdict, "PASS");
  assert.equal(slow.slowPayback, true);
  assert.equal(slow.verdict, "TEST");
});

test("scenario: expected ACoS, affordable CPC and margin after ads", () => {
  const s = scenario(1, { price: 20, profitBeforePPC: 8 }, 0.1, 0);
  near(s.expectedAcos, 0.5); // $10 per ad order on a $20 sale
  near(s.affordableCpc, 0.8);
  near(s.profitAfterAds, -2);
  near(s.marginAfterAds, -0.1);
});

test("scenario: sales not from ads dilute the ad cost per unit", () => {
  const s = scenario(1, { price: 20, profitBeforePPC: 8 }, 0.1, 0.5);
  near(s.adCostPerUnit, 5);
  near(s.profitAfterAds, 3);
});

test("scenario returns null rather than 0 on a missing input", () => {
  assert.equal(scenario(1, { price: 20, profitBeforePPC: null }, 0.1), null);
  assert.equal(scenario(1, { price: 20, profitBeforePPC: 8 }, 0), null);
});

test("lowestViablePrice: at that price the required share is exactly the pass line", () => {
  const p = lowestViablePrice(2.7, PHR, { matureConversion: 0.181 });
  const refPct = PHR.referralFee / PHR.price;
  const fixed = PHR.fulfillmentFee + PHR.landedCogs + PHR.inboundFee + PHR.storageFee + PHR.returnLoss;
  const profitAtP = p * (1 - refPct) - fixed;
  near(requiredOrganicShare(2.7, profitAtP, 0.181), THRESHOLDS.passShare, 2e-3);
  assert.ok(p > PHR.price, `PHR would need $${p}, above its $13.99`);
  assert.equal(lowestViablePrice(2.7, { ...PHR, fulfillmentFee: null }), null);
});

test("launchBurn: weekly spend, cash in, and the first week that breaks even", () => {
  const r = launchBurn(1, 10, 0.1, 10, [0, 0.5], 3);
  // week 1: 10 ad units → 100 clicks → $100 spend, $100 in → net 0 → breaks even in week 1
  near(r.byWeek[0].adSpend, 100);
  near(r.byWeek[0].net, 0);
  assert.equal(r.breakEvenWeek, 1);
  // weeks 2–3: half the units from ads → $50 spend → +$50 each
  near(r.total, 100);
  assert.equal(launchBurn(1, null, 0.1, 10, [0]), null);
});

test("main reads results.js + bids.json and writes ppc.js; refuses an old results.js", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ppc-"));
  const bids = await fixture("tote-bids-2026-11-10.json");
  await writeFile(join(dir, "bids.json"), JSON.stringify(bids));
  await writeFile(join(dir, "results.js"), "window.__FBA_DATA__ = " + JSON.stringify({ survivors: [TOTE], eliminated: [PHR] }) + ";");
  const d = await main(dir, "canvas tote bag", { unitsPerWeek: 20 });
  const written = await readFile(join(dir, "ppc.js"), "utf8");
  assert.ok(written.startsWith("window.__PPC_DATA__ = "));
  assert.equal(d.results.length, 2);
  // sorted by required share without ads, lowest first (same CPC: PHR's $5.20/sale beats Tote's $3.97)
  assert.deepEqual(d.results.map((r) => r.asin), ["PHR-1PC", "TOTE"]);
  assert.ok(d.results[0].requiredShare <= d.results[1].requiredShare);
  assert.equal(d.bestAsin, "PHR-1PC");
  assert.equal(d.matureConversion, 0.10);
  assert.match(d.matureConversionSource, /assumption/);
  assert.equal(d.results[0].payback.byWeek.length, 12);
  assert.equal(d.cpc.calibration, 1); // Amazon's own bids need no scaling
  assert.equal(d.results[0].market.winnableVolume, 0); // this export has no search volumes
  assert.deepEqual(d.references.map((r) => r.key), ["phr", "tote"]);
  assert.ok(d.keywords.every((k) => k.tag === "generic"));
  assert.equal(d.thresholdsProvisional, true);
  assert.equal(d.results[0].launchCash.byWeek.length, 12);

  await writeFile(join(dir, "results.js"), "window.__FBA_DATA__ = " + JSON.stringify({ survivors: [{ asin: "OLD", price: 20, netProfitAfterPPC: 3 }] }) + ";");
  await assert.rejects(() => main(dir, "x"), /old cost skill/);
  await rm(dir, { recursive: true, force: true });
});
