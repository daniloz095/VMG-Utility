#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py - pack an OAP/MGU application into a .mgu installable package.

.mgu format (same layout as preinstalled_apps/*.tgz on the HU):
    <app_id>@<version>.mgu  ==  tar.gz containing, at archive root:
        app.json              manifest (from apps/<id>/app.json)
        javascript/app.js     browserified CommonJS bundle of main.js
        assets/*              optional static files (fonts/images), if present

Usage:
    python3 kit/tools/build.py <app_id> [--sdk DIR] [--node BIN] [--out DIR]

The bundle is produced with browserify and must be run under Node 8 for the
exact runtime match; newer Node also works for bundling in practice. If
browserify is not installed globally, a local copy is bootstrapped into
kit/tools/.node-deps automatically.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
ROOT = os.path.dirname(KIT)
DEPS = os.path.join(HERE, ".node-deps")


def die(msg):
    sys.stderr.write("build.py: %s\n" % msg)
    sys.exit(1)


def read_manifest(app_dir):
    p = os.path.join(app_dir, "app.json")
    if not os.path.isfile(p):
        die("missing %s" % p)
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def ensure_browserify():
    """Return the path to browserify's JS CLI entry, bootstrapping locally if
    needed. The entry is always run through `node` (never the `.bin` shell shim)
    so the build works identically on Windows and Linux."""
    cli = os.path.join(DEPS, "node_modules", "browserify", "bin", "cmd.js")
    if os.path.exists(cli):
        return cli
    print("browserify not found - bootstrapping into %s ..." % DEPS)
    os.makedirs(DEPS, exist_ok=True)
    pkg = os.path.join(DEPS, "package.json")
    if not os.path.exists(pkg):
        with open(pkg, "w") as f:
            f.write('{"name":"mgu-build-deps","private":true}\n')
    cmd = (["cmd", "/c", "npm"] if os.name == "nt" else ["npm"]) + \
          ["--yes", "install", "--prefix", DEPS,
           "browserify@17", "--no-audit", "--no-fund"]
    try:
        subprocess.run(cmd, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        die("could not install browserify (%s). Install it manually: npm i -g browserify" % e)
    if not os.path.exists(cli):
        die("browserify bootstrap failed")
    return cli


def find_node():
    for cand in ("node8", "node"):
        p = shutil.which(cand)
        if p:
            return p
    return None


# Modules provided by oap-mainapp on the head unit at runtime. They must NOT
# be bundled; we inject a tiny loader instead (see make_shim_dir).
HU_RUNTIME_MODULES = ["os", "signals", "settings", "diagnostic", "log",
                      "renderd", "touchhandler", "store", "net", "http",
                      "connectivity", "vehicleinfo"]


def make_shim_dir():
    """A NODE_PATH shim package tree: each HU module resolves to a stub that
    returns the live implementation from global.__OAP_REQUIRE__ (installed by
    the prelude below). Dynamic requires like require(names[i]) work too."""
    shim = tempfile.mkdtemp(prefix="mgu-shim-")
    loader = (
        "// resolved at runtime by oap-mainapp\n"
        "module.exports = (global.__OAP_REQUIRE__ || function(){ return {}; })('%s');\n"
    )
    for m in HU_RUNTIME_MODULES:
        d = os.path.join(shim, m)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "index.js"), "w") as f:
            f.write(loader % m)
        with open(os.path.join(d, "package.json"), "w") as f:
            f.write('{"name":"%s","main":"index.js"}\n' % m)
    return shim


PRELUDE = (
    "// bring-in HU runtime modules for CommonJS require() inside the bundle\n"
    "if (!global.__OAP_REQUIRE__) {\n"
    "  global.__OAP_REQUIRE__ = function (name) {\n"
    "    try { return require(name); } catch (e) { return {}; }\n"
    "  };\n"
    "}\n"
)


def bundle(app_dir, browserify_cli, node_bin):
    main_js = os.path.join(app_dir, "main.js")
    if not os.path.isfile(main_js):
        die("missing %s" % main_js)
    outdir = tempfile.mkdtemp(prefix="mgu-bundle-")
    entry = os.path.join(outdir, "entry.js")
    with open(entry, "w") as f:
        f.write(PRELUDE)
        f.write("module.exports = require(%r);\n" % main_js)
    out = os.path.join(outdir, "app.js")
    env = dict(os.environ)
    node = node_bin or find_node() or "node"
    if node_bin:
        d = os.path.dirname(node_bin)
        if d:
            env["PATH"] = d + os.pathsep + env.get("PATH", "")
    shim = make_shim_dir()
    prev = env.get("NODE_PATH")
    env["NODE_PATH"] = shim + ((os.pathsep + prev) if prev else "")
    # Plain browserify (ES5 code, no transpile step required). MGU runtime is
    # Node 8 style CommonJS; browserify produces exactly that. Run the CLI entry
    # through node so it works on Windows (no `.bin` shim) and Linux alike.
    cmd = [node, browserify_cli, "-o", out, entry]
    print("bundling:", " ".join(cmd))
    r = subprocess.run(cmd, env=env)
    shutil.rmtree(shim, ignore_errors=True)
    if r.returncode != 0:
        die("browserify failed (exit %d)" % r.returncode)
    return out


def build(app_id, sdk_dir=None, node_bin=None, out_dir=None):
    app_dir = os.path.join(ROOT, "apps", app_id)
    if not os.path.isdir(app_dir):
        die("app not found: %s" % app_dir)
    manifest = read_manifest(app_dir)
    version = manifest.get("version", "0.0.0")
    out_dir = out_dir or os.path.join(ROOT, "dist")
    os.makedirs(out_dir, exist_ok=True)

    node_bin = node_bin or find_node()
    bfy = ensure_browserify()

    # bundle
    stage = tempfile.mkdtemp(prefix="mgu-stage-")
    bundle_js = bundle(app_dir, bfy, node_bin)

    pkg_root = os.path.join(stage, "pkg")
    js_dir = os.path.join(pkg_root, "javascript")
    os.makedirs(js_dir)
    shutil.copy(bundle_js, os.path.join(js_dir, "app.js"))
    shutil.copy(os.path.join(app_dir, "app.json"), os.path.join(pkg_root, "app.json"))
    assets = os.path.join(app_dir, "assets")
    if os.path.isdir(assets):
        shutil.copytree(assets, os.path.join(pkg_root, "assets"))

    mgu = os.path.join(out_dir, "%s@%s.mgu" % (app_id, version))
    with tarfile.open(mgu, "w:gz") as tf:
        for name in sorted(os.listdir(pkg_root)):
            tf.add(os.path.join(pkg_root, name), arcname=name)
    size = os.path.getsize(mgu)
    print("OK -> %s (%d bytes)" % (mgu, size))
    shutil.rmtree(stage, ignore_errors=True)
    return mgu


def validate(app_id):
    """Cheap sanity checks before packing."""
    app_dir = os.path.join(ROOT, "apps", app_id)
    manifest = read_manifest(app_dir)
    for key in ("id", "title", "version"):
        if key not in manifest:
            die("app.json missing '%s'" % key)
    if manifest["id"] != app_id:
        die("app.json id '%s' != directory '%s'" % (manifest["id"], app_id))
    main = os.path.join(app_dir, "main.js")
    node = find_node()
    r = subprocess.run([node or "node", "--check", main])
    if r.returncode != 0:
        die("main.js syntax error")
    print("validate: OK (%s v%s)" % (app_id, manifest["version"]))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="pack an MGU app into dist/*.mgu")
    ap.add_argument("app_id")
    ap.add_argument("--sdk", default=None, help="(reserved) path to extracted oap-sdk")
    ap.add_argument("--node", default=None, help="node binary to use")
    ap.add_argument("--out", default=None, help="output directory (default ./dist)")
    ap.add_argument("--validate-only", action="store_true")
    a = ap.parse_args()
    validate(a.app_id)
    if not a.validate_only:
        build(a.app_id, a.sdk, a.node, a.out)
