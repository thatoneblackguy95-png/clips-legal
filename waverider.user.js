// ==UserScript==
// @name         WaveRider — TradingView Paper Trading Injector
// @namespace    https://muse.ai/waverider
// @version      1.1.0
// @description  Autonomous wave-riding scalper for TradingView PAPER trading only. Tiered equity risk management: safe start/recovery mode, profit tiers that unlock bigger sizing as equity grows, checkpoint ratchets that drop back to safe on drawdown. NEVER touches real money — refuses to run unless the Paper Trading account is active.
// @author       Icarus for Travis
// @match        https://www.tradingview.com/chart/*
// @grant        none
// @run-at       document-idle
// @license      Private — single-user use
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * WaveRider v1.1.0 — TradingView PAPER trading injector
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT DOES
 *   Sits on the TradingView chart, reads the live bid/ask from the paper
 *   trading order ticket every 500ms, builds price bars, and trades waves:
 *     • Wave entry      — EMA9 crosses EMA21 with conviction ≥ tier bar
 *     • Predictive      — wave forming (acceleration + 5m agreement + ATR
 *                         expansion), conviction ≥ tier bar → enter early
 *     • Pyramid         — leg is +0.5R, bias still with us, momentum still
 *                         accelerating, higher highs → ADD (chain buys up)
 *     • Peak exit       — +1R and momentum decelerating hard → exit at top
 *     • Scale-out       — wave weakening while green → sell half down the drop
 *     • Pre-loss cut    — red AND momentum against us → cut before it grows
 *     • Wave dead       — bias flipped → exit immediately
 *     • Catastrophe stop— price hits 1.5×ATR stop → market out, no questions
 *     • Day kill        — equity −20% from session start → HALT everything
 *
 * TIERED EQUITY RISK MANAGEMENT (sits on top of the wave engine)
 *   START/RECOVERY (equity < $200): SAFE — max 25% notional, conviction ≥ 60.
 *     Safety comes from FAST EXITS (tight stops, instant cuts), not from
 *     avoiding trades: it fires constantly and pyramids winners to reach
 *     $200 as fast as possible without a deep drawdown.
 *   Tier 1 (equity ≥ $200):  max 50% notional,  conviction ≥ 60
 *   Tier 2 (equity ≥ $400):  max 80% notional,  conviction ≥ 50
 *   Tier 3 (equity ≥ $800):  max 100% notional, conviction ≥ 40
 *   Tier 4+ (every 2x):      max 100% notional,  conviction −5/tier (floor 30)
 *   CHECKPOINTS: each tier threshold reached becomes a checkpoint (ratchet —
 *   only moves up). Drop 20% below the checkpoint → back to SAFE MODE until
 *   equity recovers above it. Never gives back the gains.
 *
 * LEVERAGE & SIZING (10x)
 *   The quantity field is USD MARGIN. Position notional = margin × 10.
 *   The tier cap overrides the conviction-band sizing: effective notional =
 *   min(band fraction, tier cap). Margin = notional × equity / leverage.
 *   Pyramid adds are 50% of the initial leg, up to 4 legs per wave, and
 *   respect the same tier notional cap.
 *   Winners compound: every exit recalculates size from the NEW equity.
 *
 * SAFETY
 *   • PAPER ONLY. On Start, the script verifies the active account looks
 *     like Paper Trading. If it cannot confirm paper, it REFUSES to start.
 *   • One order per 3 seconds max. Buttons re-render ~1/sec — every DOM
 *     access re-queries, nothing is cached across ticks.
 *   • Stop halts the loop immediately. The −20% kill switch flattens and
 *     locks the script until you reload the page.
 *
 * INSTALL
 *   1. Install Tampermonkey (Chrome/Edge/Brave extension).
 *   2. Tampermonkey icon → "Create a new script" → delete the template →
 *      paste this entire file → Ctrl+S.
 *   3. On TradingView: set the symbol's leverage to 10x in the paper
 *      trading ticket, and confirm the account says "Paper Trading".
 *   4. Refresh the chart. The dark WaveRider panel appears top-left.
 *   5. Click START. Click STOP any time to halt (does not close positions —
 *      close those in the panel yourself, or use PANIC FLATTEN).
 */

'use strict';

/* ───────────────────────── configuration ───────────────────────── */

const CFG = {
  tickMs: 500,              // price sample cadence
  leverage: 10,             // must match the ticket's leverage setting
  startEquity: 100,         // session start equity (USD)

  // signal TFAs (built from 10s base bars)
  sigBarSecs: 60,           // 1-minute signal bars
  agreeBarSecs: 300,        // 5-minute agreement bars
  emaFast: 9,
  emaSlow: 21,
  atrPeriod: 14,

  // entries
  scoreEnter: 40,           // reactive wave entry bar
  scorePredict: 55,         // predictive (pre-cross) entry bar
  volDeadAtrFrac: 0.0005,    // skip when ATR/price below this (10x: thin is OK)

  // conviction → notional sizing (fraction of equity)
  bandHi:  [80, 0.80, 0.80],  // score, minNotional, maxNotional
  bandMid: [60, 0.25, 0.50],
  bandLo:  [40, 0.10, 0.25],

  // pyramiding
  maxLegs: 4,               // initial + 3 adds
  pyramidAddFrac: 0.5,      // add = 50% of initial leg margin
  pyramidMinR: 0.2,         // add when leg ≥ +0.2R (0.5% px ≈ 5% eq @10x)
  pyramidCooldownSecs: 30,  // rapid-fire: 30s between adds
  peakProfitR: 1.0,         // peak exit arms at +1R
  scaleOutFrac: 0.5,        // sell half the legs on weakening
  givebackArmEq: 0.02,      // giveback exit arms at +2% equity MFE
  givebackKeepFrac: 0.5,    // exit when <50% of the MFE run remains
  dumpAtrMult: 0.75,        // dump exit: 3-bar ROC < −0.75 ATR against us

  // stops / risk
  slAtrMult: 1.5,
  slMinFrac: 0.025,         // 2.5% catastrophe stop floor
  timeStopSecs: 300,        // 5-min max hold on wave entries
  predictTimeStopSecs: 180, // 3-min max on predictive entries
  dayKillFrac: 0.20,        // halt at −20% session equity

  // execution
  orderCooldownMs: 3000,    // min ms between orders
  maxSlippageFrac: 0.004,   // abort if price moved >0.4% mid-ticket

  // tiered equity risk management (see Tiers)
  // Tier 0 = safe/start/recovery: trades OFTEN but small (25% notional),
  // conviction ≥ 60, pyramiding into winners, instant cuts on losers.
  tierThresholds: [200, 400, 800], // Tier 1/2/3 unlock equity; Tier 4+ = 2x steps
  tierMaxNotional: [0.25, 0.50, 0.80, 1.00], // per tier (0=safe)
  tierMinConv: [60, 60, 50, 40],             // per tier (0=safe: frequent, not timid)
  tier4ConvStep: 5,         // tier 4+: −5 conviction per tier
  tierConvFloor: 30,        // conviction never drops below this
  checkpointDrawdown: 0.20, // 20% below checkpoint → SAFE MODE
};

