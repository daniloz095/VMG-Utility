/*
 * UI simulator — render the app's canvas screens to PNG files, without
 * the car and without oap-sdk.
 *
 *   node kit/tools/simulate.js m_vitals_plus              # all tabs
 *   node kit/tools/simulate.js m_vitals_plus power        # one tab only
 *   node kit/tools/simulate.js m_vitals_plus --out /tmp/ui
 *
 * How it works: main.js is loaded against a mock of the OAP modules
 * (os/signals/settings/diagnostic/log) plus a pure-JS 2D canvas that
 * records every draw call. The recorded frame is replayed into an SVG at
 * the MGU screen resolution (1920x720); a tiny python cairosvg step turns
 * it into a PNG. Demo mode is forced ON so every tile shows plausible
 * simulated values after a few seconds of runtime.
 */

"use strict";

var fs = require("fs");
var path = require("path");
var Module = require("module");
var child_process = require("child_process");

var APPS_DIR = process.env.SIM_APPS_DIR || path.join(__dirname, "..", "..", "apps");
var SCREEN_W = 1920;
var SCREEN_H = 720;

/* ------------------------------------------------------------------ */
/* command line                                                        */
/* ------------------------------------------------------------------ */

var args = process.argv.slice(2);
var appName = null;
var tabFilter = null;
var outDir = null;
for (var i = 0; i < args.length; i++) {
  if (args[i] === "--out") { outDir = args[++i]; continue; }
  if (!appName) appName = args[i];
  else tabFilter = args[i];
}
if (!appName) {
  console.error("usage: node kit/tools/simulate.js <app> [tab] [--out dir]");
  process.exit(1);
}
var appDir = path.join(APPS_DIR, appName);
var appJson = JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8"));
var mainJs = fs.readFileSync(path.join(appDir, "main.js"), "utf8");
if (!outDir) outDir = path.join(appDir, "sim");
fs.mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------------ */
/* recording 2D context                                                */
/* ------------------------------------------------------------------ */

