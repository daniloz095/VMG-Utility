/*
 * M Vitals+ — main screen.
 *
 * Tabs across the top; "Main" (Основное) shows seven primary vitals and four
 * secondary ones. Engine data comes from two sources:
 *   - SOME/IP signals declared in app.json (rpm, coolant temp, FES boost);
 *   - UDS/OBD reads from the DME through the OAP Diagnostic service
 *     (candidates per metric are listed in app.json -> config.dme).
 *
 * Knock and misfire counters only increment while measured boost > 0.5 bar.
 */

"use strict";

var os = require("os");
var signals = require("signals");
var settingsStore = require("settings");
var diagnostic = require("diagnostic");
var log = require("log").of("main");

/* ------------------------------------------------------------------ */
/* constants                                                          */
/* ------------------------------------------------------------------ */

var REFRESH_MS = 200;          // UI redraw period for the main screen
var POWER_REFRESH_MS = 100;    // faster redraw while the Power tab is open
var KNOCK_BOOST_GATE = 0.5;    // bar; counters only tick above this boost
var STALE_MS = 6000;           // a DME value older than this is "not available"
var PEAK_RESET_MS = 6000;      // peak power/torque reset interval (setting later)
var CHART_WINDOW_S = 30;       // rolling window of the power/torque chart

var TABS = [
  { id: "main", label: "MAIN" },
  { id: "power", label: "POWER" },
  { id: "gauge", label: "BOOST GAUGE" },
  { id: "logs", label: "LOGS" }
];

var PRIMARY_TILES = [
  { key: "boost",    label: "Boost",        unit: "bar",  dp: 2 },
  { key: "iat",      label: "Intake temp",  unit: "\u00b0C", dp: 0 },
  { key: "egt",      label: "Exhaust temp", unit: "\u00b0C", dp: 0 },
  { key: "oilPress", label: "Oil press",    unit: "bar",  dp: 1 },
  { key: "lambda",   label: "Mixture \u03bb",  unit: "",   dp: 2 },
  { key: "coolant",  label: "Coolant",      unit: "\u00b0C", dp: 0 },
  { key: "oilTemp",  label: "Oil temp",     unit: "\u00b0C", dp: 0 }
];

var SECONDARY_TILES = [
  { key: "voltage",  label: "Battery",      unit: "V",    dp: 1 },
  { key: "gearbox",  label: "Gearbox",      unit: "\u00b0C", dp: 0 },
  { key: "knock",    label: "Knock events", unit: "",     dp: 0, counter: true },
  { key: "misfire",  label: "Misfires",     unit: "",     dp: 0, counter: true }
];

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

var gCanvas = null;
var gW = 0, gH = 0;
var gActiveTab = "main";
var gSettings = {};
var gTheme = os.theme();

// live values: number or null; plus timestamps for staleness checks
var v = {
  rpm: null, speed: null, coolant: null,
  boostFes: null,            // from the sport display signal
  boost: null, iat: null, egt: null, oilPress: null, lambda: null,
  oilTemp: null, gearbox: null, voltage: null, mixtureAdapt: null,
  baro: null,                // ambient pressure, kPa (boost = charge - baro)
  knockRetard: null,
  stamp: {}                  // key -> Date.now() of last good read
};

// demo mode: fills every tile with plausible simulated data so the UI can be
// checked without the car. "auto" = on when no vehicle signals arrive.
var gDemoTimer = null;
var gDemoT = 0;
var gLastSignalMs = 0;

var counters = { knock: 0, misfireCount: 0 };
var prev = { knockActive: false };   // plus per-cylinder misfire baselines

/* Power tab state: instantaneous + peak power/torque and the chart history */
var power = {
  kw: null, hp: null, nm: null,     // current values (null = not computed yet)
  stamp: 0,                         // Date.now() of the last good computation
  peakHp: null, peakNm: null,       // rolling peaks, reset after PEAK_RESET_MS
  peakHpAt: 0, peakNmAt: 0,         // when the current peak was set
  hist: []                          // [{t, hp, nm}] rolling window for the chart
};

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

var ALL_TILES = PRIMARY_TILES.concat(SECONDARY_TILES, [
  { key: "rpm", label: "Engine rpm", unit: "", dp: 0 }
]);

function num(x) { return typeof x === "number" && isFinite(x); }

function tileByKey(key) {
  for (var i = 0; i < ALL_TILES.length; i++) if (ALL_TILES[i].key === key) return ALL_TILES[i];
  return null;
}

function fmt(key, val) {
  var tile = tileByKey(key);
  if (!num(val)) return "--";
  var dp = tile ? tile.dp : 1;
  return val.toFixed(dp);
}

