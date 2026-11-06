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

/* Tab ids are stable; the visible label is translated via i18n (key tab_*). */
var TABS = [
  { id: "main",  key: "tab_main" },
  { id: "power", key: "tab_power" },
  { id: "hpfp",  key: "tab_hpfp" },
  { id: "ign",   key: "tab_ign" },
  { id: "fuelcool", key: "tab_fuelcool" },
  { id: "elec",  key: "tab_elec" },
  { id: "tcase", key: "tab_tcase" },
  { id: "lap",   key: "tab_lap" },
  { id: "more",  key: "tab_more" },
  { id: "settings", key: "tab_settings" }
];

/* MORE tab ("Дополнительно"): second-level tabs opened from the bottom
 * buttons of the main grid (same hit-test pattern as LAP -> DETAILS). */
var MORE_TABS = [
  { id: "boost", key: "m_boost" },
  { id: "gearcorr", key: "m_gearcorr" },
  { id: "exhaust", key: "m_exhaust" },
  { id: "logs",  key: "m_logs" },
  { id: "profiles", key: "m_profiles" }
];
var gMoreTab = "boost";     // active second-level tab inside MORE
var gMoreBtnRects = [];     // hit-test rects of the three buttons on entry
var gMoreBackRect = null;   // hit-test rect of the < BACK button in MORE

/* ELECTRIC tab ("Бортовая сеть"): four tiles in a 2x2 grid. */
var ELEC_TILES = [
  { key: "voltage",  labelKey: "t_voltage",     unit: "V", dp: 1 },
  { key: "alternatorTemp", labelKey: "t_alttemp", unit: "\u00b0C", dp: 0 },
  { key: "alternatorLoad", labelKey: "t_altload", unit: "%", dp: 0, bar: true },
  { key: "currentOut", labelKey: "t_output",     unit: "A", dp: 0 }
];

/* FUEL/COOL tab ("Система топлива и охлаждения"): six tiles in a 3x2 grid.
 * oilQuality / oilLevel have no trustworthy UDS source on B58 (the DME does
 * not run an oil-condition sensor; the iDrive level display comes from the
 * cluster module over K-CAN) — they show "--" until a working DID is probed
 * on the car or a dedicated source is wired in. */
var FUELCOOL_TILES = [
  { key: "fuelTemp",    labelKey: "t_fueltemp",     unit: "\u00b0C", dp: 0 },
  { key: "oilQuality",  labelKey: "t_oilqual",   unit: "%",     dp: 0, bar: true },
  { key: "oilLevel",    labelKey: "t_oillvl",     unit: "%",     dp: 0, bar: true },
  { key: "thermoPos",   labelKey: "t_thermo",    unit: "%",     dp: 0, bar: true },
  { key: "fanRpm",      labelKey: "t_fan",           unit: "rpm",   dp: 0 },
  { key: "radTemp",     labelKey: "t_rad",      unit: "\u00b0C", dp: 0 }
];

/* Lap tab: acceleration time targets (km/h) and the live side metrics */
var LAP_TARGETS = [100, 200];
var LAP_METRICS = [
  { key: "boost",    labelKey: "t_boost" },
  { key: "fuelPres", labelKey: "t_fuelpress" },
  { key: "iat",      labelKey: "t_intake" },
  { key: "egt",      labelKey: "t_egt" },
  { key: "speed",    labelKey: "t_speed" }
];

/* Tile labels. The M logo is drawn in the centre cell of the main grid, so
 * every tile uses a short one-word label — long two-word labels (e.g.
 * "Knock events") overflow their narrow side columns on 1920x720.
 * Units are intentionally not rendered for now; they will become a
 * user-facing setting later. */
var PRIMARY_TILES = [
  { key: "boost",    labelKey: "t_boost",     unit: "bar", dp: 2 },
  { key: "iat",      labelKey: "t_intake",    unit: "\u00b0C", dp: 0 },
  { key: "egt",      labelKey: "t_egt",       unit: "\u00b0C", dp: 0 },
  { key: "oilPress", labelKey: "t_oilpress", unit: "bar", dp: 1 },
  { key: "lambda",   labelKey: "t_mix",   unit: "",    dp: 2 },
  { key: "coolant",  labelKey: "t_coolant",   unit: "\u00b0C", dp: 0 },
  { key: "oilTemp",  labelKey: "t_oiltemp",  unit: "\u00b0C", dp: 0 }
];

var SECONDARY_TILES = [
  { key: "voltage",  labelKey: "t_batt",   unit: "V",  dp: 1 },
  { key: "gearbox",  labelKey: "t_gearbox",   unit: "\u00b0C", dp: 0 },
  { key: "knock",    labelKey: "t_knock",     unit: "",   dp: 0, counter: true },
  { key: "misfire",  labelKey: "t_misf",  unit: "",   dp: 0, counter: true }
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
/* Defaults for every profile-able setting. saveCurrentProfile() snapshots
 * gSettings, but on a fresh head unit most keys are absent until the user
 * touches the SETTINGS tab — so the snapshot falls back to these values. */
var DEFAULT_SETTINGS = {
  boostSource: "auto", boostMax: 2.5, pollMs: 1000, demo: "auto",
  language: "en", unitsTemp: "C", speedUnits: "kmh", showUnits: false,
  peakResetMs: PEAK_RESET_MS
};
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
  fuelTemp: null,            // fuel temperature, deg C
  thermoPos: null,           // coolant valve / thermostat position, % open
  fanRpm: null,              // engine cooling fan speed, rpm
  radTemp: null,             // radiator outlet coolant temperature, deg C
  oilQuality: null,          // oil condition %, no trusted source yet -> "--"
  oilLevel: null,            // oil level %, no trusted source yet -> "--"
  battCurrent: null,         // IBS battery current, A (charge positive)
  fanDuty: null,             // cooling fan duty %, raw PWM figure
  aluIst: null,              // ALU_IST actual alternator load current, A
  aluTemp: null,             // regulator/alternator temperature, deg C
  tcLockPct: null,           // xDrive transfer-case clutch lock-up, % (derived)
  tcClutchRaw: null,         // raw clutch-current DID reading, mA (if present)
  tcTemp: null,              // transfer-case oil temperature, deg C (probe)
  slipRpm: null,             // front-vs-rear wheel speed difference, rpm
  accLong: null,             // longitudinal acceleration estimate, m/s^2
  stamp: {}                  // key -> Date.now() of last good read
};

// demo mode: fills every tile with plausible simulated data so the UI can be
// checked without the car. "auto" = on when no vehicle signals arrive.
var gDemoTimer = null;
var gDemoT = 0;
var demoPrevSpeed = null;    // for the simulated acceleration estimate
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
/* Live state for the TCASE tab ("Раздатка"): transfer-case lock-up %. */
var tcaseLive = {
  hist: []                  // [{t, lock}] rolling LIVE_WINDOW_S samples
};

/* MORE -> BOOST GAUGE state: needle gauge with peak hold. The peak decays
 * after BOOST_PEAK_HOLD_MS without a new maximum (same idea as power peaks). */
var BOOST_PEAK_HOLD_MS = 5000;
var boostGauge = {
  peak: null,               // held max boost in bar (relative)
  peakAt: 0
};

/* MORE -> GEAR CORRECTIONS state ("коррекции по коробке").
 * The transmission applies torque-reduction ("correction") events on every
 * shift and on knock/load-limit interventions: for a short window the DME
 * pulls ignition back and the gearbox slips the converter/clutches, so the
 * crankshaft torque that actually reaches the wheels dips below the modelled
 * value. We detect those dips as |acceleration - expected| spikes while under
 * boost, and track per-gear correction magnitude (bar-equivalent intake drop
 * and duration) plus a live rolling chart of boost vs speed — the two axes
 * the user asked for. All figures are derived from data we already poll
 * (boost, speed, accel estimate); no gearbox write access is used. */
var GEAR_CORR_WINDOW_MS = 1200;   // a correction event lasts ~0.3..1 s
var gearCorr = {
  hist: [],               // [{t, boost, speed}] rolling LIVE_WINDOW_S samples
  events: [],             // [{t, gear, dipBar, durMs}] newest first
  totalEvents: 0,
  maxDipBar: null,        // session max correction depth, bar-equivalent
  maxDurMs: null,         // session longest correction, ms
  lastAt: 0,              // debounce between detected events
  curStart: null          // in-progress event start timestamp
};

/* MORE -> EXHAUST FLAP ("Engine Config"-style actuator control).
 * The exhaust flap servo is commanded through the DME via UDS InputOutput
 * Control (service 0x2F), routine-like DID 0464 "Klappe" on B58/DME8FF.
 * Candidates below must be probed on the car; if none respond the buttons
 * stay disabled and show "NO RESPONSE". Safety interlocks mirror what the
 * OEM does for service activation: engine running + coolant warm + vehicle
 * nearly stopped before any write is sent. State readback (flap position %)
 * uses DID candidates from app.json config.dme.flapPos when available. */
var FLAP_SAFE_COOLANT = 30;    // deg C minimum before we allow a write
var FLAP_SAFE_SPEED   = 10;    // km/h maximum while commanding the flap
var flapState = {
  mode: "auto",            // auto | open | closed — last user command
  posPct: null,            // actual flap position % (open=100) if readable
  posFreshAt: 0,
  busy: false,             // a write request is in flight
  msg: null,               // one-line feedback shown under the buttons
  msgAt: 0,
  rects: []                // hit-test rects registered during drawing
};

/* MORE -> LOGGING state.
 * events: ring buffer of notable session events {t, kind, text}.
 * rows:   ring buffer of periodic data snapshots {t, <metric keys>} written
 *         every gSettings.logMs while logging is armed.
 * export: Wi-Fi export progress state (HTTP server on the HU answers the
 *         phone's browser with a CSV download). */
var logState = {
  active: false,            // logging armed (REC button)
  events: [],
  rows: [],
  rowCount: 0,              // total rows written since arming (rows is capped)
  exporting: false,
  exportMsg: null,          // last export status line shown on screen
  btnRect: null,            // hit-test rect of the REC toggle
  wifiBtnRect: null,        // hit-test rect of the WIFI EXPORT button
  clearBtnRect: null        // hit-test rect of the CLEAR button
};
var LOG_ROWS_CAP = 1200;    // ~48 h at 1 row/s — memory stays bounded
var LOG_EVENTS_CAP = 60;

/* MORE -> PROFILES state: named configuration sets saved through the
 * settings module (persisted on the head unit). Active profile name is kept
 * in gSettings.profile; each profile stores its own JSON under profile_<name>. */
var PROFILE_KEYS = ["boostSource", "boostMax", "pollMs", "demo", "language",
                    "unitsTemp", "speedUnits", "showUnits", "peakResetMs"];
var profileState = {
  names: [],                // existing profile names, loaded at init
  msg: null,                // one-line status feedback
  msgAt: 0,
  rects: []                 // hit-test rects of the buttons drawn this frame
};

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

var ALL_TILES = PRIMARY_TILES.concat(SECONDARY_TILES, FUELCOOL_TILES, ELEC_TILES, [
  { key: "rpm", labelKey: "t_rpm", unit: "", dp: 0 }
]);

function num(x) { return typeof x === "number" && isFinite(x); }

function tileByKey(key) {
  for (var i = 0; i < ALL_TILES.length; i++) if (ALL_TILES[i].key === key) return ALL_TILES[i];
  return null;
}

/* ------------------------------------------------------------------ */
/* i18n + unit conversion                                             */
/* ------------------------------------------------------------------ */