/* Selectors — verified against the live DOM 2026-10-08.
 * The order widget re-renders ~1/sec: ALWAYS re-query, never cache. */
const SEL = {
  sellBtn: '.orderWidget-u3DtG1BP > button:nth-of-type(1)', // "Sell {price}"
  buyBtn:  '.orderWidget-u3DtG1BP > button:nth-of-type(2)', // "Buy {price}"
  qtyField: '#quantity-field',                              // USD margin
  submitBtn: 'button.e3ECpiMr',                             // "Buy … MARKET"
};

/* ───────────────────────── tiny utils ───────────────────────── */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();

function ema(prev, price, n) {
  const k = 2 / (n + 1);
  return prev == null ? price : price * k + prev * (1 - k);
}

/* Set a React-controlled input so the app actually sees the change. */
function setNativeInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/* Extract a number from strings like "Buy 80,568.5" / "Sell 80567.9". */
function parsePrice(text) {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/* ───────────────────────── price feed ───────────────────────── */

const Feed = {
  lastMid: null,
  lastTickAt: 0,
  stale: true,

  /** Re-query the ticket buttons and return {bid, ask, mid} or null. */
  read() {
    const sellBtn = $(SEL.sellBtn);
    const buyBtn  = $(SEL.buyBtn);
    if (!sellBtn || !buyBtn) return null;
    const bid = parsePrice(sellBtn.getAttribute('aria-label') ||
                           sellBtn.textContent);
    const ask = parsePrice(buyBtn.getAttribute('aria-label') ||
                           buyBtn.textContent);
    if (!bid || !ask || bid <= 0 || ask <= 0) return null;
    const mid = (bid + ask) / 2;
    this.lastMid = mid;
    this.lastTickAt = now();
    this.stale = false;
    return { bid, ask, mid };
  },

  isFresh() {
    return !this.stale && (now() - this.lastTickAt) < 3000;
  },
};

/* ───────────────────────── bars & indicators ───────────────────────── */

function newBar(t) { return { t, o: 0, h: -Infinity, l: Infinity, c: 0, n: 0 }; }

class BarSeries {
  constructor(barSecs, maxBars) {
    this.barSecs = barSecs;
    this.maxBars = maxBars;
    this.bars = [];
    this.cur = null;
  }
  /** Fold a tick price into the current bar; returns a closed bar or null. */
  tick(price, t) {
    const bt = Math.floor(t / 1000 / this.barSecs) * this.barSecs * 1000;
    if (!this.cur || this.cur.t !== bt) {
      const closed = (this.cur && this.cur.n > 0) ? this.cur : null;
      if (closed) {
        this.bars.push(closed);
        if (this.bars.length > this.maxBars) this.bars.shift();
      }
      this.cur = newBar(bt);
      this.cur.o = this.cur.h = this.cur.l = this.cur.c = price;
      this.cur.n = 1;
      return closed;
    }
    this.cur.h = Math.max(this.cur.h, price);
    this.cur.l = Math.min(this.cur.l, price);
    this.cur.c = price;
    this.cur.n++;
    return null;
  }
  closes() { return this.bars.map(b => b.c); }
}

function atrOf(bars, period) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let rma = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++)
    rma = (rma * (period - 1) + trs[i]) / period;
  return rma;
}

function atrRecent(bars, period, lookback) {
  if (bars.length < lookback + 1) return null;
  return atrOf(bars.slice(-lookback), period);
}

class TF {
  constructor(barSecs, maxBars) {
    this.series = new BarSeries(barSecs, maxBars);
    this.emaFast = null;
    this.emaSlow = null;
  }
  onBar(bar) {
    this.emaFast = ema(this.emaFast, bar.c, CFG.emaFast);
    this.emaSlow = ema(this.emaSlow, bar.c, CFG.emaSlow);
  }
  get bars() { return this.series.bars; }
  atr() { return atrOf(this.bars, CFG.atrPeriod); }
  bias() {
    if (this.emaFast == null || this.emaSlow == null ||
        this.bars.length < 3) return 0;
    if (this.emaFast > this.emaSlow) return 1;
    if (this.emaFast < this.emaSlow) return -1;
    return 0;
  }
}

/* ───────────────────────── strategy (ported from bot v5) ───────────────────────── */

const LONG = 1, SHORT = -1, FLAT = 0;