function isFresh(key) {
  return num(v[key]) && (Date.now() - (v.stamp[key] || 0)) < STALE_MS;
}

function markFresh(key) { v.stamp[key] = Date.now(); }

function valueFor(key) {
  if (key === "boost") return currentBoost();
  if (key === "lambda") return currentLambda();
  // signal-fed values are push-based and always current while driving
  if (key === "coolant" || key === "oilTemp" || key === "rpm") {
    return num(v[key]) ? v[key] : null;
  }
  return isFresh(key) ? v[key] : null;
}

/* boost in bar: the DME poll gives absolute charge pressure (kPa), the
 * displayed figure is relative to ambient -> charge - baro. The FES sport
 * display signal is already a relative figure, used as-is. */
function boostBar() {
  if (isFresh("boost") && isFresh("baro")) return (v.boost - v.baro) / 100;
  return null;
}

function currentBoost() {
  // boost source setting: auto / fes / dme
  var src = gSettings.boostSource || "auto";
  if (src === "fes") return num(v.boostFes) ? v.boostFes : null;
  var rel = boostBar();
  if (src === "dme") return rel;
  // auto: prefer the live DME figure, fall back to the sport display
  if (num(rel)) return rel;
  if (num(v.boostFes)) return v.boostFes;
  return null;
}

/* mixture: instantaneous lambda; when the DME also gives the learned
 * adaptation factor, show the effective mixture (lambda x adapt). */
function currentLambda() {
  if (!isFresh("lambda")) return null;
  var lam = v.lambda;
  if (isFresh("mixtureAdapt") && num(v.mixtureAdapt)) lam *= v.mixtureAdapt;
  return lam;
}

/* ------------------------------------------------------------------ */
/* colors                                                             */
/* ------------------------------------------------------------------ */

function c(name) { return gTheme.colors[name]; }

function tileColor(key, val) {
  if (!num(val)) return c("textTertiary");
  switch (key) {
    case "boost":    return val > 0.05 ? c("textPrimary") : c("textTertiary");
    case "iat":      return val > 55 ? c("alert") : c("textPrimary");
    case "egt":      return val > 960 ? c("alert") : val > 870 ? c("warning") : c("textPrimary");
    case "oilPress": return val < 1.2 ? c("alert") : c("textPrimary");
    case "lambda":   return Math.abs(val - 1) < 0.05 ? c("success") : c("textPrimary");
    case "coolant":  return val > 112 ? c("warning") : c("textPrimary");
    case "oilTemp":  return val > 140 ? c("alert") : val > 125 ? c("warning") : c("textPrimary");
    case "gearbox":  return val > 115 ? c("warning") : c("textPrimary");
    case "voltage":  return val < 12.0 ? c("alert") : c("textPrimary");
    case "knock":    return counters.knock > 0 ? c("alert") : c("textPrimary");
    case "misfire":  return counters.misfireCount > 0 ? c("alert") : c("textPrimary");
  }
  return c("textPrimary");
}

/* ------------------------------------------------------------------ */
/* drawing: tabs                                                      */
/* ------------------------------------------------------------------ */

function drawTabs(ctx) {
  var tabH = Math.round(gH * 0.09);
  var w = Math.floor(gW / TABS.length);
  ctx.fillStyle(c("surface"));
  ctx.fillRect(0, 0, gW, tabH);

  for (var i = 0; i < TABS.length; i++) {
    var t = TABS[i];
    var x = i * w;
    var active = t.id === gActiveTab;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = (active ? "bold " : "") + Math.round(tabH * 0.38) + "px sans-serif";
    ctx.fillStyle(active ? c("accent") : c("textSecondary"));
    ctx.fillText(t.label, x + w / 2, tabH * 0.45);
    if (active) {
      ctx.fillStyle(c("accent"));
      ctx.fillRect(x + w * 0.15, tabH - 4, w * 0.7, 4);
    }
  }
  return tabH;
}

/* ------------------------------------------------------------------ */
/* drawing: main grid                                                 */
/* ------------------------------------------------------------------ */