var I18N = {
  en: {
    tab_main: "MAIN", tab_power: "POWER", tab_hpfp: "HPFP", tab_ign: "IGNITION",
    tab_fuelcool: "FUEL/COOL", tab_elec: "ELECTRIC", tab_tcase: "TCASE",
    tab_lap: "LAP", tab_settings: "SETTINGS", tab_more: "MORE",
    m_boost: "BOOST GAUGE", m_gearcorr: "GEAR CORRECTIONS", m_exhaust: "EXHAUST FLAP", m_logs: "LOGGING", m_profiles: "PROFILES",
    ex_title: "EXHAUST FLAP CONTROL", ex_pos: "FLAP POSITION", ex_mode: "MODE",
    ex_auto: "AUTO", ex_open: "OPEN", ex_close: "CLOSED",
    ex_safe: "SAFE TO COMMAND", ex_unsafeSpeed: "SPEED TOO HIGH", ex_unsafeTemp: "ENGINE COLD",
    ex_sending: "SENDING...", ex_noResp: "NO RESPONSE - PROBE DID ON CAR",
    ex_sentOpen: "FLAP OPEN SENT", ex_sentClose: "FLAP CLOSED SENT", ex_sentAuto: "RETURNED TO AUTO",
    ex_note: "Command via UDS 0x2F; OEM releases the flap back to DME control on every start.",
    gc_total: "CORRECTIONS", gc_maxDip: "MAX DIP", gc_maxDur: "MAX DUR", gc_gear: "GEAR",
    gc_last: "LAST EVENTS", gc_none: "NO CORRECTIONS DETECTED", gc_reset: "RESET",
    ch_gc: "Boost vs speed, live", c_boost2: "boost", c_speed2: "speed",
    g_peak: "PEAK", g_hold: "HOLD", g_resetPeak: "RESET PEAK",
    g_max: "MAX",
    lg_rec: "REC", lg_stop: "STOP REC", lg_rows: "ROWS", lg_events: "EVENTS",
    lg_wifi: "WI-FI EXPORT", lg_clear: "CLEAR", lg_idle: "LOGGING OFF",
    lg_on: "LOGGING ON", lg_exportStart: "CSV READY - OPEN THE LINK ON YOUR PHONE",
    lg_exportNoWifi: "NO WI-FI IP - CHECK SETTINGS > CONNECTIVITY",
    lg_noData: "NO ROWS YET",
    pr_active: "ACTIVE", pr_save: "SAVE CURRENT AS", pr_load: "LOAD",
    pr_del: "DELETE", pr_none: "NO PROFILES SAVED", pr_saved: "PROFILE SAVED",
    pr_loaded: "PROFILE LOADED", pr_deleted: "PROFILE DELETED",
    pr_exists: "NAME ALREADY EXISTS",
    t_boost: "BOOST", t_intake: "INTAKE", t_egt: "EGT", t_oilpress: "OIL PRESS",
    t_mix: "MIXTURE", t_coolant: "COOLANT", t_oiltemp: "OIL TEMP", t_batt: "BATTERY",
    t_gearbox: "GEARBOX", t_knock: "KNOCK", t_misf: "MISFIRES", t_rpm: "RPM",
    t_voltage: "VOLTAGE", t_alttemp: "ALT TEMP", t_altload: "ALT LOAD", t_output: "OUTPUT",
    t_fueltemp: "FUEL TEMP", t_oilqual: "OIL QUALITY", t_oillvl: "OIL LEVEL",
    t_thermo: "THERMOSTAT", t_fan: "FAN", t_rad: "RADIATOR",
    t_fuelpress: "FUEL PRESS", t_speed: "SPEED",
    s_language: "Language", s_unitsTemp: "Temperature units", s_unitsSpeed: "Speed units",
    s_showUnits: "Show units on tiles", s_peakReset: "Peak reset interval",
    s_boostSource: "Boost source", s_demo: "Demo mode", s_pollRate: "DME poll rate",
    s_hint: "Tap a value to switch it - settings persist automatically",
    v_en: "English", v_ru: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439",
    v_celsius: "\u00b0C", v_fahrenheit: "\u00b0F", v_kmh: "km/h", v_mph: "mph",
    v_on: "ON", v_off: "OFF", v_auto: "AUTO",
    u_degC: "\u00b0C", u_degF: "\u00b0F", u_bar: "bar", u_volt: "V", u_pct: "%",
    u_rpm: "rpm", u_amp: "A", u_kmh: "km/h", u_mph: "mph",
    u_ps: "hp", u_kw: "kW", u_nm: "Nm", u_lbft: "lb-ft", u_sec: "sec",
    l_peak: "PEAK", l_start: "START", l_stop: "STOP", l_details: "DETAILS",
    l_back: "< BACK", l_rec: "REC", l_runComplete: "RUN COMPLETE",
    l_speedZero: "SPEED MUST BE 0 TO START",
    l_powerTorque: "Power & Torque during run", l_hpfpRail: "HPFP rail pressure",
    l_ignLoad: "Ignition timing under load",
    l_maxRailAct: "MAX RAIL ACTUAL", l_maxRailReq: "MAX RAIL REQUESTED",
    l_maxAdv: "MAX ADVANCE", l_maxRet: "MAX RETARD",
    l_knockEvents: "KNOCK EVENTS", l_misfiresLoad: "MISFIRES LOAD",
    l_peakPower: "PEAK POWER", l_peakTorque: "PEAK TORQUE",
    c_actual: "actual", c_requested: "requested", c_advance: "advance",
    c_retard: "retard", c_lockup: "lock-up",
    ch_powerTorque: "Power & Torque, last 30 s",
    ch_hpfp: "HPFP rail pressure, live",
    ch_ign: "Ignition timing, live",
    ch_tcase: "Transfer-case lock-up, live",
    st_thermostat: "THERMOSTAT OPEN", st_fanSpeed: "FAN SPEED",
    st_railActual: "RAIL ACTUAL", st_railRequested: "RAIL REQ",
    st_lockPct: "LOCK-UP", st_frontShare: "FRONT SHARE",
    st_current: "CURRENT", st_battery: "BATTERY", st_alternator: "ALTERNATOR",
    st_power: "POWER", st_torque: "TORQUE",
    st_loadPct: "LOAD", st_temp: "TEMP", st_voltage: "VOLTAGE",
    g_left: "LEFT", g_right: "RIGHT", g_now: "NOW",
    n_settings: "SETTINGS",
    n_appearance: "APPEARANCE", n_data: "DATA", n_saved: "SAVED",
    hint_saved: "\u2713 saved"
  },
  ru: {
    tab_main: "\u041e\u0441\u043d.", tab_power: "\u041c\u043e\u0449\u043d.",
    tab_hpfp: "\u0422\u041d\u0412\u0414", tab_ign: "\u0417\u0430\u0436\u0438\u0433.",
    tab_fuelcool: "\u0422\u041e\u041f\u041b\u0418\u0412\u041e", tab_elec: "\u0421\u0415\u0422\u042c",
    tab_tcase: "\u0420\u0410\u0417\u0414", tab_lap: "\u0417\u0410\u041c\u0415\u0420",
    tab_settings: "\u041d\u0410\u0421\u0422\u0420", tab_more: "\u0414\u041e\u041f",
    m_boost: "\u041d\u0410\u0414\u0414\u0423\u0412 (\u0428\u041a\u0410\u041b\u0410)",
    m_gearcorr: "\u041a\u041e\u0420\u0420. \u041f\u041e \u041a\u041f",
    m_exhaust: "\u0417\u0410\u0421\u041b\u041e\u041d\u041a\u0410",
    ex_title: "\u0423\u041f\u0420\u0410\u0412\u041b\u0415\u041d\u0418\u0415 \u0417\u0410\u0421\u041b\u041e\u041d\u041a\u041e\u0419",
    ex_pos: "\u041f\u041e\u0417\u0418\u0426\u0418\u042f \u0417\u0410\u0421\u041b\u041e\u041d\u041a\u0418", ex_mode: "\u0420\u0415\u0416\u0418\u041c",
    ex_auto: "\u0410\u0412\u0422\u041e", ex_open: "\u041e\u0422\u041a\u0420\u042b\u0422\u042c", ex_close: "\u0417\u0410\u041a\u0420\u042b\u0422\u042c",
    ex_safe: "\u0411\u0415\u0417\u041e\u041f\u0410\u0421\u041d\u041e", ex_unsafeSpeed: "\u0421\u041a\u041e\u0420\u041e\u0421\u0422\u042c \u0412\u042b\u0421\u041e\u041a\u0410",
    ex_unsafeTemp: "\u0414\u0412\u0418\u0413\u0410\u0422\u0415\u041b\u042c \u0425\u041e\u041b\u041e\u0414\u041d\u042b\u0419",
    ex_sending: "\u041e\u0422\u041f\u0420\u0410\u0412\u041a\u0410...", ex_noResp: "\u041d\u0415\u0422 \u041e\u0422\u0412\u0415\u0422\u0410 - \u041f\u0420\u041e\u0412\u0415\u0420\u0418\u0422\u042c DID",
    ex_sentOpen: "\u041e\u0422\u041a\u0420\u042b\u0422\u0418\u042c \u041e\u0422\u041f\u0420\u0410\u0412\u041b\u0415\u041d\u041e",
    ex_sentClose: "\u0417\u0410\u041a\u0420\u042b\u0422\u042c \u041e\u0422\u041f\u0420\u0410\u0412\u041b\u0415\u041d\u041e",
    ex_sentAuto: "\u0412\u041e\u0417\u0412\u0420\u0410\u0422 \u0412 \u0410\u0412\u0422\u041e",
    ex_note: "\u041a\u043e\u043c\u0430\u043d\u0434\u0430 UDS 0x2F; \u043f\u0440\u0438 \u0437\u0430\u043f\u0443\u0441\u043a\u0435 \u0434\u0432\u0438\u0433\u0430\u0442\u0435\u043b\u044f DME \u0437\u0430\u0431\u0438\u0440\u0430\u0435\u0442 \u0437\u0430\u0441\u043b\u043e\u043d\u043a\u0443 \u043e\u0431\u0440\u0430\u0442\u043d\u043e.",
    gc_total: "\u041a\u041e\u0420\u0420\u0415\u041a\u0426\u0418\u0418", gc_maxDip: "\u041c\u0410\u041a\u0421 \u041f\u0420\u041e\u0421\u0410\u0414",
    gc_maxDur: "\u041c\u0410\u041a\u0421 \u0414\u041b\u0418\u0422.", gc_gear: "\u041f\u0415\u0420\u0415\u0414\u0410\u0427\u0410",
    gc_last: "\u041f\u041e\u0421\u041b\u0415\u0414\u041d\u0418\u0415", gc_none: "\u041a\u041e\u0420\u0420\u0415\u041a\u0426\u0418\u0419 \u041d\u0415\u0422",
    gc_reset: "\u0421\u0411\u0420\u041e\u0421", ch_gc: "\u041d\u0430\u0434\u0434\u0443\u0432 \u0438 \u0441\u043a\u043e\u0440\u043e\u0441\u0442\u044c, \u043e\u043d\u043b\u0430\u0439\u043d",
    c_boost2: "\u043d\u0430\u0434\u0434\u0443\u0432", c_speed2: "\u0441\u043a\u043e\u0440\u043e\u0441\u0442\u044c",
    m_logs: "\u0416\u0423\u0420\u041d\u0410\u041b", m_profiles: "\u041f\u0420\u041e\u0424\u0418\u041b\u0418",
    g_peak: "\u041f\u0418\u041a", g_hold: "\u0423\u0414\u0415\u0420\u0416\u0410\u041d\u0418\u0415",
    g_resetPeak: "\u0421\u0411\u0420\u041e\u0421 \u041f\u0418\u041a\u0410", g_max: "\u041c\u0410\u041a\u0421",
    lg_rec: "\u0417\u0410\u041f\u0418\u0421\u042c", lg_stop: "\u0421\u0422\u041e\u041f \u0417\u0410\u041f\u0418\u0421\u0418",
    lg_rows: "\u0421\u0422\u0420\u041e\u041a", lg_events: "\u0421\u041e\u0411\u042b\u0422\u0418\u042f",
    lg_wifi: "\u0412\u042b\u0413\u0420\u0423\u0417\u041a\u0410 WI-FI", lg_clear: "\u041e\u0427\u0418\u0421\u0422\u0418\u0422\u042c",
    lg_idle: "\u0417\u0410\u041f\u0418\u0421\u042c \u0412\u042b\u041a\u041b", lg_on: "\u0417\u0410\u041f\u0418\u0421\u042c \u0412\u041a\u041b",
    lg_exportStart: "CSV \u0413\u041e\u0422\u041e\u0412 - \u041e\u0422\u041a\u0420\u041e\u0419\u0422\u0415 \u0421\u0421\u042b\u041b\u041a\u0423 \u041d\u0410 \u0422\u0415\u041b\u0415\u0424\u041e\u041d\u0415",
    lg_exportNoWifi: "\u041d\u0415\u0422 IP WI-FI - \u041f\u0420\u041e\u0412\u0415\u0420\u042c\u0422\u0415 \u041f\u041e\u0414\u041a\u041b\u042e\u0427\u0415\u041d\u0418\u0415",
    lg_noData: "\u0421\u0422\u0420\u041e\u041a \u0415\u0429\u0401 \u041d\u0415\u0422",
    pr_active: "\u0410\u041a\u0422\u0418\u0412\u041d\u042b\u0419", pr_save: "\u0421\u041e\u0425\u0420\u0410\u041d\u0418\u0422\u042c \u041a\u0410\u041a",
    pr_load: "\u0417\u0410\u0413\u0420\u0423\u0417\u0418\u0422\u042c", pr_del: "\u0423\u0414\u0410\u041b\u0418\u0422\u042c",
    pr_none: "\u041f\u0420\u041e\u0424\u0418\u041b\u0418 \u041d\u0415 \u0421\u041e\u0425\u0420\u0410\u041d\u0415\u041d\u042b",
    pr_saved: "\u041f\u0420\u041e\u0424\u0418\u041b\u042c \u0421\u041e\u0425\u0420\u0410\u041d\u0415\u041d",
    pr_loaded: "\u041f\u0420\u041e\u0424\u0418\u041b\u042c \u0417\u0410\u0413\u0420\u0423\u0416\u0415\u041d",
    pr_deleted: "\u041f\u0420\u041e\u0424\u0418\u041b\u042c \u0423\u0414\u0410\u041b\u0415\u041d",
    pr_exists: "\u0422\u0410\u041a\u041e\u0415 \u0418\u041c\u042f \u0423\u0416\u0415 \u0415\u0421\u0422\u042c",
    t_boost: "\u041d\u0410\u0414\u0414\u0423\u0412", t_intake: "\u0412\u041f\u0423\u0421\u041a",
    t_egt: "\u0412\u042b\u0425\u041b\u041e\u041f", t_oilpress: "\u041c\u0410\u0421\u041b\u041e \u0414",
    t_mix: "\u0421\u041c\u0415\u0421\u042c", t_coolant: "\u0410\u041d\u0422\u0418\u0424\u0420",
    t_oiltemp: "\u041c\u0410\u0421\u041b\u041e \u0422", t_batt: "\u0410\u041a\u0411",
    t_gearbox: "\u0410\u041a\u041f\u041f", t_knock: "\u0414\u0415\u0422\u041e\u041d",
    t_misf: "\u041f\u0420\u041e\u041f\u0423\u0421\u041a", t_rpm: "\u041e\u0411/\u041c\u0418\u041d",
    t_voltage: "\u041d\u0410\u041f\u0420\u042f\u0416", t_alttemp: "\u0413\u0415\u041d \u0422",
    t_altload: "\u041d\u0410\u0413\u0420\u0423\u0417\u041a\u0410", t_output: "\u041e\u0422\u0414\u0410\u0427\u0410",
    t_fueltemp: "\u0422\u041e\u041f\u041b\u0418\u0412\u041e", t_oilqual: "\u041c\u0410\u0421\u041b\u041e \u041a",
    t_oillvl: "\u0423\u0420\u041e\u0412\u0415\u041d\u042c", t_thermo: "\u0422\u0415\u0420\u041c\u041e",
    t_fan: "\u0412\u0415\u041d\u0422", t_rad: "\u0420\u0410\u0414\u0418\u0410\u0422",
    t_fuelpress: "\u0422\u041d\u0412\u0414", t_speed: "\u0421\u041a\u041e\u0420\u041e\u0421\u0422\u042c",
    s_language: "\u042f\u0437\u044b\u043a", s_unitsTemp: "\u0415\u0434. \u0442\u0435\u043c\u043f\u0435\u0440\u0430\u0442\u0443\u0440\u044b",
    s_unitsSpeed: "\u0415\u0434. \u0441\u043a\u043e\u0440\u043e\u0441\u0442\u0438", s_showUnits: "\u041f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0442\u044c \u0435\u0434\u0438\u043d\u0438\u0446\u044b",
    s_peakReset: "\u0421\u0431\u0440\u043e\u0441 \u043f\u0438\u043a\u043e\u0432",
    s_boostSource: "\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a \u043d\u0430\u0434\u0434\u0443\u0432\u0430",
    s_hint: "\u041d\u0430\u0436\u043c\u0438\u0442\u0435 \u043d\u0430 \u0437\u043d\u0430\u0447\u0435\u043d\u0438\u0435, \u0447\u0442\u043e\u0431\u044b \u043f\u0435\u0440\u0435\u043a\u043b\u044e\u0447\u0438\u0442\u044c - \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438 \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u044e\u0442\u0441\u044f \u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u0435\u0441\u043a\u0438",
    s_demo: "\u0414\u0435\u043c\u043e-\u0440\u0435\u0436\u0438\u043c", s_pollRate: "\u041e\u043f\u0440\u043e\u0441 DME",
    v_en: "English", v_ru: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439",
    v_celsius: "\u00b0C", v_fahrenheit: "\u00b0F", v_kmh: "\u043a\u043c/\u0447", v_mph: "\u043c\u0438\u043b\u044c/\u0447",
    v_on: "\u0412\u041a\u041b", v_off: "\u0412\u042b\u041a\u041b", v_auto: "\u0410\u0412\u0422\u041e",
    u_degC: "\u00b0C", u_degF: "\u00b0F", u_bar: "\u0431\u0430\u0440", u_volt: "\u0412",
    u_pct: "%", u_rpm: "\u043e\u0431/\u043c\u0438\u043d", u_amp: "\u0410",
    u_kmh: "\u043a\u043c/\u0447", u_mph: "\u043c\u0438\u043b\u044c/\u0447",
    u_ps: "\u043b.\u0441.", u_kw: "\u043a\u0412\u0442", u_nm: "\u041d\u043c", u_lbft: "\u0444\u0443\u0442-\u0444",
    u_sec: "\u0441\u0435\u043a",
    l_peak: "\u041f\u0418\u041a", l_start: "\u0421\u0422\u0410\u0420\u0422", l_stop: "\u0421\u0422\u041e\u041f",
    l_details: "\u0414\u0415\u0422\u0410\u041b\u0418", l_back: "< \u041d\u0410\u0417\u0410\u0414",
    l_rec: "\u0417\u0410\u041f\u0418\u0421\u042c", l_runComplete: "\u0417\u0410\u041c\u0415\u0420 \u0417\u0410\u0412\u0415\u0420\u0428\u0401\u041d",
    l_speedZero: "\u0421\u0422\u0410\u0420\u0422 \u0422\u041e\u041b\u042c\u041a\u041e \u041f\u0420\u0418 \u0421\u0422\u041e\u042f\u041d\u041a\u0415",
    l_powerTorque: "\u041c\u043e\u0449\u043d\u043e\u0441\u0442\u044c \u0438 \u043c\u043e\u043c\u0435\u043d\u0442 \u0437\u0430 \u0437\u0430\u043c\u0435\u0440",
    l_hpfpRail: "\u0414\u0430\u0432\u043b\u0435\u043d\u0438\u0435 \u0422\u041d\u0412\u0414",
    l_ignLoad: "\u0423\u0433\u043b\u044b \u0417\u0430\u0436\u0438\u0433\u0430\u043d\u0438\u044f \u043f\u043e\u0434 \u043d\u0430\u0433\u0440\u0443\u0437\u043a\u043e\u0439",
    l_maxRailAct: "\u041c\u0410\u041a\u0421 \u0424\u0410\u041a\u0422", l_maxRailReq: "\u041c\u0410\u041a\u0421 \u0417\u0410\u041f\u0420",
    l_maxAdv: "\u041c\u0410\u041a\u0421 \u0423\u0413\u041e\u041b", l_maxRet: "\u041c\u0410\u041a\u0421 \u041e\u041f\u0417\u0414",
    l_knockEvents: "\u0414\u0415\u0422\u041e\u041d\u0410\u0426\u0418\u0418", l_misfiresLoad: "\u041f\u0420\u041e\u041f\u0423\u0421\u041a\u0418",
    l_peakPower: "\u041f\u0418\u041a \u041c\u041e\u0429\u041d", l_peakTorque: "\u041f\u0418\u041a \u041c\u041e\u041c\u0415\u041d\u0422",
    c_actual: "\u0444\u0430\u043a\u0442", c_requested: "\u0437\u0430\u043f\u0440", c_advance: "\u0443\u0433\u043e\u043b",
    c_retard: "\u043e\u043f\u0437\u0434", c_lockup: "\u0431\u043b\u043e\u043a",
    ch_powerTorque: "\u041c\u043e\u0449\u043d\u043e\u0441\u0442\u044c / \u043c\u043e\u043c\u0435\u043d\u0442, 30 \u0441",
    ch_hpfp: "\u0422\u041d\u0412\u0414, \u043e\u043d\u043b\u0430\u0439\u043d",
    ch_ign: "\u0417\u0430\u0436\u0438\u0433\u0430\u043d\u0438\u0435, \u043e\u043d\u043b\u0430\u0439\u043d",
    ch_tcase: "\u0411\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u043a\u0430 \u0440\u0430\u0437\u0434\u0430\u0442\u043a\u0438",
    st_thermostat: "\u0422\u0415\u0420\u041c\u041e\u0421\u0422\u0410\u0422", st_fanSpeed: "\u0412\u0415\u041d\u0422\u0418\u041b\u042f\u0422\u041e\u0420",
    st_railActual: "\u0424\u0410\u041a\u0422", st_railRequested: "\u0417\u0410\u041f\u0420",
    st_lockPct: "\u0411\u041b\u041e\u041a", st_frontShare: "\u041f\u0415\u0420\u0415\u0414",
    st_current: "\u0422\u041e\u041a", st_battery: "\u0410\u041a\u0411", st_alternator: "\u0413\u0415\u041d\u0415\u0420\u0410\u0422\u041e\u0420",
    st_power: "\u041c\u041e\u0429\u041d\u041e\u0421\u0422\u042c", st_torque: "\u041c\u041e\u041c\u0415\u041d\u0422",
    st_loadPct: "\u041d\u0410\u0413\u0420", st_temp: "\u0422\u0415\u041c\u041f", st_voltage: "\u041d\u0410\u041f\u0420\u042f\u0416",
    g_left: "\u0421\u041b\u0415\u0412\u0410", g_right: "\u0421\u041f\u0420\u0410\u0412\u0410", g_now: "\u0421\u0415\u0419\u0427\u0410\u0421",
    n_settings: "\u041d\u0410\u0421\u0422\u0420\u041e\u0419\u041a\u0418",
    n_appearance: "\u0412\u041d\u0415\u0428\u041d\u0418\u0419 \u0412\u0418\u0414", n_data: "\u0414\u0410\u041d\u041d\u042b\u0415",
    n_saved: "\u0421\u041e\u0425\u0420\u0410\u041d\u0415\u041d\u041e",
    hint_saved: "\u2713 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e"
  }
};

