#!/usr/bin/env node
/*
 * emu.js - live local preview of an MGU app in a desktop browser.
 *
 *   node kit/tools/emu.js <app_id> [--port 8077] [--demo on|off]
 *
 * Reuses the exact mock/recorder machinery of kit/tools/simulate.js (canvas
 * op recorder, HU module mocks, simulated DME DID answers) but instead of
 * writing PNG files it serves frames over HTTP:
 *
 *   http://localhost:<port>/            auto-refreshing SVG preview
 *   click anywhere                      tap is forwarded to os.touchhandler
 *                                       (switch tabs, press START, flap OPEN)
 *
 * The app runs on real wall-clock timers here (not the fast-forward clock of
 * simulate.js), so graphs animate in "real time". Demo mode is ON by default
 * so all tiles show plausible values without the car.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var http = require("http");
var Module = require("module");

var args = process.argv.slice(2);
if (!args.length) { console.error("usage: node kit/tools/emu.js <app> [--port N] [--demo on|off]"); process.exit(1); }
var appName = args[0];
var port = args.indexOf("--port") >= 0 ? parseInt(args[args.indexOf("--port") + 1], 10) : 8077;
var demoIdx = args.indexOf("--demo");
var DEMO = demoIdx >= 0 ? args[demoIdx + 1] : "on";

var ROOT = path.resolve(__dirname, "..", "..");
var appDir = path.join(ROOT, "apps", appName);
if (!fs.existsSync(appDir)) { console.error("no such app: " + appDir); process.exit(1); }
var appJson = JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8"));
var mainJs = fs.readFileSync(path.join(appDir, "main.js"), "utf8");

var SCREEN_W = 1920, SCREEN_H = 720;

/* ------------------------------------------------------------------ */
/* recording 2D context - identical semantics to simulate.js           */
/* ------------------------------------------------------------------ */

function makeRecorder() {
  var ops = [];
  var rec = { recording: true };
  var st = { fillStyle: "#ffffff", strokeStyle: "#ffffff", lineWidth: 1,
             font: "16px sans-serif", textAlign: "left", textBaseline: "alphabetic" };
  function push(o) { if (rec.recording) ops.push(o); }
  var d = { segs: [], closed: false };
  var ctx = {
    setTransform: function () {}, save: function () {}, restore: function () {}, clip: function () {},
    beginPath: function () { d.segs = []; }, closePath: function () { d.closed = true; },
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
  ["lineWidth", "font", "textAlign", "textBaseline"].forEach(function (k) {
    Object.defineProperty(ctx, k, { get: function () { return st[k]; }, set: function (v) { st[k] = v; } });
  });
  Object.defineProperty(ctx, "globalAlpha", { get: function () { return 1; }, set: function () {} });
  Object.defineProperty(ctx, "lineJoin", { get: function () { return "miter"; }, set: function () {} });
  Object.defineProperty(ctx, "lineCap", { get: function () { return "butt"; }, set: function () {} });
  return { ctx: ctx, ops: ops, rec: rec };
}

var THEME = {
  background: "#14161a", surface: "#1f2329", divider: "#33383f",
  textPrimary: "#eef1f4", textSecondary: "#9aa3ad", textTertiary: "#5b636c",
  accent: "#0f9dca", warning: "#f0a12f", alert: "#e8452c", success: "#3fbf5a"
};

/* ------------------------------------------------------------------ */
/* HU module mocks (signals/settings/diagnostic/log/os)                */
/* ------------------------------------------------------------------ */

var recorder = makeRecorder();
var canvas = { width: SCREEN_W, height: SCREEN_H, getContext: function () { return recorder.ctx; } };
var gSimSignalCb = null;

function simTick() {
  if (gSimSignalCb) {
    var rpmRaw = Math.round((1200 + 800 * Math.sin(Date.now() / 900)) / 0.25);
    gSimSignalCb("statusEngineSpeed2", rpmRaw);
  }
}

function hex8(n) { n = ((n % 256) + 256) % 256; return ("0" + n.toString(16)).slice(-2).toUpperCase(); }
function hex16(n) { n = ((n % 65536) + 65536) % 65536; return ("000" + n.toString(16)).slice(-4).toUpperCase(); }
function simWave(frac) { return Math.max(0, Math.sin(Date.now() / 1000 * frac)); }
var SIM_DIDS = {
  0x580F: function () { return hex8(Math.round((28 + 22 * simWave(0.4) + 48) / 0.75)); },
  0x5896: function () { return hex16(Math.round((480 + 430 * simWave(0.4) + 273.14) * 10)); },
  0x586F: function () { return hex16(Math.round((1.0 + 4.6 * simWave(0.4) + 10.0) * 1000)); },
  0x4205: function () { return hex16(Math.round((101 + 135 * simWave(0.4)) * 128)); },
  0x4201: function () { return hex16(Math.round(100.5 * 256)); },
  0x5889: function () { return hex16(Math.round((0.99 + 0.07 * simWave(0.4)) / 0.000244140625)); },
  0x4A9D: function () { return hex16(Math.round(1.0 / 3.0517578e-05)); },
  0x554C: function () { return hex8(Math.round((simWave(0.4) > 0.7 && Math.sin(Date.now() / 1000 * 1.7) > 0.97 ? -3.5 : 0) / 0.375)); },
  0xF08A: function () { return hex16(Math.round(simWave(0.4) * 100 / 0.0015259022)); },
  0x6000: function () { return hex8(Math.round(78 + 25 * simWave(0.4) + 40)); },
  0x5853: function () { return hex16(Math.round((13.9 + 0.3 * Math.sin(Date.now() / 1000)) * 1000)); },
  0x4185: function () { return hex16(Math.round((38 + 246 * simWave(0.4) + 4 * Math.sin(Date.now() / 1000 * 3.1)) * 1000)); },
  0x4184: function () { return hex16(Math.round((40 + 250 * simWave(0.4)) * 1000)); },
  0x554B: function () { return hex8(Math.round((8 + 22 * simWave(0.4)) / 0.375)); }
};

var mocks = {
  os: {
    theme: function () { return { colors: THEME }; },
    getScreen: function () { return { canvas: canvas }; },
    onchange: null, buttonhandler: null, touchhandler: null,
    exit: function () {}, navigateTo: function () {}
  },
  signals: { subscribe: function (n, cb) { gSimSignalCb = cb; } },
  settings: { loadAll: function (cb) { cb({ demo: DEMO }); } },
  diagnostic: {
    readData: function (ecu, ids, cb) {
      var id = ids && ids[0] ? ids[0].id : null;
      if (id === null || !SIM_DIDS.hasOwnProperty(id)) { cb(null); return; }
      var vhex = SIM_DIDS[id];
      if (typeof vhex === "function") vhex = vhex();
      cb({ data: vhex });
    },
    testOBD: function (req, cb) { cb(null); }
  },
  log: { of: function () { return { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} }; } }
};

var origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return origLoad.apply(this, arguments);
};

/* ------------------------------------------------------------------ */
/* boot the app with REAL timers (wall clock)                          */
/* ------------------------------------------------------------------ */

var mod = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", mainJs)
  (mod.exports, require, mod, path.join(appDir, "main.js"), appDir);

var app = { config: appJson.config, settings: {} };
mod.exports.init(app);
if (mocks.os.onchange) mocks.os.onchange("MAIN");

/* drive SOME/IP pushes at 5 Hz like the car would */
setInterval(simTick, 200);

/* grab a frame whenever the app draws something */
var lastSvg = "";
setInterval(function () {
  if (!recorder.ops.length) return;
  var ops = recorder.ops.slice();
  recorder.ops.length = 0;
  lastSvg = svgFromOps(ops);
}, 120);

/* ------------------------------------------------------------------ */
/* replay recorded ops into an SVG (same renderer as simulate.js)      */
/* ------------------------------------------------------------------ */

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function parseFont(f) { var m = /(\d+(?:\.\d+)?)px/.exec(f); return { size: m ? parseFloat(m[1]) : 16, bold: /bold/.test(f) }; }
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
      if (delta > Math.PI * 2 - 1e-9) delta = Math.PI * 2;
      var largeArc = delta > Math.PI ? 1 : 0;
      var x0 = g.x + g.r * Math.cos(g.a0), y0 = g.y + g.r * Math.sin(g.a0);
      var x1 = g.x + g.r * Math.cos(g.a1), y1 = g.y + g.r * Math.sin(g.a1);
      s += "M" + x0.toFixed(1) + " " + y0.toFixed(1) + " ";
      if (delta >= Math.PI * 2 - 1e-6) {
        var xm = g.x + g.r * Math.cos(g.a0 + Math.PI), ym = g.y + g.r * Math.sin(g.a0 + Math.PI);
        s += "A" + g.r.toFixed(1) + " " + g.r.toFixed(1) + " 0 1 " + sweep + " " + xm.toFixed(1) + " " + ym.toFixed(1) + " ";
        s += "A" + g.r.toFixed(1) + " " + g.r.toFixed(1) + " 0 1 " + sweep + " " + x0.toFixed(1) + " " + y0.toFixed(1) + " ";
      } else {
        s += "A" + g.r.toFixed(1) + " " + g.r.toFixed(1) + " 0 " + largeArc + " " + sweep + " " + x1.toFixed(1) + " " + y1.toFixed(1) + " ";
      }
    }
  }
  if (closed) s += "Z";
  return s;
}
function svgFromOps(ops) {
  var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + SCREEN_W + '" height="' + SCREEN_H +
               '" viewBox="0 0 ' + SCREEN_W + " " + SCREEN_H + '">'];
  parts.push('<rect x="0" y="0" width="' + SCREEN_W + '" height="' + SCREEN_H + '" fill="#000"/>');
  var dstr = "";
  for (var i = 0; i < ops.length; i++) {
    var o = ops[i];
    switch (o.op) {
      case "fillRect": parts.push('<rect x="' + o.x + '" y="' + o.y + '" width="' + Math.max(0, o.w) + '" height="' + Math.max(0, o.h) + '" fill="' + esc(o.style) + '"/>'); break;
      case "fillRoundRect": parts.push('<rect x="' + o.x + '" y="' + o.y + '" width="' + Math.max(0, o.w) + '" height="' + Math.max(0, o.h) + '" rx="' + (o.r || 0) + '" fill="' + esc(o.style) + '"/>'); break;
      case "strokeRect": parts.push('<rect x="' + o.x + '" y="' + o.y + '" width="' + o.w + '" height="' + o.h + '" fill="none" stroke="' + esc(o.style) + '"/>'); break;
      case "moveTo": dstr += "M" + o.x.toFixed(1) + " " + o.y.toFixed(1) + " "; break;
      case "lineTo": dstr += "L" + o.x.toFixed(1) + " " + o.y.toFixed(1) + " "; break;
      case "arc": dstr += "M" + (o.x + o.r).toFixed(1) + " " + o.y.toFixed(1) + " A" + o.r + " " + o.r + " 0 1 0 " + (o.x - o.r).toFixed(1) + " " + o.y.toFixed(1) + " A" + o.r + " " + o.r + " 0 1 0 " + (o.x + o.r).toFixed(1) + " " + o.y.toFixed(1) + " Z "; break;
      case "strokePath": { var pd = o.path ? pathD(o.path, o.closed) : dstr; if (pd) parts.push('<path d="' + pd + '" fill="none" stroke="' + esc(o.style) + '" stroke-width="' + o.lw + '" stroke-linejoin="round" stroke-linecap="round"/>'); dstr = ""; break; }
      case "fillPath": { var pf = o.path ? pathD(o.path, o.closed) : dstr; if (pf) parts.push('<path d="' + pf + '" fill="' + esc(o.style) + '"/>'); dstr = ""; break; }
      case "fillCircle": parts.push('<circle cx="' + o.x + '" cy="' + o.y + '" r="' + o.r + '" fill="' + esc(o.style) + '"/>'); break;
      case "fillText": {
        var f = parseFont(o.font);
        var anchor = o.align === "center" ? "middle" : (o.align === "right" ? "end" : "start");
        var dy = 0;
        if (o.baseline === "middle") dy = f.size * 0.35;
        if (o.baseline === "top") dy = f.size * 0.82;
        parts.push('<text x="' + o.x + '" y="' + (o.y + dy).toFixed(1) + '" fill="' + esc(o.style) +
          '" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + f.size + '"' +
          (f.bold ? ' font-weight="bold"' : "") + ' text-anchor="' + anchor + '">' + esc(o.t) + "</text>");
        break;
      }
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

var PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(appName) +
  ' emulator</title><style>body{margin:0;background:#111;display:flex;flex-direction:column;' +
  'align-items:center;font-family:sans-serif}#info{color:#888;padding:6px;font-size:13px}' +
  'svg{max-width:100%;height:auto;border:1px solid #333}</style></head><body>' +
  '<div id="info">' + esc(appName) + " emulator — demo=" + DEMO +
  ' · click the screen to send touches (tabs, buttons)</div><div id="wrap"></div>' +
  "<script>" +
  'function refresh(){fetch("/frame.svg?"+Date.now()).then(function(r){return r.text()})' +
  '.then(function(t){document.getElementById("wrap").innerHTML=t}).catch(function(){});}' +
  "setInterval(refresh,300);refresh();" +
  'document.addEventListener("click",function(e){var s=document.querySelector("svg");if(!s)return;' +
  'var r=s.getBoundingClientRect();var x=(e.clientX-r.left)*' + SCREEN_W + '/r.width,' +
  'y=(e.clientY-r.top)*' + SCREEN_H + '/r.height;' +
  'fetch("/tap?x="+Math.round(x)+"&y="+Math.round(y));});' +
  "</script></body></html>";

http.createServer(function (req, res) {
  var u = req.url || "/";
  if (u.indexOf("/frame.svg") === 0) {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
    res.end(lastSvg || '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="720"><rect width="1920" height="720" fill="#000"/></svg>');
    return;
  }
  if (u.indexOf("/tap") === 0) {
    var q = new URLSearchParams(u.split("?")[1] || "");
    var x = parseInt(q.get("x"), 10), y = parseInt(q.get("y"), 10);
    if (mocks.os.touchhandler && !isNaN(x) && !isNaN(y)) {
      try { mocks.os.touchhandler(x, y); } catch (e) { console.error("tap threw:", e.message); }
    }
    res.writeHead(200); res.end("ok"); return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
}).listen(port, function () {
  console.log("EMU_READY http://localhost:" + port + "/  (app=" + appName + ", demo=" + DEMO + ")");
});

process.on("uncaughtException", function (e) { console.error("emu:", e.stack || e); });
