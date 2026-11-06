#!/usr/bin/env node
/*
 * extract_sdk.js - pull the OAP SDK (BMW proprietary runtime modules) out of
 * a donor official app so local builds/emulation can run against it.
 *
 * Usage:
 *   node kit/tools/extract_sdk.js <path-to-app.js> [--out oap-sdk]
 *   node kit/tools/extract_sdk.js x_call/javascript/app.js
 *
 * What it does:
 *   Official OAP apps ship as webpack-style bundles: one big javascript/app.js
 *   containing every module the firmware provides (os, signals, settings,
 *   diagnostic, log, renderd, ...). We parse the bundle's module map and write
 *   each module into ./oap-sdk/<name>.js plus an index.json manifest.
 *
 * LEGAL: the extracted SDK is BMW copyrighted code. Keep it private; never
 * commit it to a public repo (see .gitignore). Only your own built .mgu for
 * your own car may contain it.
 */
"use strict";
var fs = require("fs");
var path = require("path");

var KNOWN_MODULES = [
  "os", "signals", "settings", "diagnostic", "log", "renderd",
  "touchhandler", "store", "vehicleinfo", "connectivity", "net", "http"
];

function die(msg) { console.error("extract_sdk: " + msg); process.exit(1); }

var argv = process.argv.slice(2);
if (!argv.length) die("usage: node extract_sdk.js <app.js> [--out DIR]");
var input = argv[0];
var outIdx = argv.indexOf("--out");
var outDir = outIdx >= 0 ? argv[outIdx + 1] : "oap-sdk";

if (!fs.existsSync(input)) die("not found: " + input);
var src = fs.readFileSync(input, "utf8");
console.log("input:", input, "(" + src.length + " bytes)");

/* The bundle registers modules either as
 *     ___OAP_MODULE_<name>___ : function(module,exports,require){...}
 * or (webpack numeric ids) with a string-keyed map like
 *     "signals": function(module, exports, __webpack_require__) {...}
 * We find top-level quoted keys whose value is a function(...) block and
 * slice balanced braces to recover the source text.
 */
var modulesFound = {};

function sliceBalanced(str, openIdx) {
  // str[openIdx] must be '{'; returns [body, endIdxAfterClose]
  var depth = 0, i = openIdx, inStr = null, esc = false;
  for (; i < str.length; i++) {
    var c = str[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "/" && str[i + 1] === "/") { i = str.indexOf("\n", i); if (i < 0) return [null, str.length]; continue; }
    if (c === "/" && str[i + 1] === "*") { i = str.indexOf("*/", i) + 1; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return [str.slice(openIdx + 1, i), i + 1]; }
  }
  return [null, str.length];
}

// Pattern A: explicit OAP marker style used by idrive7 tooling
var reA = /["']([a-zA-Z][\w\-\.]*)["']\s*:\s*function\s*\(\s*[\w$]+\s*,\s*[\w$]+\s*,\s*[\w$]+\s*\)\s*\{/g;
var m;
while ((m = reA.exec(src))) {
  var name = m[1];
  var braceIdx = src.indexOf("{", reA.lastIndex - 1);
  var body = sliceBalanced(src, braceIdx);
  if (body[0] !== null) {
    if (!modulesFound[name]) modulesFound[name] = body[0];
    reA.lastIndex = body[1];
  }
}

var names = Object.keys(modulesFound);
if (!names.length) {
  console.warn("extract_sdk: no string-keyed module map found.");
  console.warn("Fallback: writing the raw bundle as sdk/app.raw.js - inspect it manually.");
  fs.mkdirSync(path.join(outDir, "sdk"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "sdk", "app.raw.js"), src);
}

// keep only known HU modules + anything that looks like de.bmw.* namespace
var keep = {};
names.forEach(function (n) {
  if (KNOWN_MODULES.indexOf(n.split("/").pop()) >= 0 || /^de\.bmw|^oap|^mgu/.test(n)) keep[n] = modulesFound[n];
});
var keptNames = Object.keys(keep);
if (!keptNames.length && names.length) {
  console.warn("extract_sdk: nothing matched the known module list; keeping all " + names.length + " modules.");
  keep = modulesFound; keptNames = names;
}

fs.mkdirSync(path.join(outDir, "sdk"), { recursive: true });
keptNames.forEach(function (n) {
  var safe = n.replace(/[\/\\]/g, "__");
  var file = path.join(outDir, "sdk", safe + ".js");
  // wrap as a callable CommonJS factory: sdk loader calls factory(module,exports,require)
  fs.writeFileSync(file,
    "// extracted from " + path.basename(input) + " - module '" + n + "'\n" +
    "// BMW proprietary code - DO NOT PUBLISH\n" +
    "module.exports = function (module, exports, require) {\n" + keep[n] + "\n};\n");
});
fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify({
  source: path.basename(input),
  generated: new Date().toISOString(),
  modules: keptNames
}, null, 2));

console.log("OK -> " + outDir + "/sdk (" + keptNames.length + " modules)");
console.log("modules:", keptNames.join(", "));