function lang() { return (gSettings && gSettings.language === "ru") ? "ru" : "en"; }

function tr(key) {
  var d = I18N[lang()] || I18N.en;
  if (d[key]) return d[key];
  return I18N.en[key] !== undefined ? I18N.en[key] : key;
}

/* tile label helper: translated when a labelKey is present */
function tl(item) { return item.labelKey ? tr(item.labelKey) : (item.label || ""); }

/* ---- unit conversion layer ------------------------------------------------
 * The data pipeline always stores SI-ish canonical values:
 *   temperatures in degC, speed in km/h, power in metric hp (PS), torque in Nm.
 * Display goes through conv()/unitFor(), which apply the user settings
 * unitsTemp (C|F) and unitsSpeed (kmh|mph). Boost (bar), pressure (bar),
 * lambda, %, V, A, rpm are locale-neutral and pass through unchanged.       */

function tempUnit() { return (gSettings && gSettings.unitsTemp === "F") ? "F" : "C"; }
function speedUnit() { return (gSettings && gSettings.speedUnits === "mph") ? "mph" : "kmh"; }

function conv(key, val) {
  if (!num(val)) return val;
  switch (key) {
    case "iat": case "egt": case "coolant": case "oilTemp": case "gearbox":
    case "fuelTemp": case "radTemp": case "alternatorTemp":
      return tempUnit() === "F" ? val * 9 / 5 + 32 : val;
    case "speed":
      return speedUnit() === "mph" ? val * 0.621371 : val;
  }
  return val;
}