const Strat = {
  sig: new TF(CFG.sigBarSecs, 200),     // 1m signal
  agree: new TF(CFG.agreeBarSecs, 80),  // 5m agreement
  micro: new BarSeries(10, 300),        // 10s micro bars (accel proxy)

  onTick(price, t) {
    const closedMicro = this.micro.tick(price, t);
    const b1 = this.sig.series.tick(price, t);
    if (b1) this.sig.onBar(b1);
    const b5 = this.agree.series.tick(price, t);
    if (b5) this.agree.onBar(b5);
    void closedMicro;
  },

  ready() {
    return this.sig.bars.length >= CFG.atrPeriod + 5;
  },

  /** Conviction score 0–100. Mirrors bot strategy.score(). */
  score() {
    const sig = this.sig, agree = this.agree;
    if (!this.ready()) return { v: 0, why: 'warming up' };
    const atr = sig.atr();
    const bars = sig.bars;
    const price = bars[bars.length - 1].c;
    if (!atr || atr <= 0) return { v: 0, why: 'no ATR' };
    if (atr / price < CFG.volDeadAtrFrac) return { v: 0, why: 'dead vol' };

    let dir = sig.bias();
    const sigDir = dir !== FLAT ? dir : agree.bias();
    if (sigDir === FLAT) return { v: 0, why: 'no bias' };

    const parts = [];
    // 1. trend / formation 0–40
    let w;
    if (dir !== FLAT) {
      const sep = Math.abs(sig.emaFast - sig.emaSlow) / atr;
      w = Math.min(40, sep * 40);
      parts.push('trend ' + w.toFixed(0));
    } else {
      w = this._formation(sigDir, atr);
      parts.push('form ' + w.toFixed(0));
    }
    // 2. agreement 0–20
    const ab = agree.bias();
    const a = ab === sigDir ? 20 : (ab === FLAT ? 10 : 0);
    if (a) parts.push('agree ' + a);
    // 3. momentum 0–20
    const m = this._momentum(sigDir, atr);
    parts.push('mom ' + m.toFixed(0));
    // 4. acceleration 0–10
    const ac = this._accel(sigDir, atr);
    if (ac) parts.push('accel ' + ac.toFixed(0));
    // 5. ATR expansion 0–10
    const ex = this._expansion(atr);
    if (ex) parts.push('exp ' + ex.toFixed(0));

    // warmup penalty: thin bars → dampened score
    const warm = Math.min(1, bars.length / 25);
    return { v: Math.min(100, (w + a + m + ac + ex) * warm),
             why: parts.join(', '), dir: sigDir, atr, price };
  },

  _momentum(dir, atr) {
    const bars = this.sig.bars;
    if (bars.length < 4) return 0;
    const price = bars[bars.length - 1].c;
    const roc = (bars[bars.length - 1].c - bars[bars.length - 4].c) /
                bars[bars.length - 4].c * dir;
    return Math.min(20, Math.max(0, roc / (atr / price) * 20));
  },

  _accel(dir, atr) {
    const bars = this.sig.bars;
    if (bars.length < 10) return 0;
    const price = bars[bars.length - 1].c;
    const f = atr / price;
    const fast = (bars[bars.length - 1].c - bars[bars.length - 4].c) /
                 bars[bars.length - 4].c * dir;
    const slow = (bars[bars.length - 1].c - bars[bars.length - 10].c) /
                 bars[bars.length - 10].c * dir;
    return Math.min(10, Math.max(0, (fast - slow) / f * 25));
  },

  _expansion(atr) {
    const bars = this.sig.bars;
    const s = atrRecent(bars, CFG.atrPeriod, 6);
    const l = atrRecent(bars, CFG.atrPeriod, 25);
    if (!s || !l || l <= 0) return 0;
    return Math.min(10, Math.max(0, (s / l - 1) * 50));
  },

  _formation(dir, atr) {
    const sig = this.sig, bars = sig.bars;
    if (bars.length < 12 || sig.emaFast == null) return 0;
    const a = this._accel(dir, atr) * 1.5;
    const e = this._expansion(atr);
    // EMA gap closing velocity
    const gapNow = Math.abs(sig.emaFast - sig.emaSlow) / atr;
    let e9 = null, e21 = null;
    for (const b of bars.slice(0, -5)) {
      e9 = ema(e9, b.c, sig.series ? CFG.emaFast : CFG.emaFast);
      e21 = ema(e21, b.c, CFG.emaSlow);
    }
    let g = 0;
    if (e9 != null && e21 != null) {
      const gapPrev = Math.abs(e9 - e21) / atr;
      const closing = Math.max(0, gapPrev - gapNow);
      if ((sig.emaFast - e9) * dir > 0) g = Math.min(15, closing * 30);
    }
    return Math.min(40, a + e + g);
  },

  /** Unrealized P&L in R multiples for a leg. */
  legR(leg, price) {
    if (leg.stopFrac <= 0) return 0;
    return leg.dir * (price - leg.entry) / (leg.entry * leg.stopFrac);
  },

  /** Should we pyramid onto this wave? (leg = oldest open leg) */
  shouldAdd(leg, price) {
    if (now() - leg.lastAddAt < CFG.pyramidCooldownSecs * 1000)
      return null;
    const r = this.legR(leg, price);
    if (r < CFG.pyramidMinR) return null;
    if (this.sig.bias() !== leg.dir) return null;
    const atr = this.sig.atr();
    if (!atr || this._accel(leg.dir, atr) < 3) return null;
    const bars = this.sig.bars;
    if (leg.dir === LONG && bars.length >= 3) {
      const h = bars.slice(-3).map(b => b.h);
      if (!(h[2] > h[1] && h[1] > h[0])) return null;
    }
    if (leg.dir === SHORT && bars.length >= 3) {
      const l = bars.slice(-3).map(b => b.l);
      if (!(l[2] < l[1] && l[1] < l[0])) return null;
    }
    return 'pyramid ' + r.toFixed(2) + 'R, wave rising';
  },

  /** Peak: decelerating hard while ≥1R — exit into strength. */
  peakHit(leg, price) {
    const r = this.legR(leg, price);
    if (r < CFG.peakProfitR) return null;
    const bars = this.sig.bars;
    if (bars.length < 10) return null;
    const atr = this.sig.atr();
    if (!atr) return null;
    const f = atr / bars[bars.length - 1].c;
    const fast = (bars[bars.length - 1].c - bars[bars.length - 4].c) /
                 bars[bars.length - 4].c * leg.dir;
    const slow = (bars[bars.length - 1].c - bars[bars.length - 10].c) /
                 bars[bars.length - 10].c * leg.dir;
    const decel = (slow - fast) / f;
    if (decel > 0.25 && fast < slow * 0.5)
      return 'peak decel ' + decel.toFixed(2) + ' ATR @ ' + r.toFixed(2) + 'R';
    return null;
  },

  /** Weakening while green — scale half out. */
  weakenHit(leg, price) {
    const r = this.legR(leg, price);
    if (r < 0.3) return null;
    const atr = this.sig.atr();
    if (!atr) return null;
    const bars = this.sig.bars;
    if (bars.length < 4) return null;
    let weakening = false;
    if (leg.dir === LONG) {
      const h = bars.slice(-3).map(b => b.h);
      if (h[2] < h[1] && h[1] < h[0]) weakening = true;
    } else {
      const l = bars.slice(-3).map(b => b.l);
      if (l[2] > l[1] && l[1] > l[0]) weakening = true;
    }
    const ac = this._accel(leg.dir, atr);
    if (weakening || ac < -2)
      return 'weakening r=' + r.toFixed(2) + ' accel=' + ac.toFixed(1);
    return null;
  },

  /** Dump: sharp 3-bar reversal against us — don't wait for EMA cross. */
  dumpHit(leg, price) {
    const bars = this.sig.bars;
    if (bars.length < 4) return null;
    const atr = this.sig.atr();
    if (!atr || atr <= 0) return null;
    const px = bars[bars.length - 1].c;
    const roc3 = (px - bars[bars.length - 4].c) / bars[bars.length - 4].c *
                 leg.dir;
    const atrF = atr / px;
    if (roc3 < -CFG.dumpAtrMult * atrF)
      return 'dump: 3-bar ROC ' + (roc3 / atrF).toFixed(2) + ' ATR against';
    return null;
  },

  /** Giveback: banked a real run (≥2% equity MFE) then gave back half. */
  givebackHit(leg, price, equity) {
    if (leg.mfeEq == null || equity <= 0) return null;
    const cur = leg.dir * (price - leg.entry) / leg.entry *
                leg.margin * CFG.leverage / equity;
    if (leg.mfeEq >= CFG.givebackArmEq &&
        cur < leg.mfeEq * CFG.givebackKeepFrac)
      return 'giveback: +' + (leg.mfeEq * 100).toFixed(1) + '% eq → +' +
             (cur * 100).toFixed(1) + '%';
    return null;
  },

  /** Update max favorable excursion (as equity fraction) for a leg. */
  trackMfe(leg, price, equity) {
    if (equity <= 0) return;
    const cur = leg.dir * (price - leg.entry) / leg.entry *
                leg.margin * CFG.leverage / equity;
    if (leg.mfeEq == null || cur > leg.mfeEq) leg.mfeEq = cur;
  },

  /** Red + momentum against us — cut before it becomes a real loss. */
  reversalHit(leg, price) {
    if (leg.dir * (price - leg.entry) >= 0) return null;
    const mb = this.micro.bars;
    if (mb.length >= 20) {
      let f = null, s = null;
      for (const c of mb.slice(-48)) {
        f = ema(f, c, 12); s = ema(s, c, 48);
      }
      const against = leg.dir === LONG ? (f < s) : (f > s);
      if (against) return 'pre-loss cut: red + micro momentum against';
    }
    return null;
  },

  /** Bias flipped against the position — the wave is dead. */
  waveDead(leg) {
    const b = this.sig.bias();
    if (b !== FLAT && b !== leg.dir) return 'wave dead: bias flipped';
    return null;
  },
};

