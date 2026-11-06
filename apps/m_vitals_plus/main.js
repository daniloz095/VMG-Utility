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
var LIVE_WINDOW_S = 20;        // rolling window of the live hpfp/ignition charts

var TABS = [
  { id: "main",  label: "MAIN" },
  { id: "power", label: "POWER" },
  { id: "hpfp",  label: "HPFP" },
  { id: "ign",   label: "IGNITION" },
  { id: "lap",   label: "LAP" }
];

/* Lap tab: acceleration time targets (km/h) and the live side metrics */
var LAP_TARGETS = [100, 200];
var LAP_METRICS = [
  { key: "boost",    label: "BOOST" },
  { key: "fuelPres", label: "FUEL PRESS" },
  { key: "iat",      label: "INTAKE" },
  { key: "egt",      label: "EGT" },
  { key: "speed",    label: "SPEED" }
];

/* Tile labels. The M logo is drawn in the centre cell of the main grid, so
 * every tile uses a short one-word label — long two-word labels (e.g.
 * "Knock events") overflow their narrow side columns on 1920x720.
 * Units are intentionally not rendered for now; they will become a
 * user-facing setting later. */
var PRIMARY_TILES = [
  { key: "boost",    label: "BOOST",     unit: "bar", dp: 2 },
  { key: "iat",      label: "INTAKE",    unit: "\u00b0C", dp: 0 },
  { key: "egt",      label: "EGT",       unit: "\u00b0C", dp: 0 },
  { key: "oilPress", label: "OIL PRESS", unit: "bar", dp: 1 },
  { key: "lambda",   label: "MIXTURE",   unit: "",    dp: 2 },
  { key: "coolant",  label: "COOLANT",   unit: "\u00b0C", dp: 0 },
  { key: "oilTemp",  label: "OIL TEMP",  unit: "\u00b0C", dp: 0 }
];

var SECONDARY_TILES = [
  { key: "voltage",  label: "BATTERY",   unit: "V",  dp: 1 },
  { key: "gearbox",  label: "GEARBOX",   unit: "\u00b0C", dp: 0 },
  { key: "knock",    label: "KNOCK",     unit: "",   dp: 0, counter: true },
  { key: "misfire",  label: "MISFIRES",  unit: "",   dp: 0, counter: true }
];

/* Main-screen layout (VMG reference): 4 rows x 3 columns, the centre cell
 * of row 2 is the logo. Each entry: [row, col, tileKey]. */