function drawTile(ctx, x, y, tw, th, tile, val) {
  var pad = Math.round(th * 0.10);
  ctx.fillStyle(c("background"));
  ctx.fillRoundRect(x + 3, y + 3, tw - 6, th - 6, 10);

  // label
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = Math.round(th * 0.15) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  ctx.fillText(tile.label, x + pad, y + pad * 0.7);

  // value + unit
  var col = tileColor(tile.key, val);
  ctx.font = "bold " + Math.round(th * 0.40) + "px sans-serif";
  ctx.fillStyle(col);
  var txt = fmt(tile.key, val);
  ctx.fillText(txt, x + pad, y + th * 0.34);
  if (tile.unit) {
    ctx.font = Math.round(th * 0.20) + "px sans-serif";
    var vw = ctx.measureText(txt).width;
    ctx.fillText(tile.unit, x + pad + vw + 6, y + th * 0.34 + Math.round(th * 0.14));
  }
}

function drawMain(ctx, top) {
  var area = gH - top;
  // 7 primary tiles: 2 rows (4 + 3), then one row of 4 secondary tiles
  var primH = area * 0.58;
  var secH = area * 0.42;

  var cols = 4;
  var cw = Math.floor(gW / cols);
  var rh = Math.floor(primH / 2);

  for (var i = 0; i < PRIMARY_TILES.length; i++) {
    var t = PRIMARY_TILES[i];
    var row = i < 4 ? 0 : 1;
    var col = i % 4;
    drawTile(ctx, col * cw, top + row * rh, cw, rh, t, valueFor(t.key));
  }
  // empty slot in row 2 col 4: show rpm small as context
  var xtra = { key: "rpm", label: "Engine rpm", unit: "", dp: 0 };
  drawTile(ctx, 3 * cw, top + rh, cw, rh, xtra, num(v.rpm) ? Math.round(v.rpm) : null);

  var sw = Math.floor(gW / 4);
  for (var j = 0; j < SECONDARY_TILES.length; j++) {
    var s = SECONDARY_TILES[j];
    var val = s.counter
      ? (s.key === "knock" ? counters.knock : counters.misfireCount)
      : valueFor(s.key);
    drawTile(ctx, j * sw, top + primH, sw, secH, s, val);
  }
}

/* ------------------------------------------------------------------ */
/* drawing: other tabs (placeholders until we discuss them)           */
/* ------------------------------------------------------------------ */

function drawPlaceholder(ctx, top, text) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = Math.round(gH * 0.05) + "px sans-serif";
  ctx.fillStyle(c("textTertiary"));
  ctx.fillText(text, gW / 2, top + (gH - top) / 2);
}

/* ------------------------------------------------------------------ */
/* drawing: Power tab                                                 */
/* ------------------------------------------------------------------ */

var COL_POWER = "#e8452c";   // power curve (red)
var COL_TORQUE = "#3aa0ff";  // torque curve (blue)

function drawPower(ctx, top) {
  var area = gH - top;
  var numH = Math.round(area * 0.34);
  var fresh = num(power.hp) && (Date.now() - power.stamp) < STALE_MS;

  // two big number tiles: Power / Torque with current + peak lines
  var half = Math.floor(gW / 2);
  drawPowerTile(ctx, 0, top, half, numH, "Power", "hp",
    fresh ? power.hp : null, fresh ? power.peakHp : null, COL_POWER);
  drawPowerTile(ctx, half, top, gW - half, numH, "Torque", "nm",
    fresh ? power.nm : null, fresh ? power.peakNm : null, COL_TORQUE);

  drawPowerChart(ctx, 0, top + numH, gW, area - numH);
}

function drawPowerTile(ctx, x, y, tw, th, label, kind, cur, peak, col) {
  ctx.fillStyle(c("surface"));
  ctx.fillRoundRect(x + 4, y + 4, tw - 8, th - 8, 12);

  var pad = Math.round(th * 0.12);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = Math.round(th * 0.16) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  ctx.fillText(label, x + pad, y + pad * 0.6);

  // big current value
  ctx.font = "bold " + Math.round(th * 0.42) + "px sans-serif";
  ctx.fillStyle(num(cur) ? col : c("textTertiary"));
  var txt = num(cur) ? String(Math.round(cur)) : "--";
  var unit = kind === "hp" ? "hp" : "Nm";
  ctx.fillText(txt, x + pad, y + th * 0.30);
  ctx.font = Math.round(th * 0.20) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  var vw = ctx.measureText(txt).width;
  ctx.fillText(unit, x + pad + vw + 8, y + th * 0.30 + Math.round(th * 0.16));

  // peak line under the number
  ctx.font = Math.round(th * 0.17) + "px sans-serif";
  ctx.fillStyle(num(peak) ? col : c("textTertiary"));
  var ptxt = "PEAK " + (num(peak) ? String(Math.round(peak)) + " " + unit : "--");
  ctx.fillText(ptxt, x + pad, y + th * 0.76);

  // countdown ticks: shows when the peak will expire (visual only)
  if (num(peak)) {
    var ttl = gSettings.peakResetMs || PEAK_RESET_MS;
    var at = kind === "hp" ? power.peakHpAt : power.peakNmAt;
    var left = Math.max(0, ttl - (Date.now() - at));
    var frac = left / ttl;
    ctx.fillStyle(c("background"));
    ctx.fillRect(x + pad, y + th - Math.round(th * 0.10), tw - 2 * pad, 4);
    ctx.fillStyle(col);
    ctx.fillRect(x + pad, y + th - Math.round(th * 0.10), Math.round((tw - 2 * pad) * frac), 4);
  }
}