/* ───────────────────────── order executor ───────────────────────── */

const Exec = {
  lastOrderAt: 0,
  fills: [],   // our own fill log {side, margin, price, t}

  /** Click side → set margin → submit. Returns fill or null. */
  async market(side /* 'buy' | 'sell' */, marginUSD, why) {
    if (now() - this.lastOrderAt < CFG.orderCooldownMs) {
      UI.log('throttled: ' + why);
      return null;
    }
    const sideBtn = $(side === 'buy' ? SEL.buyBtn : SEL.sellBtn);
    if (!sideBtn) { UI.log('ERR: side button missing'); return null; }

    const prePx = Feed.lastMid;
    sideBtn.click();
    await sleep(450);

    const qty = $(SEL.qtyField);
    if (!qty) { UI.log('ERR: qty field missing after side click'); return null; }
    setNativeInput(qty, marginUSD.toFixed(2));
    await sleep(300);

    // slippage guard: don't fire if price ran away mid-ticket
    const post = Feed.read();
    if (post && prePx &&
        Math.abs(post.mid - prePx) / prePx > CFG.maxSlippageFrac) {
      UI.log('aborted: price slipped mid-ticket');
      return null;
    }

    const submit = $(SEL.submitBtn);
    if (!submit) { UI.log('ERR: submit button missing'); return null; }
    const label = (submit.getAttribute('aria-label') || submit.textContent || '');
    const expectSide = side === 'buy' ? 'buy' : 'sell';
    if (!label.toLowerCase().startsWith(expectSide)) {
      UI.log('ERR: submit side mismatch: "' + label.slice(0, 40) + '"');
      return null;
    }

    this.lastOrderAt = now();
    submit.click();
    await sleep(900);
    const fillPx = Feed.lastMid || post?.mid || prePx;
    const fill = { side, margin: marginUSD, price: fillPx, t: now(), why };
    this.fills.push(fill);
    UI.log((side === 'buy' ? 'BUY ' : 'SELL ') + '$' + marginUSD.toFixed(2) +
           ' margin @ ' + (fillPx ? fillPx.toFixed(1) : '?') + ' — ' + why);
    return fill;
  },
};

