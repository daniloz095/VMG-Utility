#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deploy.py - push a built .mgu (or the raw app folder) onto the head unit over
SSH and restart oap-mainapp so the app appears in the OAP menu.

Usage:
    python3 kit/tools/deploy.py <app_id> --host 192.168.x.x [--key ~/.ssh/id_mgu]
    python3 kit/tools/deploy.py m_vitals_plus --host 192.168.1.40 --user root

Behaviour:
  1. If dist/<app>@<ver>.mgu exists, it is unpacked locally and pushed;
     otherwise apps/<app>/ (main.js + app.json) is pushed in dev layout.
  2. Files land in /var/opt/private/oap/<app_id>/ on the HU.
  3. chmod -R a+rX, then `killall oap-mainapp` (supervisor respawns it).

Requires working SSH access (you have root on the HU). The script uses plain
`scp`/`ssh` from PATH.
"""

import argparse
import json
import os
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def die(msg):
    sys.stderr.write("deploy.py: %s\n" % msg)
    sys.exit(1)


def sh(cmd, check=True):
    print("+", " ".join(cmd))
    r = subprocess.run(cmd)
    if check and r.returncode != 0:
        die("command failed (exit %d)" % r.returncode)
    return r.returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("app_id")
    ap.add_argument("--host", required=True, help="HU IP or hostname")
    ap.add_argument("--user", default="root")
    ap.add_argument("--key", default=None, help="ssh private key path")
    ap.add_argument("--dest", default="/var/opt/private/oap",
                    help="apps directory on the HU")
    ap.add_argument("--no-restart", action="store_true")
    a = ap.parse_args()

    ssh_opts = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"]
    if a.key:
        ssh_opts += ["-i", a.key]
    target = "%s@%s" % (a.user, a.host)

    # connectivity check first - fail early with a clear message
    r = sh(["ssh"] + ssh_opts + [target, "echo ok"], check=False)
    if r != 0:
        die("cannot SSH to %s. Check ignition/power, IP and key." % target)

    app_dir = os.path.join(ROOT, "apps", a.app_id)
    stage = tempfile.mkdtemp(prefix="mgu-deploy-")
    payload = os.path.join(stage, a.app_id)
    os.makedirs(payload)

    # prefer the built package next to the source tree
    dist = os.path.join(ROOT, "dist")
    mgu = None
    if os.path.isdir(dist):
        for f in os.listdir(dist):
            if f.startswith(a.app_id + "@") and f.endswith(".mgu"):
                mgu = os.path.join(dist, f)
    if mgu:
        print("using package:", mgu)
        with tarfile.open(mgu, "r:gz") as tf:
            tf.extractall(payload)
    else:
        print("no .mgu found - pushing raw dev layout (main.js+app.json)")
        for f in ("app.json", "main.js"):
            src = os.path.join(app_dir, f)
            if not os.path.isfile(src):
                die("missing %s" % src)
            # HU expects javascript/app.js; keep main.js too for dev reloads
            pass
        os.makedirs(os.path.join(payload, "javascript"))
        import shutil
        shutil.copy(os.path.join(app_dir, "app.json"), payload)
        shutil.copy(os.path.join(app_dir, "main.js"),
                    os.path.join(payload, "javascript", "app.js"))

    remote = "%s:%s/%s" % (target, a.dest, a.app_id)
    sh(["ssh"] + ssh_opts + [target, "rm -rf %s/%s && mkdir -p %s/%s"
                             % (a.dest, a.app_id, a.dest, a.app_id)])
    sh(["scp"] + ssh_opts + ["-r", payload, "%s:%s/" % (target, a.dest)])
    sh(["ssh"] + ssh_opts + [target,
        "chmod -R a+rX %s/%s" % (a.dest, a.app_id)])
    if not a.no_restart:
        sh(["ssh"] + ssh_opts + [target, "killall oap-mainapp || true"], check=False)
        print("oap-mainapp killed - it respawns in ~5-10 s.")
    import shutil as _sh
    _sh.rmtree(stage, ignore_errors=True)
    print("DONE: %s deployed to %s" % (a.app_id, remote))


if __name__ == "__main__":
    main()