function makeRecorder() {
  var ops = [];
  var rec = { recording: true };       // shared gate: push() checks it
  var st = { fillStyle: "#ffffff", strokeStyle: "#ffffff", lineWidth: 1,
             font: "16px sans-serif", textAlign: "left", textBaseline: "alphabetic" };
  function push(o) { if (rec.recording) ops.push(o); }
  var d = { segs: [], closed: false };   // current path, for SVG replay
  var ctx = {
    setTransform: function () {}, save: function () {}, restore: function () {},
    beginPath: function () { d.segs = []; }, closePath: function () { d.closed = true; }, clip: function () {},
    moveTo: function (x, y) { push({ op: "moveTo", x: x, y: y }); d.segs.push({ t: "m", x: x, y: y }); },
    lineTo: function (x, y) { push({ op: "lineTo", x: x, y: y }); d.segs.push({ t: "l", x: x, y: y }); },
    quadraticCurveTo: function () {}, bezierCurveTo: function () {}, rect: function () {},
    arc: function (x, y, r, a0, a1, ccw) {
      if (a0 === undefined) { a0 = 0; a1 = Math.PI * 2; }
      push({ op: "arc", x: x, y: y, r: r });
      d.segs.push({ t: "a", x: x, y: y, r: r, a0: a0, a1: a1, ccw: !!ccw });
    },
    fillRect: function (x, y, w, h) { push({ op: "fillRect", x: x, y: y, w: w, h: h, style: st.fillStyle }); },
    strokeRect: function (x, y, w, h) { push({ op: "strokeRect", x: x, y: y, w: w, h: h, style: st.strokeStyle }); },
    fillRoundRect: function (x, y, w, h, r) { push({ op: "fillRoundRect", x: x, y: y, w: w, h: h, r: r, style: st.fillStyle }); },
    stroke: function () { push({ op: "strokePath", style: st.strokeStyle, lw: st.lineWidth, path: d.segs.slice(), closed: d.closed }); d.segs = []; d.closed = false; },
    fill: function () { push({ op: "fillPath", style: st.fillStyle, path: d.segs.slice(), closed: d.closed }); d.segs = []; d.closed = false; },
    fillCircle: function (x, y, r) { push({ op: "fillCircle", x: x, y: y, r: r, style: st.fillStyle }); },
    fillText: function (t, x, y) {
      push({ op: "fillText", t: String(t), x: x, y: y, style: st.fillStyle,
                 font: st.font, align: st.textAlign, baseline: st.textBaseline });
    },
    measureText: function (t) {
      var m = /(\d+(?:\.\d+)?)px/.exec(st.font);
      var px = m ? parseFloat(m[1]) : 16;
      var bold = /bold/.test(st.font);
      return { width: String(t).length * px * (bold ? 0.62 : 0.55) };
    }
  };
  // NOTE: the app uses the mgu-renderd calling convention where fillStyle /
  // strokeStyle are SETTER FUNCTIONS: ctx.fillStyle("#fff"). We expose them
  // as callable functions that also work as plain assignments.
  function styleAccessor(key) {
    var fn = function (v) { st[key] = v; };
    Object.defineProperty(fn, "value", {
      get: function () { return st[key]; },
      set: function (v) { st[key] = v; }
    });
    return fn;
  }
  ctx.fillStyle = styleAccessor("fillStyle");
  ctx.strokeStyle = styleAccessor("strokeStyle");
  Object.defineProperty(ctx, "lineWidth", { get: function () { return st.lineWidth; }, set: function (v) { st.lineWidth = v; } });
  Object.defineProperty(ctx, "font", { get: function () { return st.font; }, set: function (v) { st.font = v; } });
  Object.defineProperty(ctx, "textAlign", { get: function () { return st.textAlign; }, set: function (v) { st.textAlign = v; } });
  Object.defineProperty(ctx, "textBaseline", { get: function () { return st.textBaseline; }, set: function (v) { st.textBaseline = v; } });
  Object.defineProperty(ctx, "globalAlpha", { get: function () { return 1; }, set: function () {} });
  Object.defineProperty(ctx, "lineJoin", { get: function () { return "miter"; }, set: function () {} });
  Object.defineProperty(ctx, "lineCap", { get: function () { return "butt"; }, set: function () {} });
  return { ctx: ctx, ops: ops, rec: rec };
}

/* ------------------------------------------------------------------ */
/* theme colors (approximation of the dark MGU theme)                  */
/* ------------------------------------------------------------------ */

var THEME = {
  background: "#14161a",
  surface: "#1f2329",
  divider: "#33383f",
  textPrimary: "#eef1f4",
  textSecondary: "#9aa3ad",
  textTertiary: "#5b636c",
  accent: "#0f9dca",
  warning: "#f0a12f",
  alert: "#e8452c",
  success: "#3fbf5a"
};

/* ------------------------------------------------------------------ */
/* module mocks                                                        */
/* ------------------------------------------------------------------ */

var recorder = makeRecorder();
var canvas = { width: SCREEN_W, height: SCREEN_H, getContext: function () { return recorder.ctx; } };
var gSimSignalCb = null;   // the app's onSignal callback (via signals.subscribe)

// Simulated SOME/IP feed: a few plausible push values (demo mode is forced
// ON via settings anyway; this just mirrors what the car would push).
var gRealNow = Date.now.bind(Date);
var gSimNow = gRealNow();
function simTick() {
  gSimNow += 200;
  if (gSimSignalCb) {
    var rpmRaw = Math.round((1200 + 800 * Math.sin(gSimNow / 900)) / 0.25);
    gSimSignalCb("statusEngineSpeed2", rpmRaw);
  }
}