/* ───────────────────────── position & risk state ───────────────────────── */

const State = {
  running: false,
  killed: false,
  equity: CFG.startEquity,
  startEquity: CFG.startEquity,
  legs: [],          // open legs {dir, margin, entry, stopFrac, stopPx, t, kind, lastAddAt}
  trades: 0,
  wins: 0,
  realized: 0,

  netDir() {
    if (!this.legs.length) return FLAT;
    return this.legs[0].dir; // single-theme: all legs same side
  },
  totalMargin() {
    return this.legs.reduce((a, l) => a + l.margin, 0);
  },
  /** Unrealized P&L in USD across legs (notional = margin × leverage). */
  unrealized(price) {
    return this.legs.reduce((a, l) =>
      a + l.dir * (price - l.entry) / l.entry * l.margin * CFG.leverage, 0);
  },
  liveEquity(price) {
    return this.equity + this.unrealized(price == null ? Feed.lastMid : price);
  },
  flatten() { this.legs = []; },
};

/* ─────────────────── tiered equity risk management ─────────────────── */
/*
 * The owner's tiered system: safe start/recovery, profit tiers that unlock
 * bigger sizing as equity compounds, checkpoint ratchets that force a drop
 * back to safe mode on a 20% drawdown from the checkpoint.
 */
const Tiers = {
  checkpoint: CFG.startEquity, // ratchet — only ever moves UP
  forcedSafe: false,           // true while equity < 80% of checkpoint

  /** Tier index for a given equity. 0 = safe, 1..3 = tiers, 4+ = 2x steps. */
  tierFor(equity) {
    const [t1, t2, t3] = CFG.tierThresholds;
    if (equity < t1) return 0;
    if (equity < t2) return 1;
    if (equity < t3) return 2;
    let tier = 3, thr = t3;
    while (equity >= thr * 2) { thr *= 2; tier++; }
    return tier;
  },

  /** Max notional as a fraction of equity for a tier. */
  maxNotional(tier) {
    if (tier < CFG.tierMaxNotional.length)
      return CFG.tierMaxNotional[tier];
    return 1.00;
  },

  /** Minimum conviction to take a signal at a tier. */
  minConviction(tier) {
    if (tier < CFG.tierMinConv.length)
      return CFG.tierMinConv[tier];
    return Math.max(CFG.tierConvFloor,
      CFG.tierMinConv[3] - (tier - 3) * CFG.tier4ConvStep);
  },

  /** Call every tick with live equity. Ratchets checkpoint, trips safe mode. */
  update(equity) {
    // ratchet: checkpoint = highest tier threshold reached so far
    const tier = this.tierFor(equity);
    let cp = CFG.startEquity;
    for (const thr of CFG.tierThresholds) {
      if (equity >= thr) cp = Math.max(cp, thr);
    }
    if (tier > 3) {
      let thr = CFG.tierThresholds[2];
      while (equity >= thr * 2) thr *= 2;
      cp = Math.max(cp, thr);
    }
    if (cp > this.checkpoint) {
      this.checkpoint = cp;
      if (this.forcedSafe && equity >= cp) {
        this.forcedSafe = false;
        UI.log('recovered above $' + cp.toFixed(0) +
               ' checkpoint — aggression restored');
      } else {
        UI.log('CHECKPOINT locked at $' + cp.toFixed(0) +
               ' (tier ' + tier + ')');
      }
    }
    // drawdown: 20% below checkpoint → safe mode until recovered
    if (equity < this.checkpoint * (1 - CFG.checkpointDrawdown)) {
      if (!this.forcedSafe) {
        UI.log('CHECKPOINT BREACH: $' + equity.toFixed(2) + ' < 80% of $' +
               this.checkpoint.toFixed(0) + ' — SAFE MODE');
      }
      this.forcedSafe = true;
    } else if (this.forcedSafe && equity >= this.checkpoint) {
      this.forcedSafe = false;
      UI.log('recovered above $' + this.checkpoint.toFixed(0) +
             ' checkpoint — aggression restored');
    }
  },

  /** Effective tier right now (forced safe overrides). */
  current(equity) {
    return this.forcedSafe ? 0 : this.tierFor(equity);
  },

  mode(equity) {
    return this.current(equity) === 0 ? 'SAFE' : 'AGGRESSIVE';
  },

  label(equity) {
    const t = this.current(equity);
    return 'T' + t + ' · $' + this.checkpoint.toFixed(0) + ' · ' +
           this.mode(equity) + (this.forcedSafe ? ' (drawdown)' : '');
  },
};

/** Margin USD for a fresh entry at conviction score s (0–100).
 *  Tier cap overrides the conviction band: effective notional =
 *  min(band fraction, tier max). */
function entryMargin(s, equity) {
  const tier = Tiers.current(equity);
  const cap = Tiers.maxNotional(tier);
  const [bS, lo, hi] = s >= CFG.bandHi[0] ? CFG.bandHi
                     : s >= CFG.bandMid[0] ? CFG.bandMid
                     : CFG.bandLo;
  const frac = lo + (hi - lo) * Math.min(1, Math.max(0, (s - bS) / 20));
  const capped = Math.min(frac, cap);
  return Math.max(1, equity * capped / CFG.leverage);
}

/* ───────────────────────── UI panel ───────────────────────── */