var MAIN_LAYOUT = [
  [0, 0, "boost"],    [0, 1, "lambda"],   [0, 2, "oilPress"],
  [1, 0, "iat"],      [1, 1, "logo"],     [1, 2, "egt"],
  [2, 0, "coolant"],  [2, 1, "oilTemp"],  [2, 2, "gearbox"],
  [3, 0, "voltage"],  [3, 1, "knock"],    [3, 2, "misfire"]
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
  fuelPresAct: null,         // HPFP rail pressure actual, bar
  fuelPresReq: null,         // HPFP rail pressure requested, bar
  ignAdv: null,              // ignition advance, deg CA (ZWSPAEKT)
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

/* Lap ("Замер") tab state.
 * Running:   measuring; times fill in as the speed crosses each threshold.
 * Done:      stopped via the toggle button; results frozen on screen.
 * maxes:     peak value per side metric during the run. */
var lap = {
  state: "idle",           // idle | running | done
  startedAt: 0,            // Date.now() at start
  crossed: {},             // target km/h -> elapsed seconds (0-100, 0-200)
  t100_200: null,          // derived: crossed[200] - crossed[100]
  maxes: {},               // metric key -> max value seen during the run
  curSpeed: 0,             // smoothed speed used for crossing detection
  btnRect: null,           // hit-test rect of the START/STOP button
  detailsBtnRect: null,    // hit-test rect of the DETAILS button
  hist: [],                // [{t, el, hp, nm, fuelAct, fuelReq, ignAdv, retard}] chart samples
  peakHp: null, peakNm: null,   // power/torque peaks recorded during the run
  knockBase: 0,            // session knock counter when the run started
  misBase: 0               // session misfire counter when the run started
};

/* Second-level tabs opened from the LAP screen via the DETAILS button.
 * Shown only after a finished run (lap.state === "done"). */
var DETAIL_TABS = [
  { id: "power", label: "POWER" },
  { id: "hpfp",  label: "HPFP" },
  { id: "ign",   label: "IGNITION" }
];
var gDetailTab = "power";   // active second-level tab
var gLapView = "main";      // main | detail — which LAP view is on screen
var gBackBtnRect = null;    // hit-test rect of the < BACK button

/* Live state for the top-level HPFP and IGNITION tabs (same data sources as
 * the lap-detail views, but sampled continuously against wall time so the
 * chart scrolls in real time whether or not a lap run is active). */
var hpfpLive = {
  hist: [],                 // [{t, act, req}] rolling LIVE_WINDOW_S samples
  peakAct: null, peakReq: null,
  peakActAt: 0, peakReqAt: 0
};
var ignLive = {
  hist: [],                 // [{t, adv, ret}] rolling LIVE_WINDOW_S samples
  maxAdv: null, maxRet: null,
  maxAdvAt: 0, maxRetAt: 0,
  knockEvents: 0,           // knock events seen since app start (boost-gated)
  misEvents: 0              // misfire events seen since app start (boost-gated)
};

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

var ALL_TILES = PRIMARY_TILES.concat(SECONDARY_TILES, [
  { key: "rpm", label: "RPM", unit: "", dp: 0 }
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
  if (key === "speed") return lapSpeedKmh();
  if (key === "fuelPres") return fuelPressureActual();
  if (key === "fuelPresReq") return fuelPressureRequested();
  // signal-fed values are push-based and always current while driving
  if (key === "coolant" || key === "oilTemp" || key === "rpm") {
    return num(v[key]) ? v[key] : null;
  }
  return isFresh(key) ? v[key] : null;
}

/* HPFP rail pressure: actual and requested, bar. The DME poll fills the
 * *_IST / *_SOLL candidates; when only one legacy figure exists both
 * getters fall back to it so the chart still draws something useful. */
function fuelPressureActual() {
  if (isFresh("fuelPresAct")) return v.fuelPresAct;
  if (isFresh("fuelPressure")) return v.fuelPressure;
  return null;
}

function fuelPressureRequested() {
  if (isFresh("fuelPresReq")) return v.fuelPresReq;
  if (isFresh("fuelPressure")) return v.fuelPressure;
  return null;
}

/* speed in km/h: the SOME/IP wheel-speed-derived signal is primary; when it
 * is missing (e.g. simulator), fall back to OBD PID 0x0D from the DME poll */
function lapSpeedKmh() {
  if (num(v.speed)) return v.speed;
  if (isFresh("speedObd")) return v.speedObd;
  return null;
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

  // value only — units are intentionally hidden for now (they live in the
  // tile config and will become a user-facing setting later)
  var col = tileColor(tile.key, val);
  ctx.font = "bold " + Math.round(th * 0.40) + "px sans-serif";
  ctx.fillStyle(col);
  var txt = fmt(tile.key, val);
  ctx.fillText(txt, x + pad, y + th * 0.34);
}

/* Main screen: 4 rows x 3 columns per the VMG reference. The centre cell of
 * row 2 holds the logo, everything else is a data tile.
 *
 * The logo column is sized to exactly half the screen width so the badge is
 * centred on the display; the two data columns share the remaining width. */
function mainColX() {
  var side = Math.floor((gW - gW / 2) / 2);   // width of each data column
  return [0, side, gW - side, gW];            // column edges, logo spans [1..2]
}

function drawMain(ctx, top) {
  var area = gH - top;
  var rh = Math.floor(area / 4);
  var xs = mainColX();

  for (var i = 0; i < MAIN_LAYOUT.length; i++) {
    var row = MAIN_LAYOUT[i][0], col = MAIN_LAYOUT[i][1], key = MAIN_LAYOUT[i][2];
    var x = xs[col], w = xs[col + 1] - xs[col];
    var y = top + row * rh;
    if (key === "logo") { drawLogo(ctx, x, y, w, rh); continue; }
    var t = tileByKey(key);
    if (!t) continue;
    var val = t.counter
      ? (key === "knock" ? counters.knock : counters.misfireCount)
      : valueFor(key);
    drawTile(ctx, x, y, w, rh, t, val);
  }
}

/* ------------------------------------------------------------------ */
/* drawing: M logo (centre cell of the main grid)                      */
/* ------------------------------------------------------------------ */

function mColors() {
  return [
    { c: "#87c4e8", s: 0.0 },   // light blue
    { c: "#0f96d8", s: 0.25 },  // blue
    { c: "#e8452c", s: 0.5 },   // red
    { c: "#1aa05a", s: 0.75 },  // green
    { c: "#87c4e8", s: 1.0 }
  ];
}

/* Draw one wedge of an annulus (between radii r0..r1, angles a0..a1). */
function fillAnnulusWedge(ctx, cx, cy, r0, r1, a0, a1) {
  ctx.beginPath();
  ctx.arc(cx, cy, r1, a0, a1);
  ctx.arc(cx, cy, r0, a1, a0, true);
  ctx.closePath();
  ctx.fill();
}

/* Stripes inside the roundel: quarter-relative fractions of the badge. */
var LOGO_STRIPES = [
  { q: 0, f0: 0.00, f1: 0.20, col: 0 },  // top-left quadrant, light blue
  { q: 0, f0: 0.20, f1: 0.40, col: 1 },  // top-left quadrant, blue
  { q: 1, f0: 0.10, f1: 0.30, col: 2 },  // top-right quadrant, red
  { q: 2, f0: 0.00, f1: 0.30, col: 2 },  // bottom-left quadrant, red
  { q: 3, f0: 0.00, f1: 0.20, col: 3 },  // bottom-right quadrant, green
  { q: 3, f0: 0.20, f1: 0.40, col: 4 }   // bottom-right quadrant, light blue
];

function drawLogo(ctx, x, y, w, h) {
  // dark plate behind the badge, like the reference
  ctx.fillStyle(c("background"));
  ctx.fillRoundRect(x + 3, y + 3, w - 6, h - 6, 10);

  var cx = x + w / 2, cy = y + h / 2;
  var R = Math.min(w, h) * 0.40;         // outer radius of the roundel
  var ringW = R * 0.16;                  // black text ring thickness
  var innerR = R - ringW;                // radius of the striped disc

  // black ring
  ctx.fillStyle("#141414");
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  // white hairline borders (mgu-renderd: lineWidth() is a getter function)
  var lw = Math.max(1, R * 0.02);
  ctx.lineWidth = lw;
  ctx.strokeStyle("#e6e6e6");
  ctx.beginPath(); ctx.arc(cx, cy, R - lw / 2, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, innerR + lw / 2, 0, Math.PI * 2); ctx.stroke();

  // inner disc: light base + M stripes as angular wedges
  ctx.fillStyle("#dfe6ea");
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.fill();

  var mc = mColors();
  for (var i = 0; i < LOGO_STRIPES.length; i++) {
    var st = LOGO_STRIPES[i];
    var qa = [-Math.PI / 2, 0, Math.PI, Math.PI / 2][st.q]; // start angle of quadrant
    var a0 = qa + st.f0 * Math.PI / 2;
    var a1 = qa + st.f1 * Math.PI / 2;
    ctx.fillStyle(mc[st.col].c);
    fillAnnulusWedge(ctx, cx, cy, 0, innerR, a0, a1);
  }

  // "M" letters on the ring, top and bottom
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold " + Math.round(ringW * 0.82) + "px sans-serif";
  ctx.fillStyle("#e6e6e6");
  ctx.fillText("M", cx, cy - R + ringW / 2);
  ctx.fillText("M", cx, cy + R - ringW / 2);
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
/* drawing: Lap tab (Замер)                                           */
/* ------------------------------------------------------------------ */

var COL_LAP = "#3aa0ff";        // lap accent (button / running state)
var LAP_DP = 2;                 // seconds shown with two decimals

function lapMetricVal(key) { return valueFor(key); }

/* ------------------------------------------------------------------ */
/* live charts for the top-level HPFP / IGNITION tabs                  */
/*                                                                     */
/* Same data sources as the LAP detail views, but sampled continuously */
/* against wall time: the chart scrolls in real time whether or not a   */
/* lap run is active. Peaks expire like on the POWER tab (same TTL).    */
/* ------------------------------------------------------------------ */

function pushLive(hist, sample) {
  hist.push(sample);
  var cutoff = Date.now() - LIVE_WINDOW_S * 1000;
  while (hist.length && hist[0].t < cutoff) hist.shift();
}

/* called from the power sampler tick (every 100 ms) */
function liveStep() {
  var now = Date.now();
  var ttl = gSettings.peakResetMs || PEAK_RESET_MS;

  pushLive(hpfpLive.hist, {
    t: now,
    act: fuelPressureActual(),
    req: fuelPressureRequested()
  });
  var fa = hpfpLive.hist[hpfpLive.hist.length - 1].act;
  var fr = hpfpLive.hist[hpfpLive.hist.length - 1].req;
  if (num(fa) && (!num(hpfpLive.peakAct) || fa > hpfpLive.peakAct)) { hpfpLive.peakAct = fa; hpfpLive.peakActAt = now; }
  if (num(fr) && (!num(hpfpLive.peakReq) || fr > hpfpLive.peakReq)) { hpfpLive.peakReq = fr; hpfpLive.peakReqAt = now; }
  if (num(hpfpLive.peakAct) && now - hpfpLive.peakActAt > ttl) hpfpLive.peakAct = null;
  if (num(hpfpLive.peakReq) && now - hpfpLive.peakReqAt > ttl) hpfpLive.peakReq = null;

  pushLive(ignLive.hist, {
    t: now,
    adv: isFresh("ignAdv") ? v.ignAdv : null,
    ret: isFresh("knockRetard") ? v.knockRetard : null
  });
  var ad = ignLive.hist[ignLive.hist.length - 1].adv;
  var rd = ignLive.hist[ignLive.hist.length - 1].ret;
  if (num(ad) && (!num(ignLive.maxAdv) || ad > ignLive.maxAdv)) { ignLive.maxAdv = ad; ignLive.maxAdvAt = now; }
  if (num(rd) && rd < 0 && (!num(ignLive.maxRet) || Math.abs(rd) > Math.abs(ignLive.maxRet))) { ignLive.maxRet = rd; ignLive.maxRetAt = now; }
  if (num(ignLive.maxAdv) && now - ignLive.maxAdvAt > ttl) ignLive.maxAdv = null;
  if (num(ignLive.maxRet) && now - ignLive.maxRetAt > ttl) ignLive.maxRet = null;
}

/* generic rolling live chart: hist entries {t, <keys>}; series keys can be
 * negative-valued (retard) — the y range is derived from the window data. */
function drawLiveChart(ctx, x, y, w, h, title, hist, series, opts) {
  opts = opts || {};
  ctx.fillStyle(c("surface"));
  ctx.fillRoundRect(x + 4, y + 4, w - 8, h - 8, 12);

  var padL = Math.round(w * 0.07);
  var padR = Math.round(w * 0.03);
  var padT = Math.round(h * 0.16);
  var padB = Math.round(h * 0.12);
  var gx = x + padL, gy = y + padT;
  var gw = w - padL - padR, gh = h - padT - padB;

  var now = Date.now();
  var t0 = now - LIVE_WINDOW_S * 1000;

  var lo = null, hi = null;
  for (var s = 0; s < series.length; s++) {
    var key = series[s].key;
    for (var j = 0; j < hist.length; j++) {
      var val = hist[j][key];
      if (!num(val) || hist[j].t < t0) continue;
      if (lo === null || val < lo) lo = val;
      if (hi === null || val > hi) hi = val;
    }
  }
  if (lo === null) { lo = 0; hi = 1; }
  if (hi === lo) hi = lo + 1;
  var span = hi - lo;
  lo -= span * 0.05; hi += span * 0.05;
  if (opts.zeroFloor !== false && lo < 0 && Math.abs(lo) < span * 0.2) lo = 0;

  ctx.strokeStyle(c("divider") || c("textTertiary"));
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";
  ctx.font = Math.round(h * 0.075) + "px sans-serif";
  for (var g = 0; g <= 4; g++) {
    var yy = gy + gh - gh * g / 4;
    ctx.beginPath(); ctx.moveTo(gx, yy); ctx.lineTo(gx + gw, yy); ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillStyle(c("textTertiary"));
    ctx.fillText((lo + (hi - lo) * g / 4).toFixed(series[0].dp), gx - 6, yy);
  }
  // time ticks: relative to the right edge ("now")
  ctx.textAlign = "center";
  for (var ts = LIVE_WINDOW_S; ts >= 0; ts -= 5) {
    var tx = gx + gw * (1 - ts / LIVE_WINDOW_S);
    ctx.fillStyle(c("textTertiary"));
    ctx.fillText(ts === 0 ? "now" : "-" + ts + "s", tx, gy + gh + padB * 0.55);
  }

  // title inside the panel
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = Math.round(h * 0.08) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  ctx.fillText(title, gx, y + Math.round(h * 0.045));

  // legend to the right of the title
  var lx = gx + ctx.measureText(title).width + Math.round(w * 0.03);
  ctx.font = Math.round(h * 0.075) + "px sans-serif";
  for (var ls = 0; ls < series.length; ls++) {
    var sr = series[ls];
    ctx.fillStyle(sr.color);
    ctx.fillRect(lx, y + Math.round(h * 0.05), Math.round(w * 0.025), 4);
    ctx.textBaseline = "middle";
    ctx.fillText(sr.label, lx + Math.round(w * 0.032), y + Math.round(h * 0.062));
    lx += Math.round(w * 0.032) + ctx.measureText(sr.label).width + Math.round(w * 0.03);
    ctx.textBaseline = "top";
  }

  // series lines + leading dot
  for (var ss = 0; ss < series.length; ss++) {
    var se = series[ss];
    ctx.strokeStyle(se.color);
    ctx.lineWidth = se.dashed ? 2 : 3;
    ctx.beginPath();
    var started = false, lastPx = 0, lastPy = 0;
    for (var p = 0; p < hist.length; p++) {
      var pt = hist[p];
      var pv = pt[se.key];
      if (!num(pv) || pt.t < t0) { started = false; continue; }
      var px = gx + gw * (pt.t - t0) / (now - t0);
      var py = gy + gh - gh * (pv - lo) / (hi - lo);
      if (py < gy) py = gy; if (py > gy + gh) py = gy + gh;
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
      lastPx = px; lastPy = py;
    }
    ctx.stroke();
    if (started && ctx.fillCircle) { ctx.fillStyle(se.color); ctx.fillCircle(lastPx, lastPy, 4); }
  }
}

/* stat block with a peak-expiry countdown bar under the value */
function drawLiveStat(ctx, x, y, w, h, label, valTxt, col, ttlLeftFrac) {
  drawStat(ctx, x, y, w, h, label, valTxt, col);
  if (ttlLeftFrac !== null && num(ttlLeftFrac)) {
    var bw = Math.round(w * 0.8);
    ctx.fillStyle(c("background"));
    ctx.fillRect(x, y + h * 0.95, bw, 4);
    ctx.fillStyle(col);
    ctx.fillRect(x, y + h * 0.95, Math.round(bw * ttlLeftFrac), 4);
  }
}

function peakFrac(at) {
  if (!at) return null;
  var ttl = gSettings.peakResetMs || PEAK_RESET_MS;
  return Math.max(0, (ttl - (Date.now() - at)) / ttl);
}

/* drawing: HPFP tab (live) */
function drawHpfpTab(ctx, top) {
  var area = gH - top;
  var statsH = Math.round(area * 0.26);
  var padX = Math.round(gW * 0.03);
  var cw = Math.floor((gW - 2 * padX) / 3);
  var curA = fuelPressureActual(), curR = fuelPressureRequested();
  var sy = top + Math.round(statsH * 0.10);
  drawLiveStat(ctx, padX, sy, cw, statsH, "RAIL ACTUAL, bar",
    num(curA) ? String(Math.round(curA)) : "--", COL_FUEL_ACT, null);
  drawLiveStat(ctx, padX + cw, sy, cw, statsH, "PEAK ACTUAL, bar",
    num(hpfpLive.peakAct) ? String(Math.round(hpfpLive.peakAct)) : "--",
    COL_FUEL_ACT, hpfpLive.peakAct ? peakFrac(hpfpLive.peakActAt) : null);
  drawLiveStat(ctx, padX + cw * 2, sy, cw, statsH, "PEAK REQUESTED, bar",
    num(hpfpLive.peakReq) ? String(Math.round(hpfpLive.peakReq)) : "--",
    COL_FUEL_REQ, hpfpLive.peakReq ? peakFrac(hpfpLive.peakReqAt) : null);
  drawLiveChart(ctx, padX, top + statsH, gW - 2 * padX, area - statsH,
    "HPFP rail pressure, live", hpfpLive.hist,
    [{ key: "act", color: COL_FUEL_ACT, label: "actual", dp: 0 },
     { key: "req", color: COL_FUEL_REQ, label: "requested", dp: 0, dashed: true }]);
}

/* drawing: IGNITION tab (live) */
function drawIgnTab(ctx, top) {
  var area = gH - top;
  var statsH = Math.round(area * 0.26);
  var padX = Math.round(gW * 0.03);
  var cw = Math.floor((gW - 2 * padX) / 4);
  var sy = top + Math.round(statsH * 0.10);
  var curAdv = isFresh("ignAdv") ? v.ignAdv : null;
  var curRet = isFresh("knockRetard") ? v.knockRetard : null;
  drawLiveStat(ctx, padX, sy, cw, statsH, "ADVANCE NOW, deg",
    num(curAdv) ? curAdv.toFixed(1) : "--", COL_ADV, null);
  drawLiveStat(ctx, padX + cw, sy, cw, statsH, "MAX ADVANCE, deg",
    num(ignLive.maxAdv) ? ignLive.maxAdv.toFixed(1) : "--",
    COL_ADV, ignLive.maxAdv ? peakFrac(ignLive.maxAdvAt) : null);
  drawLiveStat(ctx, padX + cw * 2, sy, cw, statsH, "MAX RETARD, deg",
    num(ignLive.maxRet) ? Math.abs(ignLive.maxRet).toFixed(1) : "--",
    COL_RET, ignLive.maxRet ? peakFrac(ignLive.maxRetAt) : null);
  drawLiveStat(ctx, padX + cw * 3, sy, cw, statsH, "KNOCK / MISFIRE",
    counters.knock + " / " + counters.misfireCount,
    counters.knock > 0 || counters.misfireCount > 0 ? c("alert") : c("textPrimary"), null);
  drawLiveChart(ctx, padX, top + statsH, gW - 2 * padX, area - statsH,
    "Ignition timing, live", ignLive.hist,
    [{ key: "adv", color: COL_ADV, label: "advance, deg", dp: 1 },
     { key: "ret", color: COL_RET, label: "retard, deg", dp: 1 }],
    { zeroFloor: false });
}

function lapTimeText(target) {
  var t = lap.crossed[target];
  if (num(t)) return t.toFixed(LAP_DP);
  if (lap.state === "running") {
    // live elapsed clock while the target has not been reached yet
    return ((Date.now() - lap.startedAt) / 1000).toFixed(LAP_DP);
  }
  return "0.00";
}

/* One right-column entry: label line + big seconds line */
function drawLapTime(ctx, x, y, w, h, label, valTxt, col) {
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = Math.round(h * 0.24) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  ctx.fillText(label, x, y);
  ctx.font = "bold " + Math.round(h * 0.52) + "px sans-serif";
  ctx.fillStyle(col || c("textPrimary"));
  ctx.fillText(valTxt, x, y + h * 0.40);
}

function drawLap(ctx, top) {
  var area = gH - top;
  var padX = Math.round(gW * 0.03);
  var sideW = Math.round(gW * 0.20);
  var midX = padX + sideW + Math.round(gW * 0.03);
  var midW = gW - 2 * (sideW + Math.round(gW * 0.03)) - padX;

  // ---- centre: current speed ----
  var spd = lapSpeedKmh();
  var cy = top + Math.round(area * 0.30);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold " + Math.round(area * 0.30) + "px sans-serif";
  ctx.fillStyle(lap.state === "running" ? c("accent") : c("textPrimary"));
  ctx.fillText(num(spd) ? String(Math.round(spd)) : "--", midX + midW / 2, cy);
  ctx.font = Math.round(area * 0.07) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  ctx.fillText("km/h", midX + midW / 2, cy + Math.round(area * 0.20));

  // ---- bottom-centre: START/STOP toggle + DETAILS buttons ----
  var btnW = Math.round(midW * 0.42);
  var btnH = Math.round(area * 0.16);
  var gap = Math.round(midW * 0.04);
  var pairW = num(lap.maxes.speed) || lap.state === "done" ? btnW * 2 + gap : btnW;
  var btnX = midX + Math.round((midW - pairW) / 2);
  var btnY = top + area - btnH - Math.round(area * 0.06);
  lap.btnRect = [btnX, btnY, btnW, btnH];

  var running = lap.state === "running";
  ctx.fillStyle(running ? c("alert") : c("success"));
  ctx.fillRoundRect(btnX, btnY, btnW, btnH, 14);
  ctx.font = "bold " + Math.round(btnH * 0.48) + "px sans-serif";
  ctx.fillStyle("#ffffff");
  ctx.fillText(running ? "STOP" : "START", btnX + btnW / 2, btnY + btnH / 2);

  // DETAILS button: appears once a run has been recorded
  lap.detailsBtnRect = null;
  if (lap.state === "done") {
    var dx = btnX + btnW + gap;
    ctx.fillStyle(c("surface"));
    ctx.fillRoundRect(dx, btnY, btnW, btnH, 14);
    ctx.strokeStyle(c("accent"));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(dx + 7, btnY + 7); ctx.lineTo(dx + btnW - 7, btnY + 7);
    ctx.lineTo(dx + btnW - 7, btnY + btnH - 7); ctx.lineTo(dx + 7, btnY + btnH - 7);
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle(c("accent"));
    ctx.fillText("DETAILS", dx + btnW / 2, btnY + btnH / 2);
    lap.detailsBtnRect = [dx, btnY, btnW, btnH];
  }

  // status line above the button
  ctx.font = Math.round(area * 0.055) + "px sans-serif";
  ctx.fillStyle(c("textTertiary"));
  var status = lap.state === "running"
    ? "REC \u00b7 " + ((Date.now() - lap.startedAt) / 1000).toFixed(1) + " s"
    : lap.state === "done" ? "RUN COMPLETE" : "SPEED MUST BE 0 TO START";
  ctx.fillText(status, btnX + btnW / 2, btnY - Math.round(area * 0.05));

  // ---- left column: live metrics (maxes after a finished run) ----
  var rows = LAP_METRICS.length;
  var colTop = top + Math.round(area * 0.04);
  var rowH = Math.floor((area - (colTop - top) - Math.round(area * 0.26)) / rows);
  for (var i = 0; i < rows; i++) {
    var m = LAP_METRICS[i];
    var y = colTop + i * rowH;
    var showMax = lap.state === "done" && num(lap.maxes[m.key]);
    var val = showMax ? lap.maxes[m.key] : lapMetricVal(m.key);
    var dp = m.key === "boost" ? 2 : m.key === "fuelPres" ? 0 : 0;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = Math.round(rowH * 0.26) + "px sans-serif";
    ctx.fillStyle(c("textSecondary"));
    ctx.fillText((showMax ? "MAX " : "") + m.label, padX, y);
    ctx.font = "bold " + Math.round(rowH * 0.44) + "px sans-serif";
    ctx.fillStyle(showMax ? COL_LAP : (num(val) ? c("textPrimary") : c("textTertiary")));
    ctx.fillText(num(val) ? val.toFixed(dp) : "--", padX, y + rowH * 0.36);
  }

  // ---- right column: acceleration times ----
  var rx = midX + midW + Math.round(gW * 0.03);
  var entries = [
    { label: "0-100",    txt: lapTimeText(100),           got: num(lap.crossed[100]) },
    { label: "0-200",    txt: lapTimeText(200),           got: num(lap.crossed[200]) },
    { label: "100-200",  txt: num(lap.t100_200) ? lap.t100_200.toFixed(LAP_DP)
                        : (lap.state === "running" && num(lap.crossed[100])
                           ? ((Date.now() - lap.startedAt) / 1000 - lap.crossed[100]).toFixed(LAP_DP)
                           : "0.00"),
      got: num(lap.t100_200) }
  ];
  var eH = Math.floor((area - (colTop - top) - Math.round(area * 0.26)) / entries.length);
  for (var j = 0; j < entries.length; j++) {
    var e = entries[j];
    drawLapTime(ctx, rx, colTop + j * eH, sideW, eH,
      e.label, e.txt + " sec", e.got ? c("accent") : c("textPrimary"));
  }
}

/* Lap engine: called from the render loop at UI cadence (~5 Hz).
 * Speed crossing detection uses an EMA-smoothed signal and requires the
 * previous sample to be under the threshold so a single noisy reading
 * cannot trigger a time. Maxes are tracked only while running. */
var gLapEma = null;

function lapStep() {
  var spd = lapSpeedKmh();
  if (num(spd)) gLapEma = gLapEma === null ? spd : gLapEma + (spd - gLapEma) * 0.5;
  lap.curSpeed = gLapEma;

  if (lap.state !== "running") return;

  var now = Date.now();
  var el = (now - lap.startedAt) / 1000;
  var s = num(gLapEma) ? gLapEma : 0;

  // crossing detection for each target
  for (var i = 0; i < LAP_TARGETS.length; i++) {
    var tgt = LAP_TARGETS[i];
    if (!num(lap.crossed[tgt]) && s >= tgt) {
      lap.crossed[tgt] = el;
      log.info("lap: crossed 0-" + tgt + " km/h in " + el.toFixed(2) + " s");
    }
  }
  if (num(lap.crossed[100]) && num(lap.crossed[200])) {
    lap.t100_200 = lap.crossed[200] - lap.crossed[100];
  }

  // track max values of the left-column metrics
  for (var k = 0; k < LAP_METRICS.length; k++) {
    var key = LAP_METRICS[k].key;
    var val = lapMetricVal(key);
    if (num(val) && (!num(lap.maxes[key]) || val > lap.maxes[key])) lap.maxes[key] = val;
  }

  // record chart samples + power peaks for the DETAILS screens
  lap.hist.push({
    t: now, el: el,
    hp: num(power.hp) ? power.hp : null,
    nm: num(power.nm) ? power.nm : null,
    fuelAct: fuelPressureActual(),
    fuelReq: fuelPressureRequested(),
    ignAdv: isFresh("ignAdv") ? v.ignAdv : null,
    retard: isFresh("knockRetard") ? v.knockRetard : null
  });
  if (lap.hist.length > 900) lap.hist.splice(0, lap.hist.length - 900);
  if (num(power.hp) && (!num(lap.peakHp) || power.hp > lap.peakHp)) lap.peakHp = power.hp;
  if (num(power.nm) && (!num(lap.peakNm) || power.nm > lap.peakNm)) lap.peakNm = power.nm;
}

function lapToggle() {
  if (lap.state === "running") {
    lap.state = "done";
    log.info("lap stopped after " + ((Date.now() - lap.startedAt) / 1000).toFixed(2) + " s");
    return;
  }
  if (lap.state === "done") { lapReset(); }   // second tap on results -> arm again
  var spd = lapSpeedKmh();
  if (!num(spd) || spd > 1) {
    log.info("lap start rejected: speed", spd);
    return;                       // per spec: measurement starts only at standstill
  }
  lap.state = "running";
  lap.startedAt = Date.now();
  lap.crossed = {};
  lap.t100_200 = null;
  lap.maxes = {};
  lap.hist = [];
  lap.peakHp = null;
  lap.peakNm = null;
  lap.knockBase = counters.knock;        // per-run event deltas
  lap.misBase = counters.misfireCount;
  gLapEma = 0;
}

function lapReset() {
  lap.state = "idle";
  lap.startedAt = 0;
  lap.crossed = {};
  lap.t100_200 = null;
  lap.maxes = {};
  lap.hist = [];
  lap.peakHp = null;
  lap.peakNm = null;
  gLapEma = null;
}

/* ------------------------------------------------------------------ */
/* drawing: Lap DETAILS (second-level tabs)                            */
/* ------------------------------------------------------------------ */

var COL_HP = "#e8452c";   // power series on detail charts
var COL_NM = "#3aa0ff";   // torque series
var COL_FUEL_ACT = "#3aa0ff";
var COL_FUEL_REQ = "#f0a030";
var COL_ADV = "#1aa05a";  // ignition advance
var COL_RET = "#e8452c";  // knock retard

function lapHistMax(key) {
  var m = null;
  for (var i = 0; i < lap.hist.length; i++) {
    var val = lap.hist[i][key];
    if (num(val) && (m === null || val > m)) m = val;
  }
  return m;
}

function lapHistMin(key) {
  var m = null;
  for (var i = 0; i < lap.hist.length; i++) {
    var val = lap.hist[i][key];
    if (num(val) && (m === null || val < m)) m = val;
  }
  return m;
}

/* Big number block: label + value, used in the stats rows of detail tabs */
function drawStat(ctx, x, y, w, h, label, valTxt, col) {
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = Math.round(h * 0.26) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  ctx.fillText(label, x, y);
  ctx.font = "bold " + Math.round(h * 0.55) + "px sans-serif";
  ctx.fillStyle(col || c("textPrimary"));
  ctx.fillText(valTxt, x, y + h * 0.34);
}

/* Second-level tab strip under the main tabs; returns its height */
function drawDetailTabs(ctx, top) {
  var th = Math.round(gH * 0.075);
  var w = Math.floor(gW / DETAIL_TABS.length);
  ctx.fillStyle(c("surface"));
  ctx.fillRect(0, top, gW, th);
  for (var i = 0; i < DETAIL_TABS.length; i++) {
    var t = DETAIL_TABS[i];
    var x = i * w;
    var active = t.id === gDetailTab;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = (active ? "bold " : "") + Math.round(th * 0.42) + "px sans-serif";
    ctx.fillStyle(active ? c("accent") : c("textSecondary"));
    ctx.fillText(t.label, x + w / 2, top + th * 0.45);
    if (active) {
      ctx.fillStyle(c("accent"));
      ctx.fillRect(x + w * 0.2, top + th - 3, w * 0.6, 3);
    }
  }
  // BACK button at the right edge of the strip
  var bw = Math.round(gW * 0.10);
  ctx.fillStyle(c("background"));
  ctx.fillRoundRect(gW - bw - 8, top + 6, bw, th - 12, 8);
  ctx.font = "bold " + Math.round(th * 0.38) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  gBackBtnRect = [gW - bw - 8, top + 6, bw, th - 12];
  ctx.fillText("< BACK", gW - bw - 8 + bw / 2, top + th / 2);
  return th;
}

/* Generic time-series chart over the recorded lap history. The x axis is
 * elapsed seconds of the run; series = [{key, color, label}]. */
function drawLapChart(ctx, x, y, w, h, title, series, opts) {
  opts = opts || {};
  ctx.fillStyle(c("surface"));
  ctx.fillRoundRect(x + 4, y + 4, w - 8, h - 8, 12);

  var padL = Math.round(w * 0.07);
  var padR = Math.round(w * (opts.rightAxis ? 0.07 : 0.03));
  var padT = Math.round(h * 0.16);
  var padB = Math.round(h * 0.12);
  var gx = x + padL, gy = y + padT;
  var gw = w - padL - padR, gh = h - padT - padB;

  // x extent: total recorded elapsed time (min 5 s so short runs stay sane)
  var tEnd = 5;
  for (var i = 0; i < lap.hist.length; i++) {
    if (lap.hist[i].el > tEnd) tEnd = lap.hist[i].el;
  }
  tEnd = Math.ceil(tEnd);

  // shared scale across all series unless per-axis given
  var lo = opts.zeroBase ? 0 : null, hi = null;
  for (var s = 0; s < series.length; s++) {
    var key = series[s].key;
    for (var j = 0; j < lap.hist.length; j++) {
      var val = lap.hist[j][key];
      if (!num(val)) continue;
      if (lo === null || val < lo) lo = val;
      if (hi === null || val > hi) hi = val;
    }
  }
  if (lo === null) { lo = 0; hi = 1; }
  if (hi === lo) hi = lo + 1;
  var span = hi - lo;
  lo -= span * 0.05; hi += span * 0.05;
  if (opts.zeroBase && lo < 0 && Math.abs(lo) < span * 0.2) lo = 0;

  // grid lines + left labels
  ctx.strokeStyle(c("divider") || c("textTertiary"));
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";
  ctx.font = Math.round(h * 0.075) + "px sans-serif";
  for (var g = 0; g <= 4; g++) {
    var yy = gy + gh - gh * g / 4;
    ctx.beginPath(); ctx.moveTo(gx, yy); ctx.lineTo(gx + gw, yy); ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillStyle(c("textTertiary"));
    ctx.fillText((lo + (hi - lo) * g / 4).toFixed(series[0].dp), gx - 6, yy);
  }
  // time ticks every ~5 s
  ctx.textAlign = "center";
  var tickStep = tEnd > 40 ? 10 : 5;
  for (var ts = 0; ts <= tEnd; ts += tickStep) {
    var tx = gx + gw * ts / tEnd;
    ctx.fillText(ts + "s", tx, gy + gh + padB * 0.55);
  }

  // title inside the panel
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = Math.round(h * 0.08) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  ctx.fillText(title, gx, y + Math.round(h * 0.045));

  // legend to the right of the title
  var lx = gx + ctx.measureText(title).width + Math.round(w * 0.03);
  ctx.font = Math.round(h * 0.075) + "px sans-serif";
  for (var ls = 0; ls < series.length; ls++) {
    var sr = series[ls];
    ctx.fillStyle(sr.color);
    ctx.fillRect(lx, y + Math.round(h * 0.05), Math.round(w * 0.025), 4);
    ctx.textBaseline = "middle";
    ctx.fillText(sr.label, lx + Math.round(w * 0.032), y + Math.round(h * 0.062));
    lx += Math.round(w * 0.032) + ctx.measureText(sr.label).width + Math.round(w * 0.03);
    ctx.textBaseline = "top";
  }

  // series lines
  for (var ss = 0; ss < series.length; ss++) {
    var se = series[ss];
    ctx.strokeStyle(se.color);
    ctx.lineWidth = se.dashed ? 2 : 3;
    ctx.beginPath();
    var started = false;
    for (var p = 0; p < lap.hist.length; p++) {
      var pt = lap.hist[p];
      var pv = pt[se.key];
      if (!num(pv)) { started = false; continue; }
      var px = gx + gw * pt.el / tEnd;
      var py = gy + gh - gh * (pv - lo) / (hi - lo);
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

/* Details view dispatcher */
function drawLapDetails(ctx, top) {
  var dTop = top + drawDetailTabs(ctx, top);
  var area = gH - dTop;
  var statsH = Math.round(area * 0.26);
  var padX = Math.round(gW * 0.03);

  if (gDetailTab === "power") {
    var nCols = 2;
    var cw = Math.floor((gW - 2 * padX) / nCols);
    drawStat(ctx, padX, dTop + Math.round(statsH * 0.15), cw, statsH,
      "PEAK POWER, hp", num(lap.peakHp) ? String(Math.round(lap.peakHp)) : "--", COL_HP);
    drawStat(ctx, padX + cw, dTop + Math.round(statsH * 0.15), cw, statsH,
      "PEAK TORQUE, Nm", num(lap.peakNm) ? String(Math.round(lap.peakNm)) : "--", COL_NM);
    drawLapChart(ctx, padX, dTop + statsH, gW - 2 * padX, area - statsH,
      "Power & Torque during run",
      [{ key: "hp", color: COL_HP, label: "hp", dp: 0 },
       { key: "nm", color: COL_NM, label: "Nm", dp: 0 }]);
  } else if (gDetailTab === "hpfp") {
    var aMax = lapHistMax("fuelAct"), rMax = lapHistMax("fuelReq");
    var cw2 = Math.floor((gW - 2 * padX) / 2);
    drawStat(ctx, padX, dTop + Math.round(statsH * 0.15), cw2, statsH,
      "MAX RAIL ACTUAL, bar", num(aMax) ? String(Math.round(aMax)) : "--", COL_FUEL_ACT);
    drawStat(ctx, padX + cw2, dTop + Math.round(statsH * 0.15), cw2, statsH,
      "MAX RAIL REQUESTED, bar", num(rMax) ? String(Math.round(rMax)) : "--", COL_FUEL_REQ);
    drawLapChart(ctx, padX, dTop + statsH, gW - 2 * padX, area - statsH,
      "HPFP rail pressure",
      [{ key: "fuelAct", color: COL_FUEL_ACT, label: "actual", dp: 0 },
       { key: "fuelReq", color: COL_FUEL_REQ, label: "requested", dp: 0, dashed: true }]);
  } else { // ign
    var advMax = lapHistMax("ignAdv");
    var retMin = lapHistMin("retard");
    // knock/misfire events accumulated during this run only (counters are
    // session-wide; we snapshot the baseline when the run starts)
    var knockRun = Math.max(0, counters.knock - lap.knockBase);
    var misRun = Math.max(0, counters.misfireCount - lap.misBase);
    var cw3 = Math.floor((gW - 2 * padX) / 4);
    drawStat(ctx, padX, dTop + Math.round(statsH * 0.15), cw3, statsH,
      "MAX ADVANCE, deg", num(advMax) ? advMax.toFixed(1) : "--", COL_ADV);
    drawStat(ctx, padX + cw3, dTop + Math.round(statsH * 0.15), cw3, statsH,
      "MAX RETARD, deg", num(retMin) ? Math.abs(retMin).toFixed(1) : "--", COL_RET);
    drawStat(ctx, padX + cw3 * 2, dTop + Math.round(statsH * 0.15), cw3, statsH,
      "KNOCK EVENTS", String(knockRun), knockRun > 0 ? c("alert") : c("textPrimary"));
    drawStat(ctx, padX + cw3 * 3, dTop + Math.round(statsH * 0.15), cw3, statsH,
      "MISFIRES LOAD", String(misRun), misRun > 0 ? c("alert") : c("textPrimary"));
    drawLapChart(ctx, padX, dTop + statsH, gW - 2 * padX, area - statsH,
      "Ignition timing under load",
      [{ key: "ignAdv", color: COL_ADV, label: "advance, deg", dp: 1 },
       { key: "retard", color: COL_RET, label: "knock retard, deg", dp: 1 }],
      { zeroBase: false });
  }
}

/* ------------------------------------------------------------------ */
/* render loop                                                        */
/* ------------------------------------------------------------------ */

var gTimer = null;

function render() {
  if (!gCanvas) return;
  lapStep();   // speed crossing / max tracking runs at UI cadence
  var ctx = gCanvas.getContext("2d");
  ctx.fillStyle(c("background"));
  ctx.fillRect(0, 0, gW, gH);

  var top = drawTabs(ctx);
  if (gActiveTab === "main") drawMain(ctx, top);
  else if (gActiveTab === "power") drawPower(ctx, top);
  else if (gActiveTab === "hpfp") drawHpfpTab(ctx, top);
  else if (gActiveTab === "ign") drawIgnTab(ctx, top);
  else if (gActiveTab === "lap") {
    if (gLapView === "detail" && lap.state === "done") drawLapDetails(ctx, top);
    else drawLap(ctx, top);
  }
  else drawPlaceholder(ctx, top, "Session logs \u2014 next step");
}

/* tabs that redraw at the fast (chart/stopwatch) cadence */
function isFastTab() {
  return gActiveTab === "power" || gActiveTab === "hpfp" ||
         gActiveTab === "ign" || gActiveTab === "lap";
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
                    "gearbox", "voltage", "fuelPresAct", "fuelPresReq", "ignAdv"];

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
    liveStep();
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

  // speed for the Lap tab: waves up to ~230 km/h so threshold crossings fire
  var spd = Math.max(0, 230 * Math.sin(t * 0.16));
  if (spd < 3) spd = 0;                                  // standstill phases
  v.speed = spd;

  // HPFP rail pressure actual/requested for the lap detail charts
  set("fuelPresReq", 40 + load * 250);
  set("fuelPresAct", 38 + load * 246 + 4 * Math.sin(t * 3.1));

  // ignition advance / knock retard for the ignition detail chart
  set("ignAdv", num(v.rpm) && v.rpm > 700 ? 8 + load * 22 - Math.abs(retardDemo()) : 8);

  // power/torque for the Power tab: load % straight from the demo wave
  set("loadDirect", load * 100);
  computePower();

  // occasional knock event under load -> counter ticks (boost > 0.5 gate)
  var retard = retardDemo();
  set("knockRetard", retard);
  handleKnock(retard);

  // occasional misfire burst under load
  if (load > 0.6 && Math.sin(t * 2.9) > 0.985) counters.misfireCount++;
}

/* demo knock retard: brief negative spikes while heavily loaded */
function retardDemo() {
  var load = Math.max(0, Math.sin(gDemoT * 0.4));
  return (load > 0.7 && Math.sin(gDemoT * 1.7) > 0.97) ? -3.5 : 0;
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
    gTimer = setInterval(render, isFastTab() ? POWER_REFRESH_MS : REFRESH_MS);
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
      // leaving/re-entering the lap screen: top tabs always show the main view
      if (gActiveTab !== "lap") gLapView = "main";
      else if (lap.state !== "done") gLapView = "main";
      // Power and Lap tabs run at a faster redraw (chart / stopwatch)
      if (gTimer) {
        clearInterval(gTimer);
        gTimer = setInterval(render, isFastTab() ? POWER_REFRESH_MS : REFRESH_MS);
      }
      render();
      return;
    }
    // Lap detail view: second-level tab strip + BACK button
    if (gActiveTab === "lap" && gLapView === "detail") {
      var dTop = tabH;
      var dTh = Math.round(gH * 0.075);
      if (y >= dTop && y <= dTop + dTh) {
        if (gBackBtnRect && x >= gBackBtnRect[0] && x <= gBackBtnRect[0] + gBackBtnRect[2] &&
            y >= gBackBtnRect[1] && y <= gBackBtnRect[1] + gBackBtnRect[3]) {
          gLapView = "main";
          render();
          return;
        }
        var dw = Math.floor(gW / DETAIL_TABS.length);
        var di = Math.min(DETAIL_TABS.length - 1, Math.floor(x / dw));
        gDetailTab = DETAIL_TABS[di].id;
        render();
        return;
      }
      return;   // rest of the detail screen is not interactive
    }
    // Lap tab: START/STOP toggle + DETAILS button hit-test (rects from drawLap)
    if (gActiveTab === "lap") {
      var r = lap.btnRect;
      if (r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]) {
        lapToggle();
        render();
        return;
      }
      var d = lap.detailsBtnRect;
      if (d && x >= d[0] && x <= d[0] + d[2] && y >= d[1] && y <= d[1] + d[3]) {
        gLapView = "detail";
        render();
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* test hooks (used by kit/tools/simulate.js; harmless on the car)    */
/* ------------------------------------------------------------------ */

exports._sim = {
  lap: lap,
  counters: counters,
  hpfpLive: hpfpLive,
  ignLive: ignLive,
  render: render,
  liveStep: liveStep,
  rewindDemo: function () { gDemoT = 0; },   // speed wave starts at standstill
  touch: function () { return os.touchhandler; },
  setDetailTab: function (id) { gLapView = "detail"; gDetailTab = id; },
  setMainTab: function (id) { gActiveTab = id; gLapView = "main"; }
};

exports.init = init;