var mocks = {
  os: {
    theme: function () { return { colors: THEME }; },
    getScreen: function () { return { canvas: canvas }; },
    onchange: null,
    buttonhandler: null,
    touchhandler: null,
    exit: function () {},
    navigateTo: function () {}
  },
  signals: { subscribe: function (n, cb) { gSimSignalCb = cb; } },
  settings: { loadAll: function (cb) { cb({ demo: "on" }); } },
  diagnostic: {
    // UDS DID reads are answered with plausible values keyed by the DID hex,
    // so the app's real decode/store pipeline runs in the simulation too.
    readData: function (ecu, ids, cb) {
      var id = ids && ids[0] ? ids[0].id : null;
      if (id === null || !SIM_DIDS.hasOwnProperty(id)) { cb(null); return; }   // demo mode fills these
      var vhex = SIM_DIDS[id];
      if (typeof vhex === "function") vhex = vhex();
      if (vhex === null) { cb(null); return; }        // simulate "not available"
      cb({ data: vhex });
    },
    testOBD: function (req, cb) { cb(null); }
  },
  log: {
    of: function () {
      return { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
    }
  }
};

/* simulated DME responses: did -> raw big-endian hex (or fn() per poll).
 * Scales mirror the FIRST app.json candidate of each metric so decode()
 * lands on sane values; metrics without an entry fall back to demo mode. */
function simWave(frac) { return Math.max(0, Math.sin(gSimNow / 1000 * frac)); }
var SIM_DIDS = {
  0x580F: function () { return hex8(Math.round((28 + 22 * simWave(0.4) + 48) / 0.75)); },       // IAT degC
  0x5896: function () { return hex16(Math.round((480 + 430 * simWave(0.4) + 273.14) * 10)); },   // EGT
  0x586F: function () { return hex16(Math.round((1.0 + 4.6 * simWave(0.4) + 10.0) * 1000)); },   // oil press abs hPa->bar
  0x4205: function () { return hex16(Math.round((101 + 135 * simWave(0.4)) * 128)); },            // charge pressure kPa->hPa*128
  0x4201: function () { return hex16(Math.round(100.5 * 256)); },                                  // baro kPa -> raw*1/256 hPa
  0x5889: function () { return hex16(Math.round((0.99 + 0.07 * simWave(0.4)) / 0.000244140625)); },// lambda
  0x4A9D: function () { return hex16(Math.round(1.0 / 3.0517578e-05)); },                          // mixture adapt
  0x554C: function () { return hex8(Math.round((simWave(0.4) > 0.7 && Math.sin(gSimNow / 1000 * 1.7) > 0.97 ? -3.5 : 0) / 0.375)); }, // knock retard deg
  0xF08A: function () { return hex16(Math.round(simWave(0.4) * 100 / 0.0015259022)); },            // load %
  0x6000: function () { return hex8(Math.round(78 + 25 * simWave(0.4) + 40)); },                   // gearbox temp
  0x5853: function () { return hex16(Math.round((13.9 + 0.3 * Math.sin(gSimNow / 1000)) * 1000)); },// voltage mV
  0x4185: function () { return hex16(Math.round((38 + 246 * simWave(0.4) + 4 * Math.sin(gSimNow / 1000 * 3.1)) * 1000)); }, // rail actual hPa
  0x4184: function () { return hex16(Math.round((40 + 250 * simWave(0.4)) * 1000)); },             // rail requested hPa
  0x554B: function () { return hex8(Math.round((8 + 22 * simWave(0.4)) / 0.375)); }                // ignition advance deg
};

function hex8(n) { n = ((n % 256) + 256) % 256; return ("0" + n.toString(16)).slice(-2).toUpperCase(); }
function hex16(n) { n = ((n % 65536) + 65536) % 65536; return ("000" + n.toString(16)).slice(-4).toUpperCase(); }

var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return origLoad.apply(this, arguments);
};

/* ------------------------------------------------------------------ */
/* run the app for N simulated seconds                                 */
/* ------------------------------------------------------------------ */

/* synchronous timer driver: setInterval/setTimeout callbacks run on the
 * simulated clock, so N "seconds" of runtime finish instantly */
var gTimers = [];
var gTimerId = 1;
global.setInterval = function (fn, ms) {
  var id = gTimerId++;
  gTimers.push({ id: id, fn: fn, ms: ms, next: gSimNow + ms, repeat: true });
  return id;
};
global.setTimeout = function (fn, ms) {
  var id = gTimerId++;
  gTimers.push({ id: id, fn: fn, ms: ms || 0, next: gSimNow + (ms || 0), repeat: false });
  return id;
};
global.clearInterval = global.clearTimeout = function (id) {
  for (var i = 0; i < gTimers.length; i++) if (gTimers[i].id === id) { gTimers.splice(i, 1); return; }
};