const UI = {
  el: null, logEl: null,

  build() {
    if (this.el) return;
    const d = document.createElement('div');
    d.id = 'waverider-panel';
    d.innerHTML = `
      <div class="wr-head">
        <span class="wr-dot" id="wr-dot"></span>
        <b>WaveRider</b><span class="wr-ver">v1.1</span>
        <span style="flex:1"></span>
        <button id="wr-start">START</button>
        <button id="wr-stop">STOP</button>
      </div>
      <div class="wr-grid">
        <div>Equity <b id="wr-eq">—</b></div>
        <div>P&amp;L <b id="wr-pnl">—</b></div>
        <div>Position <b id="wr-pos">flat</b></div>
        <div>Trades <b id="wr-tr">0</b> (<span id="wr-wr">—</span> win)</div>
        <div>Price <b id="wr-px">—</b></div>
        <div>Signal <b id="wr-sig">—</b></div>
        <div>Tier <b id="wr-tier">T0</b></div>
        <div>Checkpoint <b id="wr-cp">$100</b></div>
        <div>Mode <b id="wr-mode">SAFE</b></div>
        <div>Min conv <b id="wr-mc">60</b></div>
      </div>
      <div class="wr-row">
        <button id="wr-flat" class="wr-warn">PANIC FLATTEN</button>
      </div>
      <div id="wr-log" class="wr-log"></div>`;
    const st = document.createElement('style');
    st.textContent = `
      #waverider-panel{position:fixed;top:12px;left:12px;z-index:999999;
        width:290px;background:#0d1117;border:1px solid #2a3340;border-radius:10px;
        color:#d7dee8;font:12px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;
        box-shadow:0 8px 30px rgba(0,0,0,.55);overflow:hidden}
      #waverider-panel .wr-head{display:flex;align-items:center;gap:8px;
        padding:8px 10px;background:#131a24;border-bottom:1px solid #2a3340}
      #waverider-panel .wr-ver{color:#6b7a90;font-size:10px}
      #waverider-panel .wr-dot{width:9px;height:9px;border-radius:50%;
        background:#5a6577;display:inline-block}
      #waverider-panel.on .wr-dot{background:#22c55e;box-shadow:0 0 8px #22c55e}
      #waverider-panel.dead .wr-dot{background:#ef4444}
      #waverider-panel button{background:#1c2634;color:#d7dee8;border:1px solid #334052;
        border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer}
      #waverider-panel button:hover{background:#263349}
      #wr-start.on{background:#14532d;border-color:#22c55e}
      #waverider-panel .wr-grid{display:grid;grid-template-columns:1fr 1fr;
        gap:2px 10px;padding:8px 10px;color:#8b98ab}
      #waverider-panel .wr-grid b{color:#e8eef6;font-weight:600}
      #waverider-panel .wr-row{padding:0 10px 6px}
      #waverider-panel .wr-warn{width:100%;background:#3a1414;border-color:#7f1d1d;color:#fca5a5}
      #waverider-panel .wr-log{max-height:130px;overflow-y:auto;padding:6px 10px 10px;
        font-size:10.5px;color:#7d8ba0;border-top:1px solid #1d2634}
      #waverider-panel .wr-log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`;
    document.head.appendChild(st);
    document.body.appendChild(d);
    this.el = d;
    this.logEl = $('#wr-log', d);
    $('#wr-start', d).onclick = () => Engine.start();
    $('#wr-stop', d).onclick = () => Engine.stop('manual stop');
    $('#wr-flat', d).onclick = () => Engine.panicFlatten();
  },

  log(msg) {
    if (!this.logEl) return;
    const div = document.createElement('div');
    const t = new Date();
    div.textContent = t.toTimeString().slice(0, 8) + ' ' + msg;
    this.logEl.prepend(div);
    while (this.logEl.children.length > 40)
      this.logEl.removeChild(this.logEl.lastChild);
  },

  render(sigInfo) {
    if (!this.el) return;
    const px = Feed.lastMid;
    const eq = State.liveEquity(px);
    const set = (id, v) => { const e = $('#' + id, this.el); if (e) e.textContent = v; };
    set('wr-eq', '$' + eq.toFixed(2));
    const pnl = eq - State.startEquity;
    const pnlEl = $('#wr-pnl', this.el);
    if (pnlEl) {
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
      pnlEl.style.color = pnl >= 0 ? '#22c55e' : '#ef4444';
    }
    const nd = State.netDir();
    set('wr-pos', State.legs.length
      ? (nd === LONG ? 'LONG ' : 'SHORT ') + State.legs.length + ' legs $' +
        State.totalMargin().toFixed(0) + 'm'
      : 'flat');
    set('wr-tr', String(State.trades));
    set('wr-wr', State.trades ? Math.round(100 * State.wins / State.trades) + '%' : '—');
    set('wr-px', px ? px.toFixed(1) : '—');
    set('wr-sig', sigInfo ? (sigInfo.dir === 1 ? '▲ ' : sigInfo.dir === -1 ? '▼ ' : '· ') +
      sigInfo.v.toFixed(0) + ' ' + sigInfo.why.slice(0, 34) : '—');
    // tier display
    const tier = Tiers.current(eq);
    set('wr-tier', 'T' + tier);
    set('wr-cp', '$' + Tiers.checkpoint.toFixed(0));
    const modeEl = $('#wr-mode', this.el);
    const mode = Tiers.mode(eq);
    if (modeEl) {
      modeEl.textContent = mode + (Tiers.forcedSafe ? ' ↓' : '');
      modeEl.style.color = mode === 'SAFE' ? '#f59e0b' : '#22c55e';
    }
    set('wr-mc', String(Tiers.minConviction(tier)));
    this.el.classList.toggle('on', State.running);
    this.el.classList.toggle('dead', State.killed);
    const st = $('#wr-start', this.el);
    if (st) st.classList.toggle('on', State.running);
  },
};

/* ───────────────────────── paper-only guard ───────────────────────── */