/* rolling real-time chart of hp and Nm over the last CHART_WINDOW_S seconds */
function drawPowerChart(ctx, x, y, w, h) {
  ctx.fillStyle(c("surface"));
  ctx.fillRoundRect(x + 4, y + 4, w - 8, h - 8, 12);

  var padL = Math.round(w * 0.09);
  var padR = Math.round(w * 0.03);
  var padT = Math.round(h * 0.10);
  var padB = Math.round(h * 0.14);
  var gx = x + padL, gy = y + padT;
  var gw = w - padL - padR, gh = h - padT - padB;

  var now = Date.now();
  var t0 = now - CHART_WINDOW_S * 1000;

  // scale: fixed floors, grow smoothly with the data
  var maxHp = 50, maxNm = 100;
  for (var i = 0; i < power.hist.length; i++) {
    var p = power.hist[i];
    if (p.hp > maxHp) maxHp = p.hp;
    if (p.nm > maxNm) maxNm = p.nm;
  }
  maxHp = niceCeil(maxHp, 100);
  maxNm = niceCeil(maxNm, 200);

  // grid + axis labels
  ctx.strokeStyle(c("divider") || c("textTertiary"));
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";
  ctx.font = Math.round(h * 0.09) + "px sans-serif";
  for (var g = 0; g <= 4; g++) {
    var yy = gy + gh - (gh * g / 4);
    ctx.beginPath();
    ctx.moveTo(gx, yy);
    ctx.lineTo(gx + gw, yy);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillStyle(c("textTertiary"));
    ctx.fillText(String(Math.round(maxHp * g / 4)), gx - 6, yy);
  }
  // right axis: torque scale
  ctx.textAlign = "left";
  for (var g2 = 0; g2 <= 4; g2++) {
    var yy2 = gy + gh - (gh * g2 / 4);
    ctx.fillStyle(COL_TORQUE);
    ctx.fillText(String(Math.round(maxNm * g2 / 4)), gx + gw + 4, yy2);
  }
  // time axis ticks every 10 s
  ctx.textAlign = "center";
  ctx.fillStyle(c("textTertiary"));
  for (var ts = 0; ts <= CHART_WINDOW_S; ts += 10) {
    var tx = gx + gw * ts / CHART_WINDOW_S;
    ctx.fillText(ts === CHART_WINDOW_S ? "now" : "-" + (CHART_WINDOW_S - ts) + "s", tx, gy + gh + padB * 0.55);
  }

  // series
  drawSeries(ctx, power.hist, gx, gy, gw, gh, t0, now, "hp", maxHp, COL_POWER);
  drawSeries(ctx, power.hist, gx, gy, gw, gh, t0, now, "nm", maxNm, COL_TORQUE);

  // legend
  var ly = y + Math.round(h * 0.045);
  ctx.textAlign = "left";
  ctx.font = Math.round(h * 0.09) + "px sans-serif";
  ctx.fillStyle(COL_POWER);
  ctx.fillRect(gx, ly - 4, Math.round(w * 0.03), 4);
  ctx.fillText("Power, hp", gx + Math.round(w * 0.04), ly);
  var lxo = gx + Math.round(w * 0.04) + ctx.measureText("Power, hp").width + Math.round(w * 0.04);
  ctx.fillStyle(COL_TORQUE);
  ctx.fillRect(lxo, ly - 4, Math.round(w * 0.03), 4);
  ctx.fillText("Torque, Nm", lxo + Math.round(w * 0.04), ly);
}

function niceCeil(val, step) {
  return Math.ceil(val / step) * step;
}