function advance(ms) {
  var end = gSimNow + ms;
  var guard = 0;
  while (guard++ < 2000000) {
    var due = null;
    for (var i = 0; i < gTimers.length; i++) {
      var t = gTimers[i];
      if (t.next <= end && (!due || t.next < due.next)) due = t;
    }
    if (!due) break;
    gSimNow = Math.max(gSimNow, due.next);
    if (due.repeat) due.next = gSimNow + due.ms;
    else { var ix = gTimers.indexOf(due); if (ix >= 0) gTimers.splice(ix, 1); }
    try { due.fn(); } catch (e) { console.error("timer cb threw:", e.stack || e); process.exit(1); }
  }
  gSimNow = end;
}

var gAppExports = null;   // the app's module.exports (test hooks in ._sim)

function runApp(seconds, onReady) {
  var mod = { exports: {} };
  // the app gets its OWN Date object on the simulated clock; the tool keeps
  // the real one (otherwise setTimeout(…,60) below would never fire)
  // Simulated clock: callable as new Date() AND plain function/timestamp.
  // The app does `new Date(e.t).getHours()` for log timestamps, so the
  // constructor must accept a ms timestamp and expose real getters.
  function SimDate(ts) {
    if (!(this instanceof SimDate)) return new SimDate(ts);
    this._t = (ts === undefined) ? gSimNow : ts;
  }
  SimDate.prototype.getHours = function () {
    return Math.floor(((this._t % 86400000) + 86400000) % 86400000 / 3600000);
  };
  SimDate.prototype.getMinutes = function () {
    return Math.floor(((this._t % 3600000) + 3600000) % 3600000 / 60000);
  };
  SimDate.prototype.getSeconds = function () {
    return Math.floor(((this._t % 60000) + 60000) % 60000 / 1000);
  };
  SimDate.prototype.getTime = function () { return this._t; };
  SimDate.now = function () { return gSimNow; };
  new Function("exports", "require", "module", "__filename", "__dirname", "Date", mainJs)
    (mod.exports, require, mod, path.join(appDir, "main.js"), appDir, SimDate);
  gAppExports = mod.exports;

  var app = { config: appJson.config, settings: {} };
  try {
    mod.exports.init(app);            // registers loadSettings -> setTimeout(0)
    // flush: run the settings-load timeout without re-arming any interval
    var dueQ = gTimers.slice();
    gTimers.length = 0;
    for (var qi = 0; qi < dueQ.length; qi++) {
      var t = dueQ[qi];
      if (!t.repeat || t.next <= gSimNow + 1) {
        try { t.fn(); } catch (e) { console.error("cb threw:", e.stack); }
      } else {
        gTimers.push(t);   // keep real intervals for advance() to drive
      }
    }
    if (mocks.os.onchange) mocks.os.onchange("MAIN");
    // simulate `seconds` seconds of runtime: demo steps + render ticks
    for (var s = 0; s < seconds * 5; s++) { simTick(); advance(200); }
  } catch (e) {
    console.error("startup threw:", e.stack || e);
    process.exit(1);
  }
  onReady();
}

/* ------------------------------------------------------------------ */
/* replay recorded ops into an SVG                                     */
/* ------------------------------------------------------------------ */

/* rewind the app's demo wave so the simulated speed is at standstill;
 * needs a following advance() tick for demoStep to push the new values. */
function gDemoRewind() {
  var sim = gAppExports && gAppExports._sim;
  if (!sim) return;
  // demoStep derives speed from its own phase counter; find the timer that
  // runs it and reset the phase via the exported hook when available, else
  // simply stop feeding load: set counters/knock aside and let the wave run
  if (typeof sim.rewindDemo === "function") { sim.rewindDemo(); return; }
}

