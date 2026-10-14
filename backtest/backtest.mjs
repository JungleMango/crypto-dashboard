#!/usr/bin/env node
// Replays the dashboard's signals (Trend, Adaptive Trend, OI/Price, Order Flow) over Binance USD-M futures
// history and measures what price did after each one. Uses the exact indicator code from
// ../indicators.js, and Binance's public data archive (data.binance.vision), which has OI history
// going back years — unlike the live openInterestHist endpoint's ~30 days.
//
//   node backtest/backtest.mjs --symbols BTCUSDT,ETHUSDT --tf 1h --days 180
//
// Writes to backtest/results/<tf>/:
//   events.csv   one row per signal flip, with the indicator inputs and forward returns
//   bars.csv     every bar's readings + forward returns (for deeper analysis / tuning)
//   summary.csv  per signal value: count, avg forward return, win rate, vs. the do-nothing baseline
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Indicators = require("../indicators.js");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE = "https://data.binance.vision/data/futures/um";
const DAY = 86400000;
const TF_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "4h": 14400e3, "1d": DAY };
const OI_WINDOW = 24;            // matches CANDLE_COUNT in index.html: OI/Price compares the first and last of 24 bars
const WARMUP_BARS = 200;         // matches KLINE_FETCH_LIMIT: history the dashboard feeds the trend indicators
const HORIZONS = [1, 4, 12, 24]; // forward-return horizons, in bars
const EXCURSION_BARS = 24;       // window for max favourable / adverse excursion

// ---------- args ----------
function parseArgs(argv) {
  const a = { symbols: "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT", tf: "1h", days: 180, trendPreset: "default", adaptivePreset: "default", out: path.join(HERE, "results") };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--symbols") { a.symbols = v; i++; }
    else if (k === "--tf") { a.tf = v; i++; }
    else if (k === "--days") { a.days = parseInt(v, 10); i++; }
    else if (k === "--trend-preset") { a.trendPreset = v; i++; }
    else if (k === "--adaptive-preset") { a.adaptivePreset = v; i++; }
    else if (k === "--out") { a.out = v; i++; }
    else if (k === "--help" || k === "-h") { a.help = true; }
    else throw new Error("unknown argument: " + k);
  }
  a.symbols = a.symbols.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).map(s => /USDT$/.test(s) ? s : s + "USDT");
  if (!TF_MS[a.tf]) throw new Error("--tf must be one of " + Object.keys(TF_MS).join(", "));
  if (!Indicators.TREND_PRESETS[a.trendPreset]) throw new Error("--trend-preset must be one of " + Object.keys(Indicators.TREND_PRESETS).join(", "));
  if (!Indicators.ADAPTIVE_PRESETS[a.adaptivePreset]) throw new Error("--adaptive-preset must be one of " + Object.keys(Indicators.ADAPTIVE_PRESETS).join(", "));
  if (!(a.days > 0)) throw new Error("--days must be a positive number");
  return a;
}

// ---------- download + cache ----------
const CACHE = path.join(HERE, ".cache");

// Archive files are single-entry zips; read the entry via the central directory and inflate it.
function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const csize = buf.readUInt32LE(cd + 20);
  const lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csize);
  return (method === 0 ? data : zlib.inflateRawSync(data)).toString("utf8");
}

