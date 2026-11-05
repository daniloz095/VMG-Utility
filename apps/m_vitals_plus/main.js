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
var KNOCK_BOOST_GATE = 0.5;    // bar; counters only tick above this boost
var STALE_MS = 6000;           // a DME value older than this is "not available"

var TABS = [
  { id: "main", label: "MAIN" },
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
  else if (gActiveTab === "gauge") drawPlaceholder(ctx, top, "Boost gauge \u2014 next step");
  else drawPlaceholder(ctx, top, "Session logs \u2014 next step");
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
                    "mixtureAdapt", "knockRetard", "baro",
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
    if (screen !== "MAIN") { stopPolling(); return; }
    var canvas = os.getScreen("MAIN").canvas;
    gCanvas = canvas;
    gW = canvas.width; gH = canvas.height;
    startPolling();
    if (gTimer) clearInterval(gTimer);
    gTimer = setInterval(render, REFRESH_MS);
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
      render();
    }
  };
}

exports.init = init;