/* force one synchronous render frame (used after lap STOP to capture the
 * frozen results screen) */
function renderOnce() {
  var sim = gAppExports && gAppExports._sim;
  if (sim && typeof sim.render === "function") sim.render();
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                   .replace(/"/g, "&quot;");
}

function parseFont(fontStr) {
  var bold = /bold/.test(fontStr);
  var m = /(\d+(?:\.\d+)?)px/.exec(fontStr);
  return { size: m ? parseFloat(m[1]) : 16, bold: bold };
}

/* Convert a recorded path (moveTo/lineTo/arc segments) into SVG path data. */
function pathD(segs, closed) {
  var s = "";
  for (var i = 0; i < segs.length; i++) {
    var g = segs[i];
    if (g.t === "m") s += "M" + g.x.toFixed(1) + " " + g.y.toFixed(1) + " ";
    else if (g.t === "l") s += "L" + g.x.toFixed(1) + " " + g.y.toFixed(1) + " ";
    else if (g.t === "a") {
      var sweep = g.ccw ? 0 : 1;
      var delta = g.ccw ? (g.a0 - g.a1) : (g.a1 - g.a0);
      while (delta < -1e-9) delta += Math.PI * 2;
      if (delta > Math.PI * 2 - 1e-9) delta = Math.PI * 2;   // full circle
      var largeArc = delta > Math.PI ? 1 : 0;
      var x0 = g.x + g.r * Math.cos(g.a0), y0 = g.y + g.r * Math.sin(g.a0);
      var x1 = g.x + g.r * Math.cos(g.a1), y1 = g.y + g.r * Math.sin(g.a1);
      s += "M" + x0.toFixed(1) + " " + y0.toFixed(1) + " ";
      if (delta >= Math.PI * 2 - 1e-6) {
        var xm = g.x + g.r * Math.cos(g.a0 + Math.PI), ym = g.y + g.r * Math.sin(g.a0 + Math.PI);
        s += "A" + g.r.toFixed(1) + " " + g.r.toFixed(1) + " 0 1 " + sweep + " " + xm.toFixed(1) + " " + ym.toFixed(1) + " ";
        s += "A" + g.r.toFixed(1) + " " + g.r.toFixed(1) + " 0 1 " + sweep + " " + x0.toFixed(1) + " " + y0.toFixed(1) + " ";
      } else {
        s += "A" + g.r.toFixed(1) + " " + g.r.toFixed(1) + " 0 " + largeArc + " " + sweep +
             " " + x1.toFixed(1) + " " + y1.toFixed(1) + " ";
      }
    }
  }
  if (closed) s += "Z";
  return s;
}

function svgFromOps(ops) {
  var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + SCREEN_W +
               '" height="' + SCREEN_H + '" viewBox="0 0 ' + SCREEN_W + " " + SCREEN_H + '">'];
  parts.push('<rect x="0" y="0" width="' + SCREEN_W + '" height="' + SCREEN_H + '" fill="#000"/>');
  var dstr = "";
  for (var i = 0; i < ops.length; i++) {
    var o = ops[i];
    switch (o.op) {
      case "fillRect":
        parts.push('<rect x="' + o.x + '" y="' + o.y + '" width="' + Math.max(0, o.w) +
          '" height="' + Math.max(0, o.h) + '" fill="' + esc(o.style) + '"/>');
        break;
      case "fillRoundRect":
        parts.push('<rect x="' + o.x + '" y="' + o.y + '" width="' + Math.max(0, o.w) +
          '" height="' + Math.max(0, o.h) + '" rx="' + (o.r || 0) +
          '" fill="' + esc(o.style) + '"/>');
        break;
      case "strokeRect":
        parts.push('<rect x="' + o.x + '" y="' + o.y + '" width="' + o.w + '" height="' + o.h +
          '" fill="none" stroke="' + esc(o.style) + '"/>');
        break;
      case "moveTo": dstr += "M" + o.x.toFixed(1) + " " + o.y.toFixed(1) + " "; break;
      case "lineTo": dstr += "L" + o.x.toFixed(1) + " " + o.y.toFixed(1) + " "; break;
      case "arc":
        dstr += "M" + (o.x + o.r).toFixed(1) + " " + o.y.toFixed(1) +
                " A" + o.r + " " + o.r + " 0 1 0 " + (o.x - o.r).toFixed(1) + " " + o.y.toFixed(1) +
                " A" + o.r + " " + o.r + " 0 1 0 " + (o.x + o.r).toFixed(1) + " " + o.y.toFixed(1) + " Z ";
        break;
      case "strokePath": {
        var pd = o.path ? pathD(o.path, o.closed) : dstr;
        if (pd) parts.push('<path d="' + pd + '" fill="none" stroke="' + esc(o.style) +
          '" stroke-width="' + o.lw + '" stroke-linejoin="round" stroke-linecap="round"/>');
        dstr = "";
        break;
      }
      case "fillPath": {
        var pf = o.path ? pathD(o.path, o.closed) : dstr;
        if (pf) parts.push('<path d="' + pf + '" fill="' + esc(o.style) + '"/>');
        dstr = "";
        break;
      }
      case "fillCircle":
        parts.push('<circle cx="' + o.x + '" cy="' + o.y + '" r="' + o.r +
          '" fill="' + esc(o.style) + '"/>');
        break;
      case "fillText": {
        var f = parseFont(o.font);
        var anchor = o.align === "center" ? "middle" : (o.align === "right" ? "end" : "start");
        var dy = 0;
        if (o.baseline === "middle") dy = f.size * 0.35;
        if (o.baseline === "top") dy = f.size * 0.82;
        parts.push('<text x="' + o.x + '" y="' + (o.y + dy).toFixed(1) + '" fill="' + esc(o.style) +
          '" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + f.size + '"' +
          (f.bold ? ' font-weight="bold"' : "") + ' text-anchor="' + anchor + '">' +
          esc(o.t) + "</text>");
        break;
      }
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* svg -> png (cairosvg if available, otherwise keep the svg)          */
/* ------------------------------------------------------------------ */

var PY_SNIPPET = "import sys,cairosvg;cairosvg.svg2png(url=sys.argv[1],write_to=sys.argv[2])";

function rasterize(svgPath, pngPath, cb) {
  try {
    child_process.execFile("python3", ["-c", PY_SNIPPET, svgPath, pngPath],
      function (err) { cb(!err); });
  } catch (e) { cb(false); }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

runApp(8, function () {
  var TAB_LABELS = ["main", "power", "hpfp", "ign", "fuelcool", "elec", "lap"];
  // extra captures: top-level tabs added after the original strip + MORE screens
  var EXTRA_TABS = [
    { name: "tcase",   tab: "tcase" },
    { name: "more_boost",     tab: "more", more: "boost" },
    { name: "more_gearcorr",  tab: "more", more: "gearcorr" },
    { name: "more_exhaust",   tab: "more", more: "exhaust" },
    { name: "more_logs",      tab: "more", more: "logs" },
    { name: "more_profiles",  tab: "more", more: "profiles" },
    { name: "settings", tab: "settings" }
  ];
  var wanted = tabFilter ? [tabFilter] : TAB_LABELS.concat(EXTRA_TABS.map(function (e) { return e.name; }));
  var gW = SCREEN_W, gH = SCREEN_H;
  var queue = wanted.slice();
  var results = [];

  function next() {
    if (!queue.length) {
      results.forEach(function (r) { console.log(r); });
      process.exit(0);
    }
    var tab = queue.shift();
    var idx = TAB_LABELS.indexOf(tab);
    var extra = null;
    for (var ei = 0; ei < EXTRA_TABS.length; ei++) if (EXTRA_TABS[ei].name === tab) extra = EXTRA_TABS[ei];
    if (idx < 0 && !extra) { results.push("SKIP " + tab + " (unknown tab)"); return next(); }

    // tap the tab strip exactly like on the head unit; touchhandler calls
    // render() synchronously, so record only that single frame
    var tabH = Math.round(gH * 0.09);
    var w = Math.floor(gW / 10);   // live TABS count is 10; keep taps aligned
    recorder.ops.length = 0;
    recorder.recording = true;
    if (mocks.os.touchhandler) {
      if (extra) {
        mocks.os.touchhandler(w * 8 + w / 2, tabH / 2);   // open MORE (or SETTINGS below)
        if (extra.tab === "settings") {
          mocks.os.touchhandler(w * 9 + w / 2, tabH / 2);
        } else if (extra.more) {
          // second-level strip inside MORE: five buttons across the width
          var mTh = Math.round(gH * 0.075);
          var mw = Math.floor(gW / 5);
          var order = ["boost", "gearcorr", "exhaust", "logs", "profiles"];
          var mi = order.indexOf(extra.more);
          if (mi >= 0) mocks.os.touchhandler(mw * mi + mw / 2, tabH + mTh / 2);
        }
      } else {
        mocks.os.touchhandler(w * idx + w / 2, tabH / 2);
      }
    }
    recorder.recording = false;

    // Lap tab: run a full simulated measurement - START at standstill, let
    // the demo speed wave cross 100/200 km/h on the SIMULATED clock, then
    // STOP and capture the results frame. (The app runs on a fake Date, so
    // real setTimeout waiting would not advance its timers.)
    if (tab === "lap") {
      var btnX = null, btnY = null;
      for (var oi = recorder.ops.length - 1; oi >= 0; oi--) {
        var op = recorder.ops[oi];
        if (op.op === "fillRoundRect" && op.h > 60 && op.h < 400 && op.w > 200) {
          btnX = op.x + op.w / 2; btnY = op.y + op.h / 2; break;
        }
      }
      if (btnX !== null && mocks.os.touchhandler) {
        // rewind the demo wave so the speed is at standstill right now
        gDemoRewind();
        advance(300);                       // one render tick with speed ~0
        mocks.os.touchhandler(btnX, btnY);   // START
        var frames = Math.round(8 / 0.2);   // 8 simulated seconds of driving
        for (var fi = 0; fi < frames; fi++) { simTick(); advance(200); }
        mocks.os.touchhandler(btnX, btnY);  // STOP -> freeze results
        recorder.ops.length = 0;
        recorder.recording = true;
        renderOnce();                       // redraw the results frame
        recorder.recording = false;
        emit(tab);
        return;
      }
    }
    // MORE -> EXHAUST FLAP: tap OPEN, let the simulated servo travel, capture
    if (tab === "more_exhaust" && mocks.os.touchhandler) {
      var flapBtns = [];
      for (var oi2 = 0; oi2 < recorder.ops.length; oi2++) {
        var o2 = recorder.ops[oi2];
        if (o2.op === "fillRoundRect" && o2.w > 300 && o2.w < 700 && o2.h > 50 &&
            o2.y > gH * 0.55 && o2.y < gH * 0.85) flapBtns.push(o2);
      }
      if (flapBtns.length >= 3) {
        flapBtns.sort(function (a, b) { return a.x - b.x; });
        var openBtn = flapBtns[1];          // auto | OPEN | close left->right
        mocks.os.touchhandler(openBtn.x + openBtn.w / 2, openBtn.y + openBtn.h / 2);
        for (var fj = 0; fj < 10; fj++) { simTick(); advance(200); }
        recorder.ops.length = 0;
        recorder.recording = true;
        renderOnce();
        recorder.recording = false;
      }
    }
    emit(tab);
  }

  function emit(tab) {
    var ops = recorder.ops.slice();
    recorder.ops.length = 0;
    if (!ops.length) { results.push(tab + ": NO DRAW CALLS"); return next(); }
    var svg = svgFromOps(ops);
    var svgPath = path.join(outDir, tab + ".svg");
    var pngPath = path.join(outDir, tab + ".png");
    fs.writeFileSync(svgPath, svg);
    rasterize(svgPath, pngPath, function (ok) {
      results.push((ok ? "OK   " : "SVG  ") + (ok ? pngPath : svgPath) +
                   "  (" + ops.length + " draw ops)");
      next();
    });
  }
  next();
});
