// Indicator math shared by the dashboard (index.html) and the backtest (backtest/backtest.mjs).
// Pure functions only — no DOM, no fetching — so both sides compute identical signals.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Indicators = api;
})(this, function () {
  "use strict";

  // Port of the "Trend" Pine Script indicator (multi-timescale Spearman rank-correlation consensus).
  // Each preset mirrors the script's own preset overrides exactly.
  var TREND_PRESETS = {
    "default": {
      label: "Default",
      windows: [{ enabled: true, len: 8 }, { enabled: true, len: 13 }, { enabled: true, len: 21 }, { enabled: true, len: 34 }],
      threshold: 0.35, minConviction: 60
    },
    "fast": {
      label: "Fast Response",
      windows: [{ enabled: true, len: 5 }, { enabled: true, len: 8 }, { enabled: true, len: 13 }, { enabled: true, len: 21 }],
      threshold: 0.25, minConviction: 50
    },
    "smooth": {
      label: "Smooth Trend",
      windows: [{ enabled: true, len: 21 }, { enabled: true, len: 34 }, { enabled: true, len: 55 }, { enabled: true, len: 89 }],
      threshold: 0.45, minConviction: 75
    }
  };

  function spearmanRho(s, len) {
    var sumd2 = 0;
    for (var i = 0; i < len; i++) {
      var pi = s[i], less = 0, eq = 0;
      for (var j = 0; j < len; j++) {
        var pj = s[j];
        if (pj < pi) less++; else if (pj === pi) eq++;
      }
      var priceRank = less + (eq + 1) / 2;
      var timeRank = len - i;
      var d = priceRank - timeRank;
      sumd2 += d * d;
    }
    var denom = len * len * len - len;
    var rho = denom > 0 ? 1 - 6 * sumd2 / denom : 0;
    return Math.max(-1, Math.min(1, rho));
  }
  function windowRho(closes, idx, len) {
    if (idx < len) return null; // mirrors the script's own `bar_index >= len` gate, one bar more conservative than strictly needed
    var slice = new Array(len);
    for (var i = 0; i < len; i++) slice[i] = closes[idx - i];
    return spearmanRho(slice, len);
  }
  function computeTrendSeries(closes, cfg) {
    var n = closes.length;
    var consensusArr = new Array(n), convictionArr = new Array(n), trendDirArr = new Array(n);
    var trendDir = 0;
    for (var idx = 0; idx < n; idx++) {
      var rhos = [];
      for (var w = 0; w < cfg.windows.length; w++) {
        var win = cfg.windows[w];
        if (!win.enabled) continue;
        var r = windowRho(closes, idx, win.len);
        if (r !== null) rhos.push(r);
      }
      var consensus = 0, conviction = 0, rawState = 0;
      if (rhos.length > 0) {
        var sum = 0; for (var k = 0; k < rhos.length; k++) sum += rhos[k];
        consensus = sum / rhos.length;
        var sgn = consensus >= 0 ? 1 : -1, agree = 0;
        for (k = 0; k < rhos.length; k++) { if ((rhos[k] >= 0 ? 1 : -1) === sgn) agree++; }
        conviction = 100 * agree / rhos.length;
        if (consensus > cfg.threshold && conviction >= cfg.minConviction) rawState = 1;
        else if (consensus < -cfg.threshold && conviction >= cfg.minConviction) rawState = -1;
      }
      trendDir = rawState !== 0 ? rawState : 0; // show_neutral = true (the script's default)
      consensusArr[idx] = consensus;
      convictionArr[idx] = conviction;
      trendDirArr[idx] = trendDir;
    }
    return { consensusArr: consensusArr, convictionArr: convictionArr, trendDirArr: trendDirArr };
  }

  // Port of the "Adaptive Trend [Test 3]" Pine Script. All three shipped presets use
  // ma_type = "EMA", so only EMA is implemented here (matches how the app exposes presets
  // rather than the raw length/mult/fast/slow/ma_type controls).
  var ADAPTIVE_PRESETS = {
    "default": { label: "Default", length: 20, mult: 1.5, fast: 3, slow: 8 },
    "fast": { label: "Fast Response", length: 12, mult: 1.0, fast: 2, slow: 5 },
    "smooth": { label: "Smooth Trend", length: 30, mult: 2.0, fast: 5, slow: 13 }
  };

  function stdevPop(arr) {
    var n = arr.length;
    if (n === 0) return 0;
    var mean = 0;
    for (var i = 0; i < n; i++) mean += arr[i];
    mean /= n;
    var sumSq = 0;
    for (i = 0; i < n; i++) { var d = arr[i] - mean; sumSq += d * d; }
    return Math.sqrt(sumSq / n);
  }

  // Kaufman-style adaptive filter: alpha rises when net directional movement ("velocity") over the
  // lookback is large relative to bar-to-bar volatility, so the line hugs price in a clean trend and
  // lags heavily during chop. Mirrors the script's `kinetic_line` exactly (recursive, seeded at source).
  function computeAdaptiveKinetic(values, length, mult) {
    var n = values.length;
    var kinetic = new Array(n);
    kinetic[0] = values[0];
    for (var i = 1; i < n; i++) {
      if (i < length) {
        // Not enough history for a full lookback window yet (Pine would show na too) — holding at
        // source is a harmless stand-in for these warm-up bars, which sit far before the bars we read.
        kinetic[i] = values[i];
        continue;
      }
      var velocity = values[i] - values[i - length];
      var diffs = new Array(length);
      for (var k = 0; k < length; k++) {
        var idx = i - length + 1 + k;
        diffs[k] = values[idx] - values[idx - 1];
      }
      var volatility = stdevPop(diffs) * mult;
      var denom = Math.abs(velocity) + volatility;
      var alpha = denom === 0 ? 0 : Math.abs(velocity) / denom;
      kinetic[i] = kinetic[i - 1] + alpha * (values[i] - kinetic[i - 1]);
    }
    return kinetic;
  }

  function emaArr(values, len) {
    var n = values.length, out = new Array(n);
    var alpha = 2 / (len + 1);
    out[0] = values[0];
    for (var i = 1; i < n; i++) out[i] = out[i - 1] + alpha * (values[i] - out[i - 1]);
    return out;
  }

  // ribbon_fast/ribbon_slow are EMAs of the kinetic line; trend_up = fast>slow, acceleration =
  // fast rising. The 4 combined states mirror the script's ribbonColor branches exactly:
  //   trend_up && accel      -> bull_accel (strongest bullish, momentum building)
  //   trend_up && !accel     -> bull_decel (still up, but momentum fading)
  //   !trend_up && !accel    -> bear_accel (strongest bearish, momentum building)
  //   !trend_up && accel     -> bear_decel (still down, but momentum fading)
  function computeAdaptiveTrend(closes, cfg) {
    var kinetic = computeAdaptiveKinetic(closes, cfg.length, cfg.mult);
    var ribbonFast = emaArr(kinetic, cfg.fast);
    var ribbonSlow = emaArr(kinetic, cfg.slow);
    var n = closes.length;
    var stateArr = new Array(n);
    for (var i = 0; i < n; i++) {
      var trendUp = ribbonFast[i] > ribbonSlow[i];
      var accel = i > 0 ? ribbonFast[i] > ribbonFast[i - 1] : true;
      stateArr[i] = trendUp ? (accel ? "bull_accel" : "bull_decel") : (accel ? "bear_decel" : "bear_accel");
    }
    return { kinetic: kinetic, ribbonFast: ribbonFast, ribbonSlow: ribbonSlow, stateArr: stateArr };
  }

  // Classic OI-vs-price read: does open interest confirm the price move (new positions opening)
  // or contradict it (positions closing, i.e. covering/liquidation)?
  //   OI up   + price up   -> new longs opening      (confirmed bullish move)
  //   OI up   + price down -> new shorts opening      (confirmed bearish move)
  //   OI down + price up   -> short covering          (rally driven by exits, more fragile)
  //   OI down + price down -> long liquidation        (decline driven by exits, more fragile)
  function classifyOiPriceSignal(candles, oiHist) {
    if (!candles || candles.length < 2 || !oiHist || oiHist.length < 2) {
      return { label: "Not enough data", cls: "neutral", arrow: "●" };
    }
    var priceUp = candles[candles.length - 1].c >= candles[0].c;
    var oiUp = oiHist[oiHist.length - 1].oi >= oiHist[0].oi;
    if (oiUp && priceUp) return { label: "New Longs", cls: "good", arrow: "▲" };
    if (oiUp && !priceUp) return { label: "New Shorts", cls: "critical", arrow: "▼" };
    if (!oiUp && priceUp) return { label: "Short Covering", cls: "warning", arrow: "▲" };
    return { label: "Long Liquidation", cls: "warning", arrow: "▼" };
  }

  // Order-flow pressure: who is crossing the spread. Binance candles carry taker-buy volume, so
  // taker-sell = total - taker-buy and flow = (buy - sell) / total over `window` candles (-1..+1).
  // Flow is then z-scored against its own last `lookback` readings, because the resting buy/sell
  // balance differs per coin; |z| >= threshold means unusually one-sided aggression. Comparing that
  // with the price move over the same window separates pressure that is already moving price from
  // pressure building against the move (buying a dip / selling a rally).
  var ORDER_FLOW_CONFIG = { window: 20, lookback: 100, threshold: 1.0 };

  function computeOrderFlow(closes, quoteVols, takerBuyVols, cfg) {
    var n = closes.length, W = cfg.window, L = cfg.lookback;
    var flowArr = new Array(n), zArr = new Array(n), stateArr = new Array(n);
    var sumVol = 0, sumDelta = 0;
    for (var i = 0; i < n; i++) {
      sumVol += quoteVols[i];
      sumDelta += 2 * takerBuyVols[i] - quoteVols[i];
      if (i >= W) {
        sumVol -= quoteVols[i - W];
        sumDelta -= 2 * takerBuyVols[i - W] - quoteVols[i - W];
      }
      flowArr[i] = i >= W - 1 && sumVol > 0 ? sumDelta / sumVol : null;
    }
    for (i = 0; i < n; i++) {
      zArr[i] = null; stateArr[i] = null;
      if (i < W - 1 + L - 1 || flowArr[i] === null) continue;
      var hist = [];
      for (var k = i - L + 1; k <= i; k++) if (flowArr[k] !== null) hist.push(flowArr[k]);
      var mean = 0;
      for (k = 0; k < hist.length; k++) mean += hist[k];
      mean /= hist.length;
      var sd = stdevPop(hist);
      var z = sd > 0 ? (flowArr[i] - mean) / sd : 0;
      var priceUp = closes[i] >= closes[i - W + 1];
      zArr[i] = z;
      if (z >= cfg.threshold) stateArr[i] = priceUp ? "buyers" : "buying_dip";
      else if (z <= -cfg.threshold) stateArr[i] = priceUp ? "selling_rally" : "sellers";
      else stateArr[i] = "balanced";
    }
    return { flowArr: flowArr, zArr: zArr, stateArr: stateArr };
  }

  // Which way each signal value points (+1 up, -1 down, 0 none) — used to score signals by
  // whether price then moved the way they said. Short Covering / Long Liquidation follow their
  // price arrow, even though the dashboard flags them as the more fragile variants.
  var SIGNAL_DIRECTION = {
    trend: { BULLISH: 1, NEUTRAL: 0, BEARISH: -1 },
    adaptive: { bull_accel: 1, bull_decel: 1, bear_decel: -1, bear_accel: -1 },
    oi_price: { "New Longs": 1, "Short Covering": 1, "New Shorts": -1, "Long Liquidation": -1 },
    // Flow leads: heavy buying into a falling price was followed by rises in the backtest (6 coins,
    // 1h, 180 days), not by the further fall an "absorption" reading would predict — so all
    // states point the way of the aggressive flow.
    order_flow: { buyers: 1, buying_dip: 1, balanced: 0, selling_rally: -1, sellers: -1 }
  };

  return {
    SIGNAL_DIRECTION: SIGNAL_DIRECTION,
    TREND_PRESETS: TREND_PRESETS,
    ADAPTIVE_PRESETS: ADAPTIVE_PRESETS,
    computeTrendSeries: computeTrendSeries,
    computeAdaptiveTrend: computeAdaptiveTrend,
    classifyOiPriceSignal: classifyOiPriceSignal,
    ORDER_FLOW_CONFIG: ORDER_FLOW_CONFIG,
    computeOrderFlow: computeOrderFlow
  };
});