function unitFor(key) {
  switch (key) {
    case "iat": case "egt": case "coolant": case "oilTemp": case "gearbox":
    case "fuelTemp": case "radTemp": case "alternatorTemp":
      return tempUnit() === "F" ? tr("u_degF") : tr("u_degC");
    case "boost": case "oilPress": case "fuelPres": case "fuelPresAct": case "fuelPresReq":
      return tr("u_bar");
    case "voltage": return tr("u_volt");
    case "currentOut": return tr("u_amp");
    case "lambda": return "";                       // dimensionless ratio
    case "knock": case "misfire": return "";         // counters
    case "speed": return speedUnit() === "mph" ? tr("u_mph") : tr("u_kmh");
    case "fanRpm": case "rpm": return tr("u_rpm");
    case "thermoPos": case "oilQuality": case "oilLevel": case "alternatorLoad":
    case "tcLockPct":
      return tr("u_pct");
  }
  return "";
}

function showUnits() { return !!(gSettings && gSettings.showUnits); }

function fmt(key, val) {
  var tile = tileByKey(key);
  if (!num(val)) return "--";
  var dp = tile ? tile.dp : 1;
  var out = conv(key, val).toFixed(dp);
  if (showUnits()) {
    var u = unitFor(key);
    if (u) out += " " + u;
  }
  return out;
}

/* lap-tab thresholds: stored in km/h; converted to the display unit for the
 * labels, while crossing detection keeps comparing in km/h internally. */