/** Refuse to run unless the trading account is clearly the paper one. */
function confirmPaperAccount() {
  const body = document.body.innerText || '';
  // TradingView paper account shows "Paper Trading" in the account switcher.
  if (/paper trading/i.test(body)) return true;
  // Fallback: the order ticket widget exists on the paper account layout.
  if ($(SEL.buyBtn) && $(SEL.sellBtn) && $(SEL.qtyField)) {
    UI.log('WARN: paper label not found — verify account is PAPER before START');
    return 'unverified';
  }
  return false;
}

/* ───────────────────────── engine ───────────────────────── */

const Engine = {
  timer: null,
  busy: false,

  async start() {
    if (State.running || State.killed) return;
    const paper = confirmPaperAccount();
    if (paper === false) {
      UI.log('REFUSED: paper account not detected. Aborting.');
      alert('WaveRider: could not confirm the PAPER trading account. ' +
            'Switch to Paper Trading and reload, then START.');
      return;
    }
    if (paper === 'unverified' &&
        !confirm('WaveRider could not verify the Paper Trading account.\n\n' +
                 'Only press OK if you are 100% sure the PAPER account ' +
                 'is active. Real-money trading is NEVER allowed.')) return;

    State.running = true;
    State.startEquity = CFG.startEquity;
    State.equity = CFG.startEquity;
    UI.log('STARTED — paper only, 10x, kill at −20% ($' +
           (CFG.startEquity * (1 - CFG.dayKillFrac)).toFixed(2) + ')');
    this.timer = setInterval(() => this.loop(), CFG.tickMs);
  },

  stop(reason) {
    if (!State.running) return;
    State.running = false;
    clearInterval(this.timer);
    this.timer = null;
    UI.log('STOPPED — ' + reason + ' (positions left open; close manually ' +
           'or PANIC FLATTEN)');
  },

  kill(reason) {
    State.killed = true;
    this.stop('KILL SWITCH: ' + reason);
    UI.log('⛔ KILL SWITCH ENGAGED — reload page to re-arm');
  },

  async panicFlatten() {
    if (!State.legs.length) { UI.log('already flat'); return; }
    const dir = State.netDir();
    const margin = State.totalMargin();
    UI.log('PANIC FLATTEN: closing ' + State.legs.length + ' legs…');
    const fill = await Exec.market(dir === LONG ? 'sell' : 'buy',
                                   margin, 'panic flatten');
    if (fill) this.closeLegs(dir, fill.price, 'panic');
  },

  /** Realize P&L for legs closed at price, in the given direction. */
  closeLegs(dir, price, reason) {
    let realized = 0;
    const kept = [];
    for (const leg of State.legs) {
      if (leg.dir === dir) {
        const pnl = leg.dir * (price - leg.entry) / leg.entry *
                    leg.margin * CFG.leverage;
        realized += pnl;
        State.trades++;
        if (pnl > 0) State.wins++;
        UI.log('EXIT ' + (leg.dir === LONG ? 'LONG' : 'SHORT') + ' $' +
               leg.margin.toFixed(2) + 'm @ ' + price.toFixed(1) +
               ' ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) +
               ' — ' + reason);
      } else kept.push(leg);
    }
    State.legs = kept;
    State.equity += realized;
    State.realized += realized;
    return realized;
  },

  async loop() {
    if (this.busy || !State.running || State.killed) return;
    this.busy = true;
    try {
      const q = Feed.read();
      if (!q) { UI.render(null); this.busy = false; return; }
      const px = q.mid, t = now();
      Strat.onTick(px, t);
      const s = Strat.score();
      UI.render(s);

      // ── day kill switch ──
      const eq = State.liveEquity(px);
      if (eq < State.startEquity * (1 - CFG.dayKillFrac)) {
        await this.panicFlatten();
        this.kill('equity $' + eq.toFixed(2) + ' < −20% line');
        this.busy = false;
        return;
      }

      // ── tier checkpoint / safe-mode update ──
      Tiers.update(eq);

      // ── manage open legs ──
      if (State.legs.length) {
        const done = await this.manage(px, s);
        if (done) { this.busy = false; return; } // an order fired; next tick
      }

      // ── entries ──
      if (Strat.ready() && Feed.isFresh()) {
        await this.maybeEnter(px, s);
      }
    } catch (e) {
      UI.log('loop err: ' + (e && e.message));
    }
    this.busy = false;
  },

  /** Signal-based exits + pyramiding. Returns true if an order fired. */
  async manage(px, s) {
    const dir = State.netDir();
    const oldest = State.legs[0];

    // track max favorable excursion on every leg, every tick
    for (const leg of State.legs) Strat.trackMfe(leg, px, State.equity);

    // 1. catastrophe stop (safety net, not the strategy)
    for (const leg of [...State.legs]) {
      const hitPx = leg.dir === LONG
        ? leg.entry * (1 - leg.stopFrac)
        : leg.entry * (1 + leg.stopFrac);
      if ((leg.dir === LONG && px <= hitPx) ||
          (leg.dir === SHORT && px >= hitPx)) {
        const fill = await Exec.market(leg.dir === LONG ? 'sell' : 'buy',
                                       leg.margin, 'catastrophe stop');
        if (fill) this.closeLegs(leg.dir, fill.price, 'catastrophe stop');
        return true;
      }
    }

    // 2. wave dead — bias flipped against the position
    const dead = Strat.waveDead(oldest);
    if (dead) {
      const fill = await Exec.market(dir === LONG ? 'sell' : 'buy',
                                     State.totalMargin(), dead);
      if (fill) this.closeLegs(dir, fill.price, dead);
      return true;
    }

    // 3. dump — sharp reversal, don't wait for the EMA cross
    const dump = Strat.dumpHit(oldest, px);
    if (dump) {
      const fill = await Exec.market(dir === LONG ? 'sell' : 'buy',
                                     State.totalMargin(), dump);
      if (fill) this.closeLegs(dir, fill.price, dump);
      return true;
    }

    // 4. giveback — banked a run, now giving half back
    const gb = Strat.givebackHit(oldest, px, State.equity);
    if (gb) {
      const fill = await Exec.market(dir === LONG ? 'sell' : 'buy',
                                     State.totalMargin(), gb);
      if (fill) this.closeLegs(dir, fill.price, gb);
      return true;
    }

    // 5. peak — exit everything into strength
    const peak = Strat.peakHit(oldest, px);
    if (peak) {
      const fill = await Exec.market(dir === LONG ? 'sell' : 'buy',
                                     State.totalMargin(), peak);
      if (fill) this.closeLegs(dir, fill.price, peak);
      return true;
    }

    // 6. pre-loss cut — red + momentum against
    const rev = Strat.reversalHit(oldest, px);
    if (rev) {
      const fill = await Exec.market(dir === LONG ? 'sell' : 'buy',
                                     State.totalMargin(), rev);
      if (fill) this.closeLegs(dir, fill.price, rev);
      return true;
    }

    // 7. scale-out — weakening while green: sell half the legs
    const weak = Strat.weakenHit(oldest, px);
    if (weak && State.legs.length > 1) {
      const half = State.legs.slice(0, Math.ceil(State.legs.length / 2));
      const m = half.reduce((a, l) => a + l.margin, 0);
      const fill = await Exec.market(dir === LONG ? 'sell' : 'buy', m, weak);
      if (fill) {
        let realized = 0;
        const ids = new Set(half);
        State.legs = State.legs.filter(l => {
          if (ids.has(l)) {
            const pnl = l.dir * (fill.price - l.entry) / l.entry *
                        l.margin * CFG.leverage;
            realized += pnl; State.trades++;
            if (pnl > 0) State.wins++;
            UI.log('SCALE-OUT ' + (pnl >= 0 ? '+' : '') + '$' +
                   pnl.toFixed(2) + ' — ' + weak);
            return false;
          }
          return true;
        });
        State.equity += realized; State.realized += realized;
      }
      return true;
    }

    // 8. time stop
    const oldestAge = (now() - oldest.t) / 1000;
    const tsLim = oldest.kind === 'predictive'
      ? CFG.predictTimeStopSecs : CFG.timeStopSecs;
    if (oldestAge > tsLim) {
      const fill = await Exec.market(dir === LONG ? 'sell' : 'buy',
                                     State.totalMargin(),
                                     'time stop ' + Math.round(oldestAge) + 's');
      if (fill) this.closeLegs(dir, fill.price, 'time stop');
      return true;
    }

    // 9. pyramid — chain into the running wave
    if (State.legs.length < CFG.maxLegs) {
      const why = Strat.shouldAdd(oldest, px);
      if (why) {
        const addMargin = oldest.margin * CFG.pyramidAddFrac;
        // tier notional cap → margin cap
        const tierCap = Tiers.maxNotional(Tiers.current(State.equity));
        const cap = State.equity * tierCap / CFG.leverage;
        if (State.totalMargin() + addMargin <= cap) {
          const fill = await Exec.market(dir === LONG ? 'buy' : 'sell',
                                         addMargin, why);
          if (fill) {
            State.legs.push({
              dir, margin: addMargin, entry: fill.price,
              stopFrac: oldest.stopFrac,
              stopPx: oldest.stopPx, t: now(), kind: oldest.kind,
              lastAddAt: now(),
            });
            oldest.lastAddAt = now();
          }
          return true;
        }
      }
    }
    return false;
  },

  /** Fresh entries: reactive wave or predictive pre-cross. */
  async maybeEnter(px, s) {
    if (State.legs.length >= CFG.maxLegs) return;
    // one theme at a time: never fight our own position
    const dir = s.dir;
    if (!dir) return;

    // tier conviction bar: safe mode only takes the surest signals
    const tier = Tiers.current(State.equity);
    const minConv = Tiers.minConviction(tier);
    if (s.v < minConv) return;

    const sigBias = Strat.sig.bias();
    let kind = null, why = '';
    if (sigBias === dir && s.v >= CFG.scoreEnter) {
      kind = 'wave'; why = 'wave ' + s.why;
    } else if (sigBias === FLAT && s.v >= CFG.scorePredict) {
      // predictive needs all three: accel + agreement + expansion
      const atr = s.atr;
      const ac = Strat._accel(dir, atr), ex = Strat._expansion(atr);
      if (ac >= 4 && ex >= 4 && Strat.agree.bias() === dir) {
        kind = 'predictive'; why = 'PREDICTIVE ' + s.why;
      }
    }
    if (!kind) return;

    // don't stack a new theme against open legs — wait for flat or same dir
    if (State.legs.length && State.netDir() !== dir) return;

    const margin = entryMargin(s.v, State.equity);
    const atr = s.atr;
    const stopFrac = Math.max(CFG.slAtrMult * atr / px, CFG.slMinFrac);
    const side = dir === LONG ? 'buy' : 'sell';
    const fill = await Exec.market(side, margin,
      kind + ' score ' + s.v.toFixed(0) + ' (' + why.slice(0, 60) + ')');
    if (fill) {
      State.legs.push({
        dir, margin, entry: fill.price, stopFrac,
        stopPx: dir === LONG ? fill.price * (1 - stopFrac)
                             : fill.price * (1 + stopFrac),
        t: now(), kind, lastAddAt: now(),
      });
    }
  },
};

/* ───────────────────────── boot ───────────────────────── */

(function boot() {
  if (window.__waverider_booted) return;
  window.__waverider_booted = true;
  const wait = setInterval(() => {
    if ($(SEL.buyBtn) && $(SEL.sellBtn)) {
      clearInterval(wait);
      UI.build();
      UI.log('WaveRider loaded. Confirm PAPER account + 10x leverage, then START.');
      // warm the feed so the first paint isn't empty
      Feed.read();
      setInterval(() => { if (!State.running) UI.render(Strat.score()); }, 1000);
    }
  }, 1000);
})();