function drawSeries(ctx, hist, gx, gy, gw, gh, t0, now, key, maxVal, col) {
  if (!hist.length) return;
  ctx.strokeStyle(col);
  ctx.lineWidth = 3;
  ctx.beginPath();
  var started = false;
  for (var i = 0; i < hist.length; i++) {
    var p = hist[i];
    if (p.t < t0) continue;
    var px = gx + gw * (p.t - t0) / (now - t0);
    var py = gy + gh - gh * Math.min(p[key], maxVal) / maxVal;
    if (!started) { ctx.moveTo(px, py); started = true; }
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  // leading dot at the newest sample
  if (started && hist.length) {
    var last = hist[hist.length - 1];
    var lx = gx + gw * (last.t - t0) / (now - t0);
    var ly = gy + gh - gh * Math.min(last[key], maxVal) / maxVal;
    ctx.fillStyle(col);
    ctx.fillCircle && ctx.fillCircle(lx, ly, 5);
  }
}

/* ------------------------------------------------------------------ */
/* render loop                                                        */
/* ------------------------------------------------------------------ */

var gTimer = null;

function render() {
  if (!gCanvas) return;
  var ctx = gCanvas.getContext("2d");
  ctx.fillStyle(c("background"));
  ctx.fillRect(0, 0, gW, gH);

  var top = drawTabs(ctx);
  if (gActiveTab === "main") drawMain(ctx, top);
  else if (gActiveTab === "power") drawPower(ctx, top);
  else if (gActiveTab === "gauge") drawPlaceholder(ctx, top, "Boost gauge \u2014 next step");
  else drawPlaceholder(ctx, top, "Session logs \u2014 next step");
}

/* ------------------------------------------------------------------ */
/* power & torque                                                     */
/* ------------------------------------------------------------------ */

var gTorqueMap = null;   // cached interpolation table from app.json config

function loadVolumeL() {
  var cfg = gConfig && gConfig.engine;
  if (cfg && num(cfg.displacementL)) return cfg.displacementL;
  return 3.0;            // B58 default; change in app.json for other engines
}

function torqueTable() {
  if (gTorqueMap) return gTorqueMap;
  var cfg = gConfig && gConfig.engine;
  var raw = cfg && cfg.torqueVsRpm;
  var map = [];
  if (raw && raw.length) {
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] && raw[i].length === 2 && num(raw[i][0]) && num(raw[i][1])) {
        map.push([raw[i][0], raw[i][1]]);
      }
    }
  }
  map.sort(function (a, b) { return a[0] - b[0]; });
  gTorqueMap = map.length ? map : [[600, 100], [1300, 450], [5000, 450], [7000, 380]];
  return gTorqueMap;
}

/* peak torque at the current rpm from the manufacturer curve */
function peakTorqueNm(rpm) {
  var m = torqueTable();
  if (rpm <= m[0][0]) return m[0][1];
  var last = m[m.length - 1];
  if (rpm >= last[0]) return last[1];
  for (var i = 1; i < m.length; i++) {
    if (rpm <= m[i][0]) {
      var x0 = m[i - 1][0], y0 = m[i - 1][1], x1 = m[i][0], y1 = m[i][1];
      return y0 + (y1 - y0) * (rpm - x0) / (x1 - x0);
    }
  }
  return last[1];
}

/* Engine load fraction (0..~1.2). Priority:
 * 1. BMW DME DID F08A "LASTWELL_PZYL" — instantaneous per-cylinder charge
 *    information in % (direct, exact, tune-independent);
 * 2. OBD PID 0x63 (engine load %, direct-MAP based) via the F463 alias;
 * 3. MAP / baro fallback estimate. */
function calcLoad() {
  if (isFresh("loadDirect")) return Math.min(1.2, Math.max(0, v.loadDirect / 100));

  if (isFresh("boost") && isFresh("baro") && num(v.baro) && v.baro > 0) {
    var mapKpa = v.boost;                       // absolute charge pressure
    var est = mapKpa / v.baro;                  // 1.0 at atmospheric
    if (est > 1) est = 1 + (est - 1) * 1.5;     // boost counts ~1.5x toward load
    return Math.min(1.2, Math.max(0, est));
  }
  return null;
}

function computePower() {
  if (!num(v.rpm) || v.rpm < 400) return false;
  var load = calcLoad();
  if (!num(load)) return false;
  var tq = peakTorqueNm(v.rpm) * load;          // Nm at this rpm/load
  if (!num(tq) || tq < 0) return false;
  var kw = tq * v.rpm * 2 * Math.PI / 60 / 1000;
  power.nm = tq;
  power.kw = kw;
  power.hp = kw * 1.01387;                      // metric horsepower (PS)
  power.stamp = Date.now();
  pushHistory();
  updatePeaks();
  return true;
}

function pushHistory() {
  var now = Date.now();
  power.hist.push({ t: now, hp: power.hp, nm: power.nm });
  var cutoff = now - CHART_WINDOW_S * 1000;
  while (power.hist.length && power.hist[0].t < cutoff) power.hist.shift();
  if (power.hist.length > 400) power.hist.splice(0, power.hist.length - 400);
}