// Returns the CSV text, or null when the archive has no such file (not published yet / before listing).
async function fetchArchiveCsv(relPath) {
  const cacheFile = path.join(CACHE, relPath);
  if (fs.existsSync(cacheFile)) return unzipFirst(fs.readFileSync(cacheFile));
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(ARCHIVE + "/" + relPath);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const text = unzipFirst(buf);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, buf);
      return text;
    } catch (e) {
      if (attempt >= 4) throw new Error(relPath + ": " + e.message);
      await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

function csvRows(text) {
  if (!text) return [];
  return text.trim().split(/\r?\n/).filter(l => /^\d/.test(l)).map(l => l.split(",")); // skips header rows
}

const ymd = t => new Date(t).toISOString().slice(0, 10);
const ym = t => new Date(t).toISOString().slice(0, 7);
function daysBetween(start, end) { const out = []; for (let t = start; t <= end; t += DAY) out.push(t); return out; }
function monthsBetween(start, end) {
  const out = [], d = new Date(start); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() <= end) { out.push(d.getTime()); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

// Monthly files for finished months, daily files for the current month (the archive lags ~1-2 days).
async function loadKlines(sym, tf, start, end) {
  const thisMonth = ym(Date.now());
  const paths = [];
  for (const m of monthsBetween(start, end)) {
    if (ym(m) !== thisMonth) paths.push(`monthly/klines/${sym}/${tf}/${sym}-${tf}-${ym(m)}.zip`);
    else for (const d of daysBetween(Math.max(m, start), end)) paths.push(`daily/klines/${sym}/${tf}/${sym}-${tf}-${ymd(d)}.zip`);
  }
  const texts = await mapPool(paths, 6, fetchArchiveCsv);
  const byTime = new Map();
  for (const text of texts) for (const r of csvRows(text)) {
    const t = +r[0];
    if (t < start || t > end + DAY) continue;
    byTime.set(t, { t, o: +r[1], h: +r[2], l: +r[3], c: +r[4], qv: +r[7], closeTime: +r[6], takerBuyQv: +r[10] });
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

async function loadMetrics(sym, start, end) {
  const paths = daysBetween(start, end).map(d => `daily/metrics/${sym}/${sym}-metrics-${ymd(d)}.zip`);
  const texts = await mapPool(paths, 8, fetchArchiveCsv);
  const rows = [];
  for (const text of texts) for (const r of csvRows(text)) {
    rows.push({ t: Date.parse(r[0].replace(" ", "T") + "Z"), oi: +r[2], topTraderLs: +r[5], takerLs: +r[7] });
  }
  return rows.sort((a, b) => a.t - b.t);
}

async function loadFunding(sym, start, end) {
  const paths = monthsBetween(start, end).map(m => `monthly/fundingRate/${sym}/${sym}-fundingRate-${ym(m)}.zip`);
  const texts = await mapPool(paths, 4, fetchArchiveCsv);
  const rows = [];
  for (const text of texts) for (const r of csvRows(text)) rows.push({ t: +r[0], rate: +r[2] });
  // The archive only publishes funding per finished month, so top up recent prints from the live API.
  const after = rows.length ? rows[rows.length - 1].t + 1 : start;
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${after}&limit=1000`);
    if (r.ok) for (const f of await r.json()) rows.push({ t: f.fundingTime, rate: +f.fundingRate });
  } catch (e) { /* live API unreachable (e.g. geo-blocked) — recent bars just have no funding value */ }
  return rows.sort((a, b) => a.t - b.t);
}

// For each candle, the latest row (from a time-sorted array) at or before the candle's close.
function alignAsOf(candles, rows, maxAgeMs) {
  const out = new Array(candles.length);
  let j = -1;
  for (let i = 0; i < candles.length; i++) {
    const at = candles[i].closeTime + 1;
    while (j + 1 < rows.length && rows[j + 1].t <= at) j++;
    out[i] = j >= 0 && at - rows[j].t <= maxAgeMs ? rows[j] : null;
  }
  return out;
}

// ---------- signals + outcomes ----------
const TREND_LABEL = { 1: "BULLISH", 0: "NEUTRAL", "-1": "BEARISH" };
const DIRECTION = Indicators.SIGNAL_DIRECTION;
const SIGNALS = Object.keys(DIRECTION);

function analyzeSymbol(sym, tf, candles, metrics, funding, analysisStart, cfg) {
  const closes = candles.map(c => c.c);
  const trend = Indicators.computeTrendSeries(closes, Indicators.TREND_PRESETS[cfg.trendPreset]);
  const adaptive = Indicators.computeAdaptiveTrend(closes, Indicators.ADAPTIVE_PRESETS[cfg.adaptivePreset]);
  const flow = Indicators.computeOrderFlow(closes, candles.map(c => c.qv), candles.map(c => c.takerBuyQv), Indicators.ORDER_FLOW_CONFIG);
  const metricAt = alignAsOf(candles, metrics, Math.max(TF_MS[tf], 15 * 60e3));
  const fundingAt = alignAsOf(candles, funding, 9 * 3600e3);
  const n = candles.length;

  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    let oiLabel = "Not enough data", oiChangePct = null;
    if (i >= OI_WINDOW - 1) {
      const win = candles.slice(i - OI_WINDOW + 1, i + 1);
      const oiWin = metricAt.slice(i - OI_WINDOW + 1, i + 1);
      if (oiWin[0] && oiWin[OI_WINDOW - 1]) {
        oiLabel = Indicators.classifyOiPriceSignal(win, [oiWin[0], oiWin[OI_WINDOW - 1]]).label;
        oiChangePct = (oiWin[OI_WINDOW - 1].oi / oiWin[0].oi - 1) * 100;
      }
    }
    let rvol = null;
    if (i >= OI_WINDOW) {
      let s = 0; for (let k = i - OI_WINDOW; k < i; k++) s += candles[k].qv;
      rvol = s > 0 ? c.qv / (s / OI_WINDOW) : null;
    }
    const fwd = {};
    for (const h of HORIZONS) fwd["ret_" + h] = i + h < n ? (closes[i + h] / c.c - 1) * 100 : null;
    let mfeUp = null, mfeDown = null;
    if (i + EXCURSION_BARS < n) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i + 1; k <= i + EXCURSION_BARS; k++) { hi = Math.max(hi, candles[k].h); lo = Math.min(lo, candles[k].l); }
      mfeUp = (hi / c.c - 1) * 100; mfeDown = (lo / c.c - 1) * 100;
    }
    const m = metricAt[i], f = fundingAt[i];
    bars.push({
      time: new Date(c.closeTime + 1).toISOString(), symbol: sym, tf, idx: i, close: c.c,
      trend: TREND_LABEL[trend.trendDirArr[i]], trend_consensus: trend.consensusArr[i], trend_conviction: trend.convictionArr[i],
      adaptive: adaptive.stateArr[i],
      adaptive_spread_pct: (adaptive.ribbonFast[i] / adaptive.ribbonSlow[i] - 1) * 100,
      kinetic_dist_pct: (c.c / adaptive.kinetic[i] - 1) * 100,
      oi_price: oiLabel,
      price_change_pct: i >= OI_WINDOW - 1 ? (c.c / closes[i - OI_WINDOW + 1] - 1) * 100 : null,
      oi_change_pct: oiChangePct,
      order_flow: flow.stateArr[i] || "Not enough data",
      flow_z: flow.zArr[i],
      flow_buy_share_pct: flow.flowArr[i] === null ? null : (flow.flowArr[i] + 1) / 2 * 100,
      open_interest: m ? m.oi : null,
      funding_rate_pct: f ? f.rate * 100 : null,
      top_trader_ls_ratio: m ? m.topTraderLs : null,
      taker_ls_ratio: m ? m.takerLs : null,
      taker_buy_share: c.qv ? c.takerBuyQv / c.qv : null,
      rvol,
      ...fwd,
      max_up_24: mfeUp, max_down_24: mfeDown
    });
  }

  // Signal flips inside the analysis window, with how long each lasted and what it returned while held.
  const events = [];
  for (const sig of SIGNALS) {
    for (let i = 1; i < n; i++) {
      if (candles[i].t < analysisStart) continue;
      const v = bars[i][sig], prev = bars[i - 1][sig];
      if (v === prev || v === "Not enough data") continue;
      let j = i + 1;
      while (j < n && bars[j][sig] === v) j++;
      const ended = j < n;
      const dir = DIRECTION[sig][v];
      const b = bars[i];
      events.push({
        ...b, signal: sig, value: v, prev_value: prev, direction: dir,
        bars_held: ended ? j - i : null,
        ret_held: ended ? (closes[j] / b.close - 1) * 100 : null,
        favourable_24: b.max_up_24 === null ? null : dir === 1 ? b.max_up_24 : dir === -1 ? -b.max_down_24 : null,
        adverse_24: b.max_up_24 === null ? null : dir === 1 ? b.max_down_24 : dir === -1 ? -b.max_up_24 : null
      });
    }
  }
  return { bars: bars.filter(b => candles[b.idx].t >= analysisStart), events };
}

// ---------- reporting ----------
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const vals = (rows, k) => rows.map(r => r[k]).filter(x => x !== null && x !== undefined && !Number.isNaN(x));

function summarize(events, bars) {
  const out = [];
  const base = { signal: "baseline", value: "(every bar)", direction: 0, n: bars.length };
  for (const h of HORIZONS) { base["avg_ret_" + h] = mean(vals(bars, "ret_" + h)); base["win_" + h] = null; }
  base.edge_24 = null; base.median_bars_held = null; base.avg_ret_held = null; base.win_held = null;
  out.push(base);
  const baseRet24 = base.avg_ret_24;
  for (const sig of SIGNALS) {
    for (const v of Object.keys(DIRECTION[sig])) {
      const rows = events.filter(e => e.signal === sig && e.value === v);
      if (!rows.length) continue;
      const dir = DIRECTION[sig][v];
      const s = { signal: sig, value: v, direction: dir, n: rows.length };
      for (const h of HORIZONS) {
        const r = vals(rows, "ret_" + h);
        s["avg_ret_" + h] = mean(r);
        s["win_" + h] = dir && r.length ? r.filter(x => x * dir > 0).length / r.length * 100 : null;
      }
      // Edge = how much better the signal did than just holding over the same horizon, in its own direction.
      s.edge_24 = dir && s.avg_ret_24 !== null ? dir * (s.avg_ret_24 - baseRet24) : null;
      s.median_bars_held = median(vals(rows, "bars_held"));
      const held = vals(rows, "ret_held");
      s.avg_ret_held = mean(held);
      s.win_held = dir && held.length ? held.filter(x => x * dir > 0).length / held.length * 100 : null;
      out.push(s);
    }
  }
  return out;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = v => v === null || v === undefined ? "" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(6)) : /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  return cols.join(",") + "\n" + rows.map(r => cols.map(c => cell(r[c])).join(",")).join("\n") + "\n";
}

function printSummary(summary, tf) {
  const pct = v => v === null || v === undefined ? "    —" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  const rate = v => v === null || v === undefined ? "   —" : v.toFixed(0).padStart(3) + "%";
  console.log(`\nForward returns after each signal flip (${tf} bars; averages across all symbols)`);
  console.log("signal     value                  n   ret+1   ret+4  ret+12  ret+24  win+24  edge+24  held(bars)  held ret  win held");
  for (const s of summary) {
    console.log(
      s.signal.slice(0, 10).padEnd(10) + " " + String(s.value).padEnd(18) + String(s.n).padStart(6) + "  " +
      HORIZONS.map(h => pct(s["avg_ret_" + h]).padStart(6)).join("  ") + "  " + rate(s.win_24).padStart(6) + "  " +
      pct(s.edge_24).padStart(7) + "  " + (s.median_bars_held === null ? "—" : String(s.median_bars_held)).padStart(10) + "  " +
      pct(s.avg_ret_held).padStart(8) + "  " + rate(s.win_held).padStart(8) +
      (s.n < 30 && s.signal !== "baseline" ? "   (small sample)" : "")
    );
  }
  console.log("\nwin = % of flips where price moved in the signal's direction; edge = direction-adjusted return minus the baseline drift.");
}

// ---------- main ----------
async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.help) {
    console.log("usage: node backtest/backtest.mjs [--symbols BTCUSDT,ETHUSDT] [--tf 1h] [--days 180] [--trend-preset default|fast|smooth] [--adaptive-preset default|fast|smooth] [--out dir]");
    return;
  }
  const tfMs = TF_MS[cfg.tf];
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const end = today - DAY; // last day the archive could have published
  const analysisStart = end - cfg.days * DAY;
  const klineStart = analysisStart - Math.ceil(WARMUP_BARS * tfMs / DAY) * DAY;
  const metricStart = analysisStart - Math.ceil(OI_WINDOW * tfMs / DAY) * DAY - DAY;
  console.log(`Backtesting ${cfg.symbols.join(", ")} on ${cfg.tf} from ${ymd(analysisStart)} to ${ymd(end)} (trend preset: ${cfg.trendPreset}, adaptive preset: ${cfg.adaptivePreset})`);

  const allBars = [], allEvents = [];
  for (const sym of cfg.symbols) {
    process.stdout.write(`  ${sym}: downloading… `);
    const [candles, metrics, funding] = await Promise.all([
      loadKlines(sym, cfg.tf, klineStart, end),
      loadMetrics(sym, metricStart, end),
      loadFunding(sym, analysisStart, end)
    ]);
    if (candles.length < WARMUP_BARS) { console.log(`only ${candles.length} candles in the archive, skipping`); continue; }
    const { bars, events } = analyzeSymbol(sym, cfg.tf, candles, metrics, funding, analysisStart, cfg);
    allBars.push(...bars); allEvents.push(...events);
    console.log(`${candles.length} candles, ${metrics.length} OI points, ${funding.length} funding prints → ${events.length} signal flips`);
  }
  if (!allBars.length) { console.log("No data — check the symbols and timeframe."); process.exitCode = 1; return; }

  const outDir = path.join(cfg.out, cfg.tf);
  fs.mkdirSync(outDir, { recursive: true });
  allEvents.sort((a, b) => a.time.localeCompare(b.time) || a.symbol.localeCompare(b.symbol));
  const summary = summarize(allEvents, allBars);
  fs.writeFileSync(path.join(outDir, "events.csv"), toCsv(allEvents.map(({ idx, ...e }) => e)));
  fs.writeFileSync(path.join(outDir, "bars.csv"), toCsv(allBars.map(({ idx, ...b }) => b)));
  fs.writeFileSync(path.join(outDir, "summary.csv"), toCsv(summary));
  printSummary(summary, cfg.tf);
  console.log(`\nWrote ${path.relative(process.cwd(), outDir)}/{events,bars,summary}.csv`);
}

main().catch(e => { console.error(e.message || e); process.exitCode = 1; });