function lapTargetLabel(tgt) {
  var d = conv("speed", tgt);
  return (tgt === 100 ? "0-" : tgt === 200 ? "0-" : "") + Math.round(d);
}
function lapRangeLabel(a, b) {
  return Math.round(conv("speed", a)) + "-" + Math.round(conv("speed", b));
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
  if (key === "currentOut") return alternatorOutputA();
  if (key === "alternatorLoad") return alternatorLoadPct();
  if (key === "alternatorTemp") return alternatorTempC();
  if (key === "tcLockPct") return tcaseLockPct();
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

/* ELECTRIC tab ("Бортовая сеть") derived figures.
 * - tocootдача (alternator output current): prefer the direct ALU_IST figure
 *   (actual alternator load in A); fall back to IBS battery current (charge
 *   side only) so the tile still shows something while driving.
 * - нагрузка (alternator load %): ALU_IST against the configured nominal max
 *   output; without ALU_IST we cannot derive a real duty -> "--".
 * - температура: regulator/alternator temperature DID; no trusted source yet
 *   on most B58 DMEs -> "--" until probed on the car.
 * - напряжение: IBS battery voltage (same figure as the MAIN tile). */
function alternatorOutputA() {
  if (isFresh("aluIst")) return v.aluIst;
  if (isFresh("battCurrent") && v.battCurrent > 0) return v.battCurrent;
  return null;
}

function alternatorLoadPct() {
  if (isFresh("aluIst")) {
    var nom = (gConfig.elec && num(gConfig.elec.alternatorMaxA)) ? gConfig.elec.alternatorMaxA : 170;
    return Math.min(100, Math.max(0, v.aluIst / nom * 100));
  }
  return null;
}

function alternatorTempC() {
  return isFresh("aluTemp") ? v.aluTemp : null;
}

/* TCASE tab ("Раздатка"): xDrive transfer-case lock-up percentage.
 * Primary source (to be probed on the car): a direct clutch-duty / system-
 * torque DID from the transfer-case ECU — stored as tcClutchRaw. When it is
 * not available we fall back to a physically-derived estimate of how much
 * torque the multiplate clutch is currently sending to the front axle:
 *     required clamping force ~ wheel-slip speed difference x longitudinal
 *     acceleration, mapped through the engine torque at the current rpm and
 *     normalised by the clutch maximum (config.tcase). The result is clamped
 *     to 0..100 % and smoothed so the tile does not flicker. */
function tcaseLockPct() {
  if (isFresh("tcLockPct")) return v.tcLockPct;   // demo / direct feed
  if (isFresh("tcClutchRaw")) {
    var nom = (gConfig.tcase && num(gConfig.tcase.clutchMaxMa)) ? gConfig.tcase.clutchMaxMa : 2000;
    var pct = Math.min(100, Math.max(0, v.tcClutchRaw / nom * 100));
    return smoothLock(pct);
  }
  var slip = num(v.slipRpm) ? v.slipRpm : 0;      // front-vs-rear wheel diff
  var acc = num(v.accLong) ? v.accLong : 0;       // longitudinal accel, m/s^2
  var tq = num(power.nm) ? power.nm : 0;          // engine torque right now
  if (!num(v.speed) || v.speed < 2 || tq <= 0) return smoothLock(0);
  var cap = (gConfig.tcase && num(gConfig.tcase.lockCapPct)) ? gConfig.tcase.lockCapPct : 100;
  // demand grows with slip and with drive torque; small deadband for noise
  var demand = (Math.max(0, Math.abs(slip) - 15) * 0.9 + Math.max(0, acc) * 30) * (tq / 450);
  return smoothLock(Math.min(cap, demand));
}

var gLockSmooth = null;
function smoothLock(pct) {
  if (!num(gLockSmooth)) { gLockSmooth = pct; return gLockSmooth; }
  gLockSmooth += (pct - gLockSmooth) * 0.25;      // low-pass, ~0.4 s settling
  return gLockSmooth;
}

/* longitudinal acceleration estimate: derivative of speed over time,
 * refreshed at the sampler cadence while the vehicle is moving */
var gAccState = { t: 0, spd: null };
function updateAccEstimate() {
  var spd = lapSpeedKmh();
  var now = Date.now();
  if (num(spd) && num(gAccState.spd) && now - gAccState.t > 80) {
    var dt = (now - gAccState.t) / 1000;
    var a = (spd - gAccState.spd) / 3.6 / dt;     // km/h -> m/s per second
    v.accLong = Math.max(-12, Math.min(12, a));   // sanity clamp
    markFresh("accLong");
    gAccState.t = now;
    gAccState.spd = spd;
  } else if (num(spd) && gAccState.spd === null) {
    gAccState.t = now;
    gAccState.spd = spd;
  }
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
    case "fuelTemp": return val > 60 ? c("warning") : c("textPrimary");
    case "thermoPos": return val > 90 ? c("warning") : c("textPrimary");
    case "fanRpm":   return val > 2500 ? c("warning") : (val > 100 ? c("textPrimary") : c("textTertiary"));
    case "radTemp":  return val > 105 ? c("warning") : c("textPrimary");
    case "oilQuality": return val < 20 ? c("alert") : val < 40 ? c("warning") : c("success");
    case "oilLevel":   return val < 30 ? c("alert") : val < 50 ? c("warning") : c("textPrimary");
    case "alternatorTemp": return val > 120 ? c("alert") : val > 100 ? c("warning") : c("textPrimary");
    case "alternatorLoad": return val > 85 ? c("warning") : (val > 5 ? c("textPrimary") : c("textTertiary"));
    case "currentOut": return val > 5 ? c("success") : c("textTertiary");
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
    ctx.fillText(tr(t.key), x + w / 2, tabH * 0.45);
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
  ctx.fillText(tl(tile), x + pad, y + pad * 0.7);

  // value only — units are intentionally hidden for now (they live in the
  // tile config and will become a user-facing setting later)
  var col = tileColor(tile.key, val);
  ctx.font = "bold " + Math.round(th * 0.40) + "px sans-serif";
  ctx.fillStyle(col);
  var txt = fmt(tile.key, val);
  ctx.fillText(txt, x + pad, y + th * 0.34);

  // optional 0..100 fill bar along the bottom of the tile (percent metrics)
  if (tile.bar && num(val)) {
    var bx = x + pad, bw = tw - 2 * pad;
    var by = y + th - Math.round(th * 0.16), bh = Math.max(4, Math.round(th * 0.07));
    ctx.fillStyle(c("divider") || c("textTertiary"));
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle(col);
    ctx.fillRect(bx, by, Math.round(bw * Math.min(Math.max(val, 0), 100) / 100), bh);
  }
}

/* FUEL/COOL tab: six tiles in a 3 x 2 grid under the tab strip. */
function drawFuelCoolTab(ctx, top) {
  var area = gH - top;
  var cols = 3, rows = 2;
  var cw = Math.floor(gW / cols);
  var rh = Math.floor(area / rows);
  for (var i = 0; i < FUELCOOL_TILES.length; i++) {
    var t = FUELCOOL_TILES[i];
    var x = (i % cols) * cw;
    var y = top + Math.floor(i / cols) * rh;
    drawTile(ctx, x, y, cw, rh, t, valueFor(t.key));
  }
}

/* ELECTRIC tab ("Бортовая сеть"): four tiles in a 2 x 2 grid. */
function drawElecTab(ctx, top) {
  var area = gH - top;
  var cols = 2, rows = 2;
  var cw = Math.floor(gW / cols);
  var rh = Math.floor(area / rows);
  for (var i = 0; i < ELEC_TILES.length; i++) {
    var t = ELEC_TILES[i];
    var x = (i % cols) * cw;
    var y = top + Math.floor(i / cols) * rh;
    drawTile(ctx, x, y, cw, rh, t, valueFor(t.key));
  }
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

/* Power tab: current + peak power/torque. Values are canonical (hp/Nm);
 * the display converts through powerVal()/torqueVal() so a future hp/kW or
 * Nm/lb-ft setting plugs in at these two helpers only. */
function powerDisp(v) { return num(v) ? Math.round(v) : null; }
function torqueDisp(v) { return num(v) ? Math.round(v) : null; }

function drawPower(ctx, top) {
  var area = gH - top;
  var numH = Math.round(area * 0.34);
  var fresh = num(power.hp) && (Date.now() - power.stamp) < STALE_MS;

  // two big number tiles: Power / Torque with current + peak lines
  var half = Math.floor(gW / 2);
  drawPowerTile(ctx, 0, top, half, numH, tr("st_power"), "hp",
    fresh ? power.hp : null, fresh ? power.peakHp : null, COL_POWER);
  drawPowerTile(ctx, half, top, gW - half, numH, tr("st_torque"), "nm",
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
  var txt = num(cur) ? String(kind === "hp" ? powerDisp(cur) : torqueDisp(cur)) : "--";
  var unit = kind === "hp" ? tr("u_ps") : tr("u_nm");
  ctx.fillText(txt, x + pad, y + th * 0.30);
  ctx.font = Math.round(th * 0.20) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  var vw = ctx.measureText(txt).width;
  ctx.fillText(unit, x + pad + vw + 8, y + th * 0.30 + Math.round(th * 0.16));

  // peak line under the number
  ctx.font = Math.round(th * 0.17) + "px sans-serif";
  ctx.fillStyle(num(peak) ? col : c("textTertiary"));
  var ptxt = tr("l_peak") + " " + (num(peak) ? String(kind === "hp" ? powerDisp(peak) : torqueDisp(peak)) + " " + unit : "--");
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

  // TCASE tab: rolling lock-up % history for the live chart
  updateAccEstimate();
  pushLive(tcaseLive.hist, { t: now, lock: tcaseLockPct() });

  // MORE -> GEAR CORRECTIONS: rolling boost/speed history + dip detection
  pushLive(gearCorr.hist, { t: now, boost: currentBoost(), speed: lapSpeedKmh() });
  gearCorrStep(now);
}

/* ------------------------------------------------------------------ */
/* gear corrections ("коррекции по коробке")                          */
/* ------------------------------------------------------------------ */

/* Gear estimate from rpm/speed (8HP final drive ~3.15, typical ratios).
 * Used only to label correction events; when both signals are missing the
 * event is labelled "-" (e.g. clutchless launches, coasting). */
var GEAR_RATIOS = [4.05, 2.71, 1.88, 1.39, 1.09, 0.86, 0.71, 0.59];
var GEAR_FINAL = 3.15;
var GEAR_WHEEL_KM = 2.05;   // wheel circumference, m
function gearEstimate() {
  var rpm = num(v.rpm) ? v.rpm : null;
  var spd = lapSpeedKmh();
  if (!num(rpm) || rpm < 600 || !num(spd) || spd < 1) return null;
  var ratio = rpm / (spd * 1000 / 60 / (Math.PI * GEAR_WHEEL_KM)) * GEAR_FINAL;
  var best = null, bd = 1e9;
  for (var i = 0; i < GEAR_RATIOS.length; i++) {
    var d = Math.abs(GEAR_RATIOS[i] - ratio);
    if (d < bd) { bd = d; best = i + 1; }
  }
  return bd < 0.35 ? best : null;
}

/* Torque-intervention ("correction") detector. The gearbox/DME cut torque
 * for a short window on upshifts and protective interventions; physically it
 * shows up as a sudden drop of charge pressure (boost) while the throttle is
 * still open and the vehicle is under load. We watch the boost derivative
 * over ~0.3 s windows: a fall faster than GC_DIP_BAR_PER_S bar/s while boost
 * > 0.5 bar opens an event; the event closes when boost recovers or after
 * GEAR_CORR_WINDOW_MS. Depth = peak-to-trough drop within the event, bar. */
var GC_DIP_BAR_PER_S = 2.2;     // min boost collapse rate, bar/s
var gcPrev = { t: 0, boost: null };
function gearCorrStep(now) {
  var b = currentBoost();
  if (!num(b)) { gcPrev.boost = null; gearCorr.curStart = null; return; }
  if (num(gcPrev.boost) && now - gcPrev.t > 60 && now - gcPrev.t < 1200) {
    var dt = (now - gcPrev.t) / 1000;
    var rate = (b - gcPrev.boost) / dt;          // bar/s, negative = collapse
    if (rate < -GC_DIP_BAR_PER_S && gcPrev.boost > 0.5 && b > 0.05 &&
        now - gearCorr.lastAt > 400) {           // debounce overlapping edges
      gearCorr.curStart = gcPrev.t;
      gearCorr.dipTop = gcPrev.boost;
      gearCorr.dipBottom = b;
      logEvent("gearcorr", "dip " + (gcPrev.boost - b).toFixed(2) + "bar @" +
               Math.round(lapSpeedKmh() || 0) + "km/h");
    } else if (num(gearCorr.curStart)) {
      if (b < (gearCorr.dipBottom !== undefined ? gearCorr.dipBottom : b)) gearCorr.dipBottom = b;
      var dur = now - gearCorr.curStart;
      if ((rate > 0.5 && b >= (gearCorr.dipTop || b) - 0.1) || dur > GEAR_CORR_WINDOW_MS) {
        var dip = Math.max(0, (gearCorr.dipTop || 0) - (gearCorr.dipBottom || 0));
        gearCorr.events.unshift({ t: gearCorr.curStart, gear: gearEstimate(),
                                  dipBar: dip, durMs: Math.round(dur) });
        while (gearCorr.events.length > 20) gearCorr.events.pop();
        gearCorr.totalEvents++;
        if (!num(gearCorr.maxDipBar) || dip > gearCorr.maxDipBar) gearCorr.maxDipBar = dip;
        if (!num(gearCorr.maxDurMs) || dur > gearCorr.maxDurMs) gearCorr.maxDurMs = Math.round(dur);
        gearCorr.lastAt = now;
        gearCorr.curStart = null;
      }
    }
  }
  gcPrev.t = now; gcPrev.boost = b;
}

function resetGearCorr() {
  gearCorr.events = [];
  gearCorr.totalEvents = 0;
  gearCorr.maxDipBar = null;
  gearCorr.maxDurMs = null;
  gearCorr.curStart = null;
  gearCorr.lastAt = 0;
}

/* generic rolling live chart: hist entries {t, <keys>}; series keys can be
 * negative-valued (retard) — the y range is derived from the window data.
 * opts.convert: optional canonical->display value mapper (temperature and
 * speed series re-scale with the unit settings).
 * opts.normalize: map each series into its own 0..1 band so that values of
 * very different magnitudes (e.g. boost ~2 bar vs speed ~200 km/h) stay
 * readable on one plot; the axis labels then show the dominant series scale. */
function drawLiveChart(ctx, x, y, w, h, title, hist, series, opts) {
  opts = opts || {};
  var cv = opts.convert || function (vv) { return vv; };
  // per-series normalisation bounds (only used when opts.normalize)
  var nb = [];
  if (opts.normalize) {
    var nnow = Date.now(), nt0 = nnow - LIVE_WINDOW_S * 1000;
    for (var ns = 0; ns < series.length; ns++) {
      var nlo = null, nhi = null;
      for (var nj = 0; nj < hist.length; nj++) {
        var nv = hist[nj][series[ns].key];
        if (!num(nv) || hist[nj].t < nt0) continue;
        if (nlo === null || nv < nlo) nlo = nv;
        if (nhi === null || nv > nhi) nhi = nv;
      }
      if (nlo === null) { nlo = 0; nhi = 1; }
      if (nhi === nlo) nhi = nlo + 1;
      nb.push({ lo: nlo, hi: nhi });
    }
  }
  function plotVal(si, raw) {
    var disp = cv(raw);
    if (!opts.normalize || !nb[si]) return disp;
    return (disp - nb[si].lo) / (nb[si].hi - nb[si].lo);   // 0..1 band
  }
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
      var val = cv(hist[j][key]);
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
      var pv = cv(pt[se.key]);
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
  var uB = tr("u_bar");
  drawLiveStat(ctx, padX, sy, cw, statsH, tr("st_railActual") + ", " + uB,
    num(curA) ? String(Math.round(curA)) : "--", COL_FUEL_ACT, null);
  drawLiveStat(ctx, padX + cw, sy, cw, statsH, tr("l_peak") + " " + tr("c_actual") + ", " + uB,
    num(hpfpLive.peakAct) ? String(Math.round(hpfpLive.peakAct)) : "--",
    COL_FUEL_ACT, hpfpLive.peakAct ? peakFrac(hpfpLive.peakActAt) : null);
  drawLiveStat(ctx, padX + cw * 2, sy, cw, statsH, tr("l_peak") + " " + tr("c_requested") + ", " + uB,
    num(hpfpLive.peakReq) ? String(Math.round(hpfpLive.peakReq)) : "--",
    COL_FUEL_REQ, hpfpLive.peakReq ? peakFrac(hpfpLive.peakReqAt) : null);
  drawLiveChart(ctx, padX, top + statsH, gW - 2 * padX, area - statsH,
    tr("ch_hpfp"), hpfpLive.hist,
    [{ key: "act", color: COL_FUEL_ACT, label: tr("c_actual"), dp: 0 },
     { key: "req", color: COL_FUEL_REQ, label: tr("c_requested"), dp: 0, dashed: true }]);
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
  var uD = "\u00b0";
  drawLiveStat(ctx, padX, sy, cw, statsH, tr("c_advance") + " " + tr("g_now") + ", " + uD,
    num(curAdv) ? curAdv.toFixed(1) : "--", COL_ADV, null);
  drawLiveStat(ctx, padX + cw, sy, cw, statsH, tr("l_maxAdv") + ", " + uD,
    num(ignLive.maxAdv) ? ignLive.maxAdv.toFixed(1) : "--",
    COL_ADV, ignLive.maxAdv ? peakFrac(ignLive.maxAdvAt) : null);
  drawLiveStat(ctx, padX + cw * 2, sy, cw, statsH, tr("l_maxRet") + ", " + uD,
    num(ignLive.maxRet) ? Math.abs(ignLive.maxRet).toFixed(1) : "--",
    COL_RET, ignLive.maxRet ? peakFrac(ignLive.maxRetAt) : null);
  drawLiveStat(ctx, padX + cw * 3, sy, cw, statsH, tr("t_knock") + " / " + tr("t_misf"),
    counters.knock + " / " + counters.misfireCount,
    counters.knock > 0 || counters.misfireCount > 0 ? c("alert") : c("textPrimary"), null);
  drawLiveChart(ctx, padX, top + statsH, gW - 2 * padX, area - statsH,
    tr("ch_ign"), ignLive.hist,
    [{ key: "adv", color: COL_ADV, label: tr("c_advance") + ", " + uD, dp: 1 },
     { key: "ret", color: COL_RET, label: tr("c_retard") + ", " + uD, dp: 1 }],
    { zeroFloor: false });
}

/* drawing: TCASE tab ("Раздатка") — lock-up % big number on top, live chart
 * filling the rest of the screen. */
function drawTcaseTab(ctx, top) {
  var area = gH - top;
  var statsH = Math.round(area * 0.30);
  var padX = Math.round(gW * 0.03);
  var cw = Math.floor((gW - 2 * padX) / 2);
  var curLock = tcaseLockPct();
  var sy = top + Math.round(statsH * 0.10);
  drawLiveStat(ctx, padX, sy, cw, statsH, tr("st_lockPct") + ", " + tr("u_pct"),
    num(curLock) ? String(Math.round(curLock)) : "--", COL_LOCK, null);
  // front/rear torque split hint: xDrive maps lock-up onto a 0..50% front share
  var front = num(curLock) ? Math.round(50 * curLock / 100) : null;
  drawLiveStat(ctx, padX + cw, sy, cw, statsH, tr("st_frontShare") + ", " + tr("u_pct"),
    num(front) ? String(front) : "--", c("textPrimary"), null);
  drawLiveChart(ctx, padX, top + statsH, gW - 2 * padX, area - statsH,
    tr("ch_tcase"), tcaseLive.hist,
    [{ key: "lock", color: COL_LOCK, label: tr("c_lockup") + ", " + tr("u_pct"), dp: 0 }],
    { zeroFloor: true });
}

/* ------------------------------------------------------------------ */
/* MORE tab ("Дополнительно"): BOOST GAUGE / LOGGING / PROFILES        */
/* ------------------------------------------------------------------ */

/* generic filled button; remembers its rect for hit-testing */
function drawButton(ctx, x, y, w, h, label, fillCol, textColor, sizeFrac) {
  ctx.fillStyle(fillCol);
  ctx.fillRoundRect(x, y, w, h, Math.round(h * 0.25));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold " + Math.round(h * (sizeFrac || 0.42)) + "px sans-serif";
  ctx.fillStyle(textColor);
  ctx.fillText(label, x + w / 2, y + h / 2);
  return [x, y, w, h];
}

function inRect(r, x, y) {
  return r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
}

/* Second-level strip inside MORE (same visual language as LAP details).
 * Returns the strip height. */
function drawMoreTabs(ctx, top) {
  var th = Math.round(gH * 0.075);
  var w = Math.floor(gW / MORE_TABS.length);
  ctx.fillStyle(c("surface"));
  ctx.fillRect(0, top, gW, th);
  for (var i = 0; i < MORE_TABS.length; i++) {
    var t = MORE_TABS[i];
    var x = i * w;
    var active = t.id === gMoreTab;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = (active ? "bold " : "") + Math.round(th * 0.42) + "px sans-serif";
    ctx.fillStyle(active ? c("accent") : c("textSecondary"));
    ctx.fillText(tr(t.key), x + w / 2, top + th * 0.45);
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
  gMoreBackRect = [gW - bw - 8, top + 6, bw, th - 12];
  ctx.fillText(tr("l_back"), gW - bw - 8 + bw / 2, top + th / 2);
  return th;
}

/* ---- BOOST GAUGE ---------------------------------------------------- */

var COL_GAUGE_OK = "#1aa05a";     // green arc section
var COL_GAUGE_REDLINE = "#e8452c";

function boostMaxBar() {
  var m = gSettings.boostMax || (gConfig && gConfig.boostMax) || 2.5;
  return num(m) && m > 0 ? m : 2.5;
}

/* half-circle needle gauge: -PI..0 sweep, ticks every 0.5 bar, redline from
 * 80% of full scale, peak-hold marker with a fading TTL bar. */
function drawBoostGaugeView(ctx, top) {
  var area = gH - top;
  var maxB = boostMaxBar();
  var cur = currentBoost();
  var cx = gW / 2;
  var cy = top + Math.round(area * 0.78);
  var R = Math.min(Math.round(area * 0.62), Math.round(gW * 0.30));

  // background plate
  ctx.fillStyle(c("surface"));
  ctx.fillRoundRect(cx - R - 40, top + 8, 2 * R + 80, area - 16, 14);

  var a0 = Math.PI, a1 = Math.PI * 2;   // left horizontal -> right horizontal
  function angleFor(val) {
    var f = Math.max(0, Math.min(1, val / maxB));
    return a0 + (a1 - a0) * f;
  }

  // base arc
  ctx.strokeStyle(c("divider") || c("textTertiary"));
  ctx.lineWidth = Math.max(6, R * 0.09);
  ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();

  // green section up to 60%, red section 80..100%
  ctx.strokeStyle(COL_GAUGE_OK);
  ctx.beginPath(); ctx.arc(cx, cy, R, angleFor(0), angleFor(maxB * 0.6)); ctx.stroke();
  ctx.strokeStyle(COL_GAUGE_REDLINE);
  ctx.beginPath(); ctx.arc(cx, cy, R, angleFor(maxB * 0.8), angleFor(maxB)); ctx.stroke();

  // ticks + numbers every 0.5 bar
  ctx.font = Math.round(R * 0.11) + "px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  var nTicks = Math.round(maxB / 0.5);
  for (var i = 0; i <= nTicks; i++) {
    var tv = i * 0.5;
    var ta = angleFor(tv);
    var major = (tv % 1 === 0);
    var rIn = R - (major ? R * 0.16 : R * 0.09);
    ctx.strokeStyle(major ? c("textSecondary") : c("textTertiary"));
    ctx.lineWidth = major ? 3 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + R * Math.cos(ta), cy + R * Math.sin(ta));
    ctx.lineTo(cx + rIn * Math.cos(ta), cy + rIn * Math.sin(ta));
    ctx.stroke();
    if (major) {
      ctx.fillStyle(c("textSecondary"));
      ctx.fillText(tv.toFixed(0), cx + (R * 0.78) * Math.cos(ta), cy + (R * 0.78) * Math.sin(ta));
    }
  }

  // needle
  var nv = num(cur) ? Math.max(0, cur) : 0;
  var na = angleFor(nv);
  ctx.strokeStyle(c("textPrimary"));
  ctx.lineWidth = Math.max(3, R * 0.035);
  ctx.beginPath();
  ctx.moveTo(cx - R * 0.08 * Math.cos(na), cy - R * 0.08 * Math.sin(na));
  ctx.lineTo(cx + R * 0.92 * Math.cos(na), cy + R * 0.92 * Math.sin(na));
  ctx.stroke();
  ctx.fillStyle(c("accent"));
  ctx.fillCircle && ctx.fillCircle(cx, cy, Math.max(5, R * 0.05));

  // digital readout under the hub
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.font = "bold " + Math.round(R * 0.24) + "px sans-serif";
  ctx.fillStyle(num(cur) ? (cur > maxB * 0.8 ? COL_GAUGE_REDLINE : c("textPrimary")) : c("textTertiary"));
  var uTxt = showUnits() ? " " + tr("u_bar") : "";
  ctx.fillText((num(cur) ? cur.toFixed(2) : "--") + uTxt, cx, cy + R * 0.10);
  ctx.font = Math.round(R * 0.10) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  ctx.fillText(tr("t_boost"), cx, cy + R * 0.34);

  // peak hold: big number on the left, RESET button on the right
  var sy = top + Math.round(area * 0.06);
  var colW = Math.round(gW * 0.16);
  drawStat(ctx, cx - R - 20, sy, colW, Math.round(area * 0.20),
    tr("g_peak") + ", " + tr("u_bar"),
    num(boostGauge.peak) ? boostGauge.peak.toFixed(2) : "--", COL_GAUGE_REDLINE);
  profileState.rects = [];   // reset per-frame button registry
  logState.gaugeResetRect = drawButton(ctx, cx + R - colW, sy + Math.round(area * 0.02),
    colW, Math.round(area * 0.16), tr("g_resetPeak"), c("background"), c("textSecondary"), 0.30);

  // peak TTL bar (visual countdown until the hold decays)
  if (num(boostGauge.peak)) {
    var ttl = BOOST_PEAK_HOLD_MS;
    var left = Math.max(0, ttl - (Date.now() - boostGauge.peakAt));
    var frac = left / ttl;
    ctx.fillStyle(c("background"));
    ctx.fillRect(cx - R - 20, sy + Math.round(area * 0.19), colW, 4);
    ctx.fillStyle(COL_GAUGE_REDLINE);
    ctx.fillRect(cx - R - 20, sy + Math.round(area * 0.19), Math.round(colW * frac), 4);
  }
}

/* peak tracking for the gauge, called from the sampler tick */
function boostGaugeStep() {
  var now = Date.now();
  var b = currentBoost();
  if (num(b) && (!num(boostGauge.peak) || b > boostGauge.peak)) {
    boostGauge.peak = b; boostGauge.peakAt = now;
  }
  if (num(boostGauge.peak) && now - boostGauge.peakAt > BOOST_PEAK_HOLD_MS) {
    boostGauge.peak = null;
  }
}

/* ---- LOGGING -------------------------------------------------------- */

/* CSV header; column order mirrors LOG_CSV_COLS */
var LOG_CSV_COLS = ["t_iso", "rpm", "speed_kmh", "boost_bar", "oilPress_bar",
                    "lambda", "oilTemp_c", "coolant_c", "egt_c", "iat_c",
                    "rail_act_bar", "ignAdv_deg", "knockRet_deg", "voltage_v",
                    "altLoad_pct", "tcLock_pct", "knock_ev", "misfire_ev"];

function logRowSample() {
  var d = new Date();
  return {
    t: d.getTime(),
    t_iso: d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
           " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()),
    rpm: v.rpm, speed_kmh: lapSpeedKmh(), boost_bar: currentBoost(),
    oilPress_bar: valueFor("oilPress"), lambda: currentLambda(),
    oilTemp_c: v.oilTemp, coolant_c: v.coolant, egt_c: valueFor("egt"), iat_c: valueFor("iat"),
    rail_act_bar: fuelPressureActual(), ignAdv_deg: isFresh("ignAdv") ? v.ignAdv : null,
    knockRet_deg: isFresh("knockRetard") ? v.knockRetard : null,
    voltage_v: valueFor("voltage"), altLoad_pct: alternatorLoadPct(),
    tcLock_pct: tcaseLockPct(), knock_ev: counters.knock, misfire_ev: counters.misfireCount
  };
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

function logEvent(kind, text) {
  logState.events.push({ t: Date.now(), kind: kind, text: text });
  while (logState.events.length > LOG_EVENTS_CAP) logState.events.shift();
}

function loggingStep() {
  if (!logState.active) return;
  var iv = Math.max(500, gSettings.logMs || 1000);
  var now = Date.now();
  if (!logState.lastRowAt) logState.lastRowAt = now;
  if (now - logState.lastRowAt >= iv) {
    logState.lastRowAt = now;
    logState.rows.push(logRowSample());
    logState.rowCount++;
    while (logState.rows.length > LOG_ROWS_CAP) logState.rows.shift();
  }
}

function buildCsv() {
  var lines = [LOG_CSV_COLS.join(",")];
  for (var i = 0; i < logState.rows.length; i++) {
    var r = logState.rows[i], cells = [];
    for (var k = 0; k < LOG_CSV_COLS.length; k++) {
      var val = r[LOG_CSV_COLS[k]];
      cells.push(num(val) ? String(val) : "");
    }
    lines.push(cells.join(","));
  }
  return lines.join("\r\n");
}

/* Wi-Fi export: hand the CSV to the head-unit connectivity service, which
 * serves it over HTTP so the phone can download it straight from the
 * browser. The module name/API differs per firmware; we try the known
 * shapes and report honestly when none is available. */
function getHttpModule() {
  var names = ["http", "connectivity", "net"];
  for (var i = 0; i < names.length; i++) {
    try {
      var m = require(names[i]);
      if (m && (m.serveFile || m.createServer || m.publishFile)) return { mod: m, name: names[i] };
    } catch (e) { /* module not present on this firmware */ }
  }
  return null;
}

function wifiIpOf(mod) {
  try {
    if (mod.getWifiIp) return mod.getWifiIp();
    if (mod.wifi && mod.wifi.ip) return mod.wifi.ip();
    if (mod.ip) return typeof mod.ip === "function" ? mod.ip() : mod.ip;
  } catch (e) { /* ignore */ }
  return null;
}

function startWifiExport() {
  if (!logState.rows.length) {
    logState.exportMsg = tr("lg_noData");
    return;
  }
  var h = getHttpModule();
  var csv = buildCsv();
  var fname = "mvitals_" + Date.now() + ".csv";
  if (h && h.mod.serveFile) {
    try {
      var ip = wifiIpOf(h.mod);
      h.mod.serveFile(fname, "text/csv", csv, function (url) {
        logState.exporting = false;
        logState.exportMsg = url ? (String(url) + "  \u00b7  " + logState.rows.length + " \u2192 CSV")
                                 : tr("lg_exportStart");
        logEvent("export", fname + " served via " + h.name);
      });
      logState.exporting = true;
      logState.exportMsg = tr("lg_exportStart") + (ip ? "  http://" + ip : "");
      return;
    } catch (e) {
      logState.exportMsg = "EXPORT FAILED: " + String(e && e.message || e);
      return;
    }
  }
  // no serving API on this firmware — say so instead of pretending
  logState.exportMsg = "NO HTTP SERVICE IN THIS BUILD";
  logEvent("export", "unavailable: " + (h ? h.name + " lacks serveFile" : "no http/connectivity/net module"));
}

function drawLoggingView(ctx, top) {
  var area = gH - top;
  var padX = Math.round(gW * 0.03);
  var rowH = Math.round(area * 0.17);
  var y = top + Math.round(area * 0.04);

  // status line + buttons row
  var st = logState.active ? tr("lg_on") : tr("lg_idle");
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.font = "bold " + Math.round(rowH * 0.42) + "px sans-serif";
  ctx.fillStyle(logState.active ? c("alert") : c("textSecondary"));
  ctx.fillText((logState.active ? "\u25cf " : "\u25cb ") + st, padX, y + rowH / 2);

  ctx.font = Math.round(rowH * 0.34) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  var info = tr("lg_rows") + ": " + logState.rowCount +
             "  \u00b7  " + tr("lg_events") + ": " + logState.events.length;
  ctx.fillText(info, padX + Math.round(gW * 0.24), y + rowH / 2);

  var bw = Math.round(gW * 0.17), gap = Math.round(gW * 0.015);
  logState.btnRect = drawButton(ctx, gW - padX - bw * 3 - gap * 2, y, bw, rowH,
    logState.active ? tr("lg_stop") : tr("lg_rec"),
    logState.active ? c("alert") : c("success"), "#ffffff", 0.34);
  logState.wifiBtnRect = drawButton(ctx, gW - padX - bw * 2 - gap, y, bw, rowH,
    tr("lg_wifi"), c("background"), c("accent"), 0.30);
  logState.clearBtnRect = drawButton(ctx, gW - padX - bw, y, bw, rowH,
    tr("lg_clear"), c("background"), c("textSecondary"), 0.30);

  // export status line
  y += rowH + Math.round(area * 0.02);
  ctx.textAlign = "left";
  ctx.font = Math.round(rowH * 0.32) + "px sans-serif";
  ctx.fillStyle(logState.exporting ? c("warning") : c("textTertiary"));
  if (logState.exportMsg) ctx.fillText(logState.exportMsg, padX, y + Math.round(rowH * 0.2));

  // event feed panel (fills the rest)
  var py = y + Math.round(rowH * 0.5);
  ctx.fillStyle(c("surface"));
  ctx.fillRoundRect(padX, py, gW - 2 * padX, area - (py - top) - Math.round(area * 0.03), 12);
  ctx.font = Math.round(area * 0.055) + "px sans-serif";
  ctx.textBaseline = "top";
  var lineH = Math.round(area * 0.085);
  var maxLines = Math.floor((area - (py - top) - Math.round(area * 0.05)) / lineH);
  var evs = logState.events.slice(-maxLines);
  for (var i = 0; i < evs.length; i++) {
    var e = evs[i];
    var d = new Date(e.t);
    ctx.fillStyle(c("textTertiary"));
    ctx.textAlign = "left";
    ctx.fillText(pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()),
      padX + 14, py + 10 + i * lineH);
    ctx.fillStyle = undefined;   // (recorder-safe: always set below)
    ctx.fillStyle(e.kind === "lap" ? c("accent") : e.kind === "knock" ? c("alert") : c("textSecondary"));
    ctx.fillText(e.text, padX + Math.round(gW * 0.08), py + 10 + i * lineH);
  }
  if (!evs.length) {
    ctx.fillStyle(c("textTertiary"));
    ctx.textAlign = "center";
    ctx.fillText("LOG EMPTY - PRESS " + tr("lg_rec"), gW / 2, py + Math.round(area * 0.2));
  }
}

/* ---- GEAR CORRECTIONS ("коррекции по коробке") --------------------- */

var gearCorrRects = [];      // hit-test rects registered during drawing

function drawGearCorrView(ctx, top) {
  gearCorrRects = [];
  var area = gH - top;
  var padX = Math.round(gW * 0.03);
  var statsH = Math.round(area * 0.24);
  var cw = Math.floor((gW - 2 * padX) / 3);
  var sy = top + Math.round(statsH * 0.06);

  // three headline stats: total corrections, max dip (bar), max duration (ms)
  drawStat(ctx, padX, sy, cw, statsH, tr("gc_total"),
    String(gearCorr.totalEvents), c("textPrimary"));
  drawStat(ctx, padX + cw, sy, cw, statsH, tr("gc_maxDip"),
    num(gearCorr.maxDipBar) ? gearCorr.maxDipBar.toFixed(2) : "--", COL_GAUGE_REDLINE);
  drawStat(ctx, padX + 2 * cw, sy, cw, statsH, tr("gc_maxDur"),
    num(gearCorr.maxDurMs) ? String(gearCorr.maxDurMs) : "--", COL_LOCK);

  // live chart: boost + speed over the rolling window
  var chartY = top + statsH;
  var listH = Math.round(area * 0.30);
  var chartH = area - statsH - listH - Math.round(area * 0.14);
  drawLiveChart(ctx, padX, chartY, gW - 2 * padX, chartH, tr("ch_gc"), gearCorr.hist, [
    { key: "boost", color: COL_GAUGE_REDLINE, label: tr("c_boost2"), dp: 1 },
    { key: "speed", color: COL_NM, label: tr("c_speed2"), dp: 0 }
  ], { convert: function () { return arguments[0]; } });

  // last events list (newest first): time, gear, dip bar, duration ms
  var ly = chartY + chartH + Math.round(area * 0.02);
  ctx.fillStyle(c("surface"));
  ctx.fillRoundRect(padX + 4, ly, gW - 2 * padX - 8, listH, 12);
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.font = Math.round(listH * 0.13) + "px sans-serif";
  ctx.fillStyle(c("textSecondary"));
  ctx.fillText(tr("gc_last"), padX + 16, ly + listH * 0.12);
  if (!gearCorr.events.length) {
    ctx.fillStyle(c("textTertiary"));
    ctx.fillText(tr("gc_none"), padX + 16, ly + listH * 0.55);
  } else {
    var rows = Math.min(4, gearCorr.events.length);
    for (var i = 0; i < rows; i++) {
      var ev = gearCorr.events[i];
      var d = new Date(ev.t);
      var hh = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) +
               ":" + ("0" + d.getSeconds()).slice(-2);
      var line = hh + "   " + tr("gc_gear") + " " + (ev.gear === null ? "-" : ev.gear) +
                 "   " + ev.dipBar.toFixed(2) + " bar   " + ev.durMs + " ms";
      ctx.fillStyle(i === 0 ? c("textPrimary") : c("textSecondary"));
      ctx.fillText(line, padX + 16, ly + listH * (0.30 + 0.17 * i));
    }
  }

  // RESET button bottom-right
  var bw = Math.round(gW * 0.16), bh = Math.round(area * 0.10);
  gearCorrRects.push({ action: "reset", rect: drawButton(ctx, gW - padX - bw, ly + listH + Math.round(area * 0.015),
    bw, bh, tr("gc_reset"), c("background"), c("textSecondary"), 0.34) });
}

/* ---- PROFILES ------------------------------------------------------- */

function profileKeyOf(name) { return "profile_" + name; }

function loadProfileNames(cb) {
  settingsStore.loadAll(function (s) {
    var names = [];
    s = s || {};
    for (var k in s) {
      if (Object.prototype.hasOwnProperty.call(s, k) && /^profile_/.test(k)) {
        names.push(String(k).substr("profile_".length));
      }
    }
    names.sort();
    cb(names);
  });
}

function profileCycleName() {
  // next free default name: Track, Daily, Drag, Winter...
  var bases = ["TRACK", "DAILY", "DRAG", "WINTER", "SPORT", "TEST"];
  for (var i = 0; i < bases.length; i++) {
    if (profileState.names.indexOf(bases[i]) < 0) return bases[i];
  }
  return "P" + (profileState.names.length + 1);
}

function saveCurrentProfile(name) {
  if (profileState.names.indexOf(name) >= 0) {
    profileMsg(tr("pr_exists"));
    return;
  }
  var snap = {};
  for (var i = 0; i < PROFILE_KEYS.length; i++) {
    var pk = PROFILE_KEYS[i];
    snap[pk] = (gSettings[pk] !== undefined) ? gSettings[pk] : DEFAULT_SETTINGS[pk];
  }
  settingsStore.set(profileKeyOf(name), JSON.stringify(snap));
  settingsStore.set("profile", name);
  gSettings.profile = name;
  profileState.names.push(name);
  profileState.names.sort();
  profileMsg(tr("pr_saved") + ": " + name);
  logEvent("profile", "saved " + name);
}

function applyProfile(name) {
  var raw = gSettings[profileKeyOf(name)];
  if (typeof raw !== "string") {
    // first load after boot may not have it in the cached map yet
    settingsStore.loadAll(function (s) {
      var r2 = s && s[profileKeyOf(name)];
      if (typeof r2 === "string") applyProfileMap(name, r2);
      else profileMsg(name + "?");
    });
    return;
  }
  applyProfileMap(name, raw);
}

function applyProfileMap(name, raw) {
  var snap;
  try { snap = JSON.parse(raw); } catch (e) { profileMsg("CORRUPT PROFILE"); return; }
  for (var i = 0; i < PROFILE_KEYS.length; i++) {
    var k = PROFILE_KEYS[i];
    if (snap[k] !== undefined) {
      gSettings[k] = snap[k];
      settingsStore.set(k, snap[k]);
    }
  }
  gSettings.profile = name;
  settingsStore.set("profile", name);
  profileMsg(tr("pr_loaded") + ": " + name);
  logEvent("profile", "loaded " + name);
  restartTimersForSettings();
}

function deleteProfile(name) {
  settingsStore.remove(profileKeyOf(name));
  var ix = profileState.names.indexOf(name);
  if (ix >= 0) profileState.names.splice(ix, 1);
  if (gSettings.profile === name) {
    delete gSettings.profile;
    settingsStore.remove("profile");
  }
  profileMsg(tr("pr_deleted") + ": " + name);
  logEvent("profile", "deleted " + name);
}

function profileMsg(txt) {
  profileState.msg = txt;
  profileState.msgAt = Date.now();
}

function drawProfilesView(ctx, top) {
  var area = gH - top;
  var padX = Math.round(gW * 0.03);
  var btnH = Math.round(area * 0.13);
  var y = top + Math.round(area * 0.05);
  profileState.rects = [];

  // active profile header
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.font = "bold " + Math.round(btnH * 0.5) + "px sans-serif";
  ctx.fillStyle(c("textPrimary"));
  var act = gSettings.profile || "DEFAULT";
  ctx.fillText(tr("pr_active") + ": " + act, padX, y + btnH / 2);

  // SAVE CURRENT AS button (right side of the header row)
  var bw = Math.round(gW * 0.28);
  profileState.rects.push({
    rect: drawButton(ctx, gW - padX - bw, y, bw, btnH,
      tr("pr_save") + " \u00b7 " + profileCycleName(), c("accent"), "#ffffff", 0.32),
    action: "save", arg: profileCycleName()
  });

  y += btnH + Math.round(area * 0.04);

  // profile list
  if (!profileState.names.length) {
    ctx.font = Math.round(btnH * 0.45) + "px sans-serif";
    ctx.fillStyle(c("textTertiary"));
    ctx.textAlign = "center";
    ctx.fillText(tr("pr_none"), gW / 2, y + btnH / 2);
  }
  var rowGap = Math.round(area * 0.02);
  var nameW = Math.round(gW * 0.30);
  var smallW = Math.round(gW * 0.16);
  for (var i = 0; i < profileState.names.length; i++) {
    var nm = profileState.names[i];
    var isActive = gSettings.profile === nm;
    ctx.fillStyle(c("surface"));
    ctx.fillRoundRect(padX, y, gW - 2 * padX, btnH, 10);
    ctx.textAlign = "left";
    ctx.font = "bold " + Math.round(btnH * 0.42) + "px sans-serif";
    ctx.fillStyle(isActive ? c("accent") : c("textPrimary"));
    ctx.fillText((isActive ? "\u25cf " : "") + nm, padX + 16, y + btnH / 2);
    if (isActive) {
      ctx.font = Math.round(btnH * 0.3) + "px sans-serif";
      ctx.fillStyle(c("textTertiary"));
      ctx.fillText(tr("pr_active"), padX + 16 + ctx.measureText(nm).width * 2.2, y + btnH / 2);
    }
    profileState.rects.push({
      rect: drawButton(ctx, gW - padX - smallW * 2 - 12, y + 4, smallW, btnH - 8,
        tr("pr_load"), c("background"), c("accent"), 0.36),
      action: "load", arg: nm
    });
    profileState.rects.push({
      rect: drawButton(ctx, gW - padX - smallW, y + 4, smallW, btnH - 8,
        tr("pr_del"), c("background"), c("alert"), 0.36),
      action: "del", arg: nm
    });
    y += btnH + rowGap;
  }

  // feedback message (fades out after 4 s)
  if (profileState.msg && Date.now() - profileState.msgAt < 4000) {
    ctx.textAlign = "center";
    ctx.font = "bold " + Math.round(btnH * 0.4) + "px sans-serif";
    ctx.fillStyle(c("success"));
    ctx.fillText(profileState.msg, gW / 2, y + btnH / 2);
  }
}

/* ------------------------------------------------------------------ */
/* SETTINGS tab: cycle-through rows (language, units, demo, poll rate)  */
/* ------------------------------------------------------------------ */

var SETTINGS_ROWS = [
  { key: "language",    labelKey: "s_language",   values: ["en", "ru"],          valKeys: ["v_en", "v_ru"] },
  { key: "unitsTemp",   labelKey: "s_unitsTemp",  values: ["C", "F"],            valKeys: ["v_celsius", "v_fahrenheit"] },
  { key: "speedUnits",  labelKey: "s_unitsSpeed", values: ["kmh", "mph"],        valKeys: ["v_kmh", "v_mph"] },
  { key: "showUnits",   labelKey: "s_showUnits",  values: [false, true],         valKeys: ["v_off", "v_on"] },
  { key: "peakResetMs", labelKey: "s_peakReset",  values: [3000, 6000, 10000, 30000],
    format: function (val) { return String(Math.round(val / 1000)) + " s"; } },
  { key: "boostSource", labelKey: "s_boostSource", values: ["auto", "dme", "fes"], valKeys: ["v_auto", "v_auto", "v_auto"],
    format: function (val) { return String(val).toUpperCase(); } },
  { key: "demo",        labelKey: "s_demo",       values: ["auto", "on", "off"], valKeys: ["v_auto", "v_on", "v_off"] },
  { key: "pollMs",      labelKey: "s_pollRate",   values: [500, 1000, 2000],
    format: function (val) { return String(val) + " ms"; } }
];

var settingsState = { rects: [] };   // hit-test rects of the value buttons

function settingValue(row) {
  var cur = gSettings[row.key];
  if (cur === undefined && DEFAULT_SETTINGS[row.key] !== undefined) cur = DEFAULT_SETTINGS[row.key];
  var ix = row.values.indexOf(cur);
  return ix < 0 ? 0 : ix;
}

function settingText(row) {
  var ix = settingValue(row);
  if (row.format) return row.format(row.values[ix]);
  return tr(row.valKeys[ix]);
}

function drawSettingsTab(ctx, top) {
  var area = gH - top;
  var padX = Math.round(gW * 0.18);
  var rowH = Math.min(Math.round(area / (SETTINGS_ROWS.length + 1)), Math.round(gH * 0.10));
  var y = top + Math.round((area - rowH * SETTINGS_ROWS.length) / 2);
  var valW = Math.round(gW * 0.22);
  settingsState.rects = [];

  ctx.textBaseline = "middle";
  for (var i = 0; i < SETTINGS_ROWS.length; i++) {
    var row = SETTINGS_ROWS[i];
    var cy = y + i * rowH;
    // zebra background for readability
    if (i % 2 === 0) {
      ctx.fillStyle(c("surface"));
      ctx.fillRoundRect(padX - 14, cy, gW - 2 * padX + 28, rowH - 4, 8);
    }
    ctx.textAlign = "left";
    ctx.font = Math.round(rowH * 0.4) + "px sans-serif";
    ctx.fillStyle(c("textPrimary"));
    ctx.fillText(tr(row.labelKey), padX, cy + rowH / 2);
    settingsState.rects.push({
      rect: drawButton(ctx, gW - padX - valW, cy + 3, valW, rowH - 10,
        "<  " + settingText(row) + "  >", c("background"), c("accent"), 0.36),
      action: "cycle", arg: row.key
    });
  }

  // footer hint
  ctx.textAlign = "center";
  ctx.font = Math.round(rowH * 0.32) + "px sans-serif";
  ctx.fillStyle(c("textTertiary"));
  ctx.fillText(tr("s_hint"), gW / 2, y + SETTINGS_ROWS.length * rowH + rowH * 0.5);
}

/* Tap a value button -> move to the next allowed value, persist, re-arm. */
function cycleSetting(key) {
  var row = null;
  for (var i = 0; i < SETTINGS_ROWS.length; i++) if (SETTINGS_ROWS[i].key === key) row = SETTINGS_ROWS[i];
  if (!row) return;
  var ix = (settingValue(row) + 1) % row.values.length;
  var val = row.values[ix];
  gSettings[key] = val;
  settingsStore.set(key, val);
  restartTimersForSettings();   // language/units repaint at once; poll/demo re-arm
}

/* MORE dispatcher */
function drawMoreTab(ctx, top) {
  var mTop = top + drawMoreTabs(ctx, top);
  if (gMoreTab === "boost") drawBoostGaugeView(ctx, mTop);
  else if (gMoreTab === "logs") drawLoggingView(ctx, mTop);
  else drawProfilesView(ctx, mTop);
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
var COL_LOCK = "#f0a030"; // transfer-case lock-up % (amber)

function lapHistMax(key, cv) {
  var m = null;
  for (var i = 0; i < lap.hist.length; i++) {
    var val = cv ? cv(lap.hist[i][key]) : lap.hist[i][key];
    if (num(val) && (m === null || val > m)) m = val;
  }
  return m;
}

function lapHistMin(key, cv) {
  var m = null;
  for (var i = 0; i < lap.hist.length; i++) {
    var val = cv ? cv(lap.hist[i][key]) : lap.hist[i][key];
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
  var cv = opts.convert || function (vv) { return vv; };
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
      var val = cv(lap.hist[j][key]);
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
      var pv = cv(pt[se.key]);
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
  boostGaugeStep();
  loggingStep();
  var ctx = gCanvas.getContext("2d");
  ctx.fillStyle(c("background"));
  ctx.fillRect(0, 0, gW, gH);

  var top = drawTabs(ctx);
  if (gActiveTab === "main") drawMain(ctx, top);
  else if (gActiveTab === "power") drawPower(ctx, top);
  else if (gActiveTab === "hpfp") drawHpfpTab(ctx, top);
  else if (gActiveTab === "ign") drawIgnTab(ctx, top);
  else if (gActiveTab === "fuelcool") drawFuelCoolTab(ctx, top);
  else if (gActiveTab === "elec") drawElecTab(ctx, top);
  else if (gActiveTab === "tcase") drawTcaseTab(ctx, top);
  else if (gActiveTab === "lap") {
    if (gLapView === "detail" && lap.state === "done") drawLapDetails(ctx, top);
    else drawLap(ctx, top);
  }
  else if (gActiveTab === "more") drawMoreTab(ctx, top);
  else if (gActiveTab === "settings") drawSettingsTab(ctx, top);
}

/* tabs that redraw at the fast (chart/stopwatch) cadence */
function isFastTab() {
  return gActiveTab === "power" || gActiveTab === "hpfp" ||
         gActiveTab === "ign" || gActiveTab === "lap" || gActiveTab === "tcase" ||
         gActiveTab === "more" || gActiveTab === "settings";
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
                    "gearbox", "voltage", "fuelPresAct", "fuelPresReq", "ignAdv",
                    "fuelTemp", "thermoPos", "fanRpm", "radTemp",
                    "battCurrent", "aluIst", "aluTemp", "tcClutchRaw"];

/* metrics that are NOT polled from the DME (no trustworthy UDS source yet):
 * they stay null and render as "--" until wired up. */
var NO_SOURCE_METRICS = ["oilQuality", "oilLevel"];

/* value keys that storeMetric stamps; derived getters use isFresh on these */
var METRIC_VKEY = { fanRpm: "fanRpm", battCurrent: "battCurrent",
                    aluIst: "aluIst", aluTemp: "aluTemp",
                    tcClutchRaw: "tcClutchRaw", tcTemp: "tcTemp" };

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
    var vkey = METRIC_VKEY[metric] || metric;   // tcClutchRaw etc. store under a mapped key
    if (storeMetric(vkey, val, cand)) {
      gResolved[metric] = cand;
      afterStore(metric, val);
      if (metric === "fanRpm" && cand && cand.duty) v.fanDuty = val;
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

  // FUEL/COOL tab: fuel temp follows intake with a lag; thermostat opens as
  // coolant climbs; fan ramps above ~100C; radiator outlet sits below coolant
  set("fuelTemp", 18 + load * 24 + (v.iat - 28) * 0.5);
  var cly = v.coolant;
  set("thermoPos", Math.max(0, Math.min(100, (cly - 92) * 8 + 10 * Math.max(0, Math.sin(t * 0.15)))));
  set("fanRpm", cly > 99 ? Math.round((cly - 99) * 220 + 400 * Math.abs(Math.sin(t * 0.7))) : 0);
  set("radTemp", cly - 6 - load * 4);
  // oilQuality / oilLevel: no simulated source either -> stay "--" on purpose

  // ELECTRIC tab (borтовaya set'): IBS current follows voltage/regime,
  // alternator actual load ALU_IST ~ idle 25A + load*100A, regulator temp
  var ibs = 30 + load * 90 + 8 * Math.sin(t * 1.3);
  set("battCurrent", ibs);
  set("aluIst", 25 + load * 100 + 6 * Math.sin(t * 0.9));
  set("aluTemp", 62 + load * 38);

  // TCASE tab: lock-up % rises with slip and acceleration demand; simulate a
  // small front-vs-rear wheel speed difference during hard pull phases
  var acc = Math.max(0, (v.speed - (demoPrevSpeed || v.speed)) / 0.35 / 3.6);
  demoPrevSpeed = v.speed;
  set("slipRpm", load > 0.75 ? (load - 0.75) * 260 : 0);
  set("accLong", Math.min(9, acc));
  var lockDemand = Math.min(100, Math.max(0, v.slipRpm) * 0.55 + acc * 14);
  set("tcLockPct", lockDemand);

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
    // hydrate profile names for the PROFILES screen
    loadProfileNames(function (names) { profileState.names = names; });
    startPolling();
    startPowerSampler();
    startDemo();
  });
}

/* Re-arm all timers after a settings change (profile load, SETTINGS tab).
 * Poll rate, demo mode and UI refresh can all shift, so tear everything
 * down and start fresh instead of patching individual intervals. */
function restartTimersForSettings() {
  startPolling();          // reads gSettings.pollMs itself and stops the old one
  startPowerSampler();     // same pattern for the 100 ms sampler
  startDemo();             // demo on/off may have flipped in the profile
  if (gTimer) clearInterval(gTimer);
  gTimer = setInterval(render, isFastTab() ? POWER_REFRESH_MS : REFRESH_MS);
  render();
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
      return;
    }
    /* MORE tab ("Дополнительно"): second-level strip, BACK button and the
     * per-screen buttons (REC/WIFI/CLEAR, gauge RESET, profile SAVE/LOAD/DEL) */
    if (gActiveTab === "more") {
      var mTop = tabH;
      var mTh = Math.round(gH * 0.075);
      if (y >= mTop && y <= mTop + mTh) {
        if (inRect(gMoreBackRect, x, y)) {
          gActiveTab = "main";            // BACK leaves the MORE section
          if (gTimer) {
            clearInterval(gTimer);
            gTimer = setInterval(render, isFastTab() ? POWER_REFRESH_MS : REFRESH_MS);
          }
          render();
          return;
        }
        var mw = Math.floor(gW / MORE_TABS.length);
        var mi = Math.min(MORE_TABS.length - 1, Math.floor(x / mw));
        gMoreTab = MORE_TABS[mi].id;
        render();
        return;
      }
      if (gMoreTab === "boost") {
        if (inRect(logState.gaugeResetRect, x, y)) {
          boostGauge.peak = null;         // manual peak-hold reset
          render();
        }
        return;
      }
      if (gMoreTab === "logs") {
        if (inRect(logState.btnRect, x, y)) {
          logState.active = !logState.active;
          if (logState.active) {
            logState.lastRowAt = 0;
            logEvent("log", "REC armed @" + Math.max(500, gSettings.logMs || 1000) + "ms");
          } else {
            logEvent("log", "REC stopped, " + logState.rowCount + " rows");
          }
          render();
          return;
        }
        if (inRect(logState.wifiBtnRect, x, y)) {
          startWifiExport();
          render();
          return;
        }
        if (inRect(logState.clearBtnRect, x, y)) {
          logState.rows = [];
          logState.events = [];
          logState.rowCount = 0;
          logState.exportMsg = null;
          render();
          return;
        }
        return;
      }
      if (gMoreTab === "profiles") {
        var rs = profileState.rects;
        for (var ri = 0; ri < rs.length; ri++) {
          if (inRect(rs[ri].rect, x, y)) {
            var a = rs[ri].action, arg = rs[ri].arg;
            if (a === "save") saveCurrentProfile(arg);
            else if (a === "load") applyProfile(arg);
            else if (a === "del") deleteProfile(arg);
            render();
            return;
          }
        }
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