function resetPeaks() {
  power.peakHp = null; power.peakNm = null;
  power.peakHpAt = 0; power.peakNmAt = 0;
}

function updatePeaks() {
  var now = Date.now();
  var ttl = gSettings.peakResetMs || PEAK_RESET_MS;
  // rolling reset: peaks drop out ttl after they were set
  if (num(power.peakHp) && now - power.peakHpAt > ttl) power.peakHp = null;
  if (num(power.peakNm) && now - power.peakNmAt > ttl) power.peakNm = null;
  if (!num(power.peakHp) || power.hp > power.peakHp) { power.peakHp = power.hp; power.peakHpAt = now; }
  if (!num(power.peakNm) || power.nm > power.peakNm) { power.peakNm = power.nm; power.peakNmAt = now; }
}

/* ------------------------------------------------------------------ */
/* SOME/IP signals                                                    */
/* ------------------------------------------------------------------ */

function onSignal(name, value) {
  gLastSignalMs = Date.now();   // real car data present -> demo mode steps back
  switch (name) {
    case "statusEngineSpeed2": {
      var raw = Number(value);
      var sc = gConfig.scaling.rpm;
      v.rpm = (raw === sc.invalid) ? null : raw * sc.factor + sc.offset;
      break;
    }
    case "statusEngineTemperature": {
      var r2 = Number(value);
      var sc2 = gConfig.scaling.engineTemp;
      v.coolant = (r2 === sc2.invalid) ? null : r2 * sc2.factor + sc2.offset;
      break;
    }
    case "statusOilTemperature": {
      // instrument cluster COM signal: raw degC + 40, 235 = invalid
      var rO = Number(value);
      if (rO !== 235 && isFinite(rO)) { v.oilTemp = rO - 40; markFresh("oilTemp"); }
      break;
    }
    case "statusCarSpeed2": {
      v.speed = Number(value) * gConfig.scaling.speed.factor;
      break;
    }
    case "displayBoostPressure": {
      // FES boost scaling is a guess until calibrated; keep raw in the log
      var r3 = Number(value);
      var sc3 = gConfig.scaling.boostFes;
      if (r3 !== sc3.invalid) {
        v.boostFes = r3 * sc3.factor + sc3.offset;
        log.debug("raw FES boost", r3, "->", v.boostFes);
      }
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* DME polling over UDS/OBD                                           */
/* ------------------------------------------------------------------ */

var gPollTimer = null;
var gPollIdx = 0;
var gResolved = {};   // metric -> candidate that passed plausibility
var gDmeCfg = null;   // config.dme from app.json (set in init)

/* metric names in poll order (baro first: boost needs it) */
var POLL_METRICS = ["iat", "egt", "oilPressAbs", "boost", "lambda",
                    "mixtureAdapt", "knockRetard", "baro", "loadDirect",
                    "gearbox", "voltage"];

function metricList(metric) {
  var list = gDmeCfg[metric];
  if (!list) return null;
  if (Object.prototype.toString.call(list) === "[object Array]") return list;
  // single-candidate object form: wrap it
  if (typeof list === "object") return [list];
  return null;
}

function nextCandidate(metric, cand) {
  if (gResolved[metric]) return;           // already locked onto a good one
  var list = metricList(metric);
  if (!list) return;
  var idx = list.indexOf(cand);
  gPollOrder[metric] = (idx + 1) % list.length;
}

var gPollOrder = {};  // metric -> index of the candidate to try next

function decode(rawHex, cand) {
  // rawHex: string like "AABBCCDD"; returns scaled value or null
  if (typeof rawHex !== "string" || !rawHex.length) return null;
  var bytes = [];
  for (var i = 0; i < rawHex.length / 2; i++) {
    bytes.push(parseInt(rawHex.substr(i * 2, 2), 16));
  }
  var at = cand.at || 0;
  var n = cand.bytes || 1;
  var val = 0;
  for (var k = 0; k < n; k++) val = val * 256 + (bytes[at + k] || 0);
  if (cand.signed && val >= Math.pow(2, 8 * n - 1)) val -= Math.pow(2, 8 * n);
  return val * cand.factor + (cand.offset || 0);
}

function storeMetric(vkey, val, cand) {
  if (!num(val)) return false;
  if (cand && (val < cand.min || val > cand.max)) return false;
  v[vkey] = val;
  v.stamp[vkey] = Date.now();
  return true;
}

/* side effects on a fresh reading */
function afterStore(metric, val) {
  if (metric === "knockRetard") handleKnock(val);
  if (metric === "oilPressAbs") v.oilPress = val - (num(v.baro) ? v.baro / 10 : 1.0);
  if (metric === "baro" && isFresh("oilPressAbs")) {
    v.oilPress = v.oilPressAbs - v.baro / 10;   // refresh relative pressure
  }
}

function pollOne() {
  var metric = POLL_METRICS[gPollIdx % POLL_METRICS.length];
  gPollIdx++;

  var list = metricList(metric);
  if (!list || !list.length) return;

  var cand = gResolved[metric] || list[gPollOrder[metric] || 0];
  var req = buildReadRequest(metric, cand);
  if (!req) return;

  diagnostic.readData(req.ecu, req.ids, function (res) {
    if (!res || !res.data) {
      nextCandidate(metric, cand);   // this DID may not exist on this DME
      return;
    }
    var val = decode(res.data, cand); // rawHex -> scaled physical value
    if (storeMetric(metric, val, cand)) {
      gResolved[metric] = cand;
      afterStore(metric, val);
    } else {
      nextCandidate(metric, cand);   // implausible: try the next candidate
    }
  });
}

/* Power/torque sampler: recompute and record a chart sample at a steady
 * cadence independent of the DME poll rotation. Peaks also expire here so
 * they reset even when values drop out (lift-off). */
var gPowerTimer = null;

function startPowerSampler() {
  stopPowerSampler();
  gPowerTimer = setInterval(function () {
    computePower();
    var now = Date.now();
    var ttl = gSettings.peakResetMs || PEAK_RESET_MS;
    if (num(power.peakHp) && now - power.peakHpAt > ttl) power.peakHp = null;
    if (num(power.peakNm) && now - power.peakNmAt > ttl) power.peakNm = null;
  }, 100);
}

function stopPowerSampler() {
  if (gPowerTimer) clearInterval(gPowerTimer);
  gPowerTimer = null;
}

function buildReadRequest(metric, cand) {
  var ecu = cand.ecu !== undefined ? cand.ecu : gDmeCfg.ecu;
  // "F4xx": first byte 0xF4 = OBD request id, second byte = PID
  if (cand.did && /^F4/i.test(cand.did)) {
    return { ecu: ecu, ids: [{ type: "obdid", id: parseInt(cand.did.substr(2), 16) }] };
  }
  if (cand.did) return { ecu: ecu, ids: [{ type: "did", id: parseInt(cand.did, 16) }] };
  if (cand.obd) return { ecu: ecu, ids: [{ type: "obdid", id: parseInt(cand.obd, 16) }] };
  return null;
}

/* knock: rising edge of negative retard while boosting counts one event */
function handleKnock(retard) {
  var boosting = currentBoost();
  var active = num(retard) && retard < -0.5;
  if (active && !prev.knockActive && num(boosting) && boosting > KNOCK_BOOST_GATE) {
    counters.knock++;
    log.info("knock event #" + counters.knock, "boost", boosting, "retard", retard);
  }
  prev.knockActive = active;
}

/* misfire: OBD service 06, one MID per cylinder; the DME reports the number
 * of misfires in the current driving cycle (it resets at each cycle start).
 * Increments between polls count as new events - but only while boost is
 * above the gate (> 0.5 bar), same rule as knock. */
var MISFIRE_MIDS = ["A2", "A3", "A4", "A5"];   // cylinders 1..4 (extend to A6 for I6)

function pollMisfires() {
  var cfg = gDmeCfg.misfire;
  if (!cfg || !cfg.tid) return;
  var ecu = cfg.ecu !== undefined ? cfg.ecu : gDmeCfg.ecu;
  var boosting = currentBoost();
  var gated = num(boosting) && boosting > KNOCK_BOOST_GATE;

  MISFIRE_MIDS.forEach(function (mid, cyl) {
    diagnostic.testOBD({ tid: cfg.tid, mid: mid }, function (res) {
      if (!res || !res.data) return;
      var total = parseInt(res.data, 16) || 0;
      var prevKey = "misCyl" + cyl;
      var old = prev[prevKey];
      prev[prevKey] = total;
      if (old === undefined) return;          // first read: baseline only
      if (total <= old) return;               // no new events (or cycle reset)
      if (gated) {
        counters.misfireCount += total - old;
        log.info("misfires cyl" + (cyl + 1) + " +" + (total - old), "boost", boosting);
      }
    });
  });
}

function startPolling() {
  var ms = gSettings.pollMs || 1000;
  stopPolling();
  gPollTimer = setInterval(function () {
    pollOne();
    if (gPollIdx % 4 === 1) pollMisfires();
  }, Math.max(250, ms / 4));
}

function stopPolling() {
  if (gPollTimer) clearInterval(gPollTimer);
  gPollTimer = null;
}

/* ------------------------------------------------------------------ */
/* demo mode (simulated data so the UI can be checked without the car) */
/* ------------------------------------------------------------------ */

function demoOn() {
  var mode = gSettings.demo || "auto";
  if (mode === "on") return true;
  if (mode === "off") return false;
  // auto: active when no vehicle signal arrived for a while (not in the car)
  return Date.now() - gLastSignalMs > 5000;
}

function demoStep() {
  gDemoT += 0.35;
  var t = gDemoT;
  var load = Math.max(0, Math.sin(t * 0.4));            // 0..1 throttle waves
  function set(key, val) { v[key] = val; markFresh(key); }

  set("rpm", 900 + load * 5200 + 150 * Math.sin(t * 2.3));
  set("boost", 101 + load * 135);                        // kPa absolute
  set("baro", 100.5);                                    // kPa
  set("boostFes", load * 1.32);                          // bar, relative
  set("iat", 28 + load * 22);
  set("egt", 480 + load * 430);
  set("oilPressAbs", 1.0 + load * 4.6 + 10.0);           // bar absolute
  set("lambda", 0.99 + 0.07 * load);
  set("mixtureAdapt", 1.0);
  set("coolant", 92 + 4 * Math.sin(t * 0.15));
  set("oilTemp", 95 + load * 30);
  set("voltage", 13.9 + 0.3 * Math.sin(t));
  set("gearbox", 78 + load * 25);
  afterStore("oilPressAbs", v.oilPressAbs);              // relative pressure

  // power/torque for the Power tab: load % straight from the demo wave
  set("loadDirect", load * 100);
  computePower();

  // occasional knock event under load -> counter ticks (boost > 0.5 gate)
  var retard = (load > 0.7 && Math.sin(t * 1.7) > 0.97) ? -3.5 : 0;
  set("knockRetard", retard);
  handleKnock(retard);

  // occasional misfire burst under load
  if (load > 0.6 && Math.sin(t * 2.9) > 0.985) counters.misfireCount++;
}

function startDemo() {
  stopDemo();
  gDemoTimer = setInterval(function () {
    if (demoOn()) demoStep();
  }, REFRESH_MS);
}

function stopDemo() {
  if (gDemoTimer) clearInterval(gDemoTimer);
  gDemoTimer = null;
}

/* ------------------------------------------------------------------ */
/* settings                                                           */
/* ------------------------------------------------------------------ */

function loadSettings() {
  settingsStore.loadAll(function (s) {
    gSettings = s || {};
    startPolling();
    startPowerSampler();
    startDemo();
  });
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                          */
/* ------------------------------------------------------------------ */

var gConfig = null;

function init(app) {
  gConfig = app.config;
  gDmeCfg = gConfig.dme;

  signals.subscribe("statusEngineSpeed2", onSignal);
  signals.subscribe("statusEngineTemperature", onSignal);
  signals.subscribe("statusOilTemperature", onSignal);
  signals.subscribe("statusCarSpeed2", onSignal);
  signals.subscribe("displayBoostPressure", onSignal);

  loadSettings();

  os.onchange = function (screen) {
    if (screen !== "MAIN") { stopPolling(); stopPowerSampler(); return; }
    var canvas = os.getScreen("MAIN").canvas;
    gCanvas = canvas;
    gW = canvas.width; gH = canvas.height;
    startPolling();
    startPowerSampler();
    if (gTimer) clearInterval(gTimer);
    // Power tab redraws faster so the chart looks real-time
    gTimer = setInterval(render, gActiveTab === "power" ? POWER_REFRESH_MS : REFRESH_MS);
    render();
  };

  os.buttonhandler = function (button) {
    // touch handling: tab strip taps are processed in render coords
    return false;
  };

  os.touchhandler = function (x, y) {
    var tabH = Math.round(gH * 0.09);
    if (y <= tabH) {
      var w = Math.floor(gW / TABS.length);
      var idx = Math.min(TABS.length - 1, Math.floor(x / w));
      gActiveTab = TABS[idx].id;
      // Power tab runs at a faster redraw for the real-time chart
      if (gTimer) {
        clearInterval(gTimer);
        gTimer = setInterval(render, gActiveTab === "power" ? POWER_REFRESH_MS : REFRESH_MS);
      }
      render();
    }
  };
}

exports.init = init;
