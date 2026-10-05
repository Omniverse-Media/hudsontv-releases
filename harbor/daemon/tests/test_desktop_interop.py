"""The real desktop code (Node) builds and submits a ticket; the real daemon ingests it."""
import json
import os
import shutil
import subprocess

import pytest

DESKTOP = os.path.join(os.path.dirname(__file__), "..", "..", "desktop")

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

JS = r"""
const share = require(process.argv[1] + '/core/share');
const { buildTicket } = require(process.argv[1] + '/core/ticket');
const [root, fp, approvedRoot, clear] = process.argv.slice(2);
const m = share.listCards(root).find((c) => c.card.fingerprint === fp);
const t = buildTicket({ manifest: m, selected: m.files.filter((f) => f.recent).map((f) => f.relative_path),
  projectName: 'Interop Shoot', approvedRoot, subfolderMap: {}, clearCard: clear === '1',
  origin: { machine: 'node-test', user: 'ed' } });
share.submitTicket(root, t);
console.log(t.ticket_id);
"""


def run_desktop(env, clear=False):
    out = subprocess.run(["node", "-e", JS, os.path.abspath(DESKTOP), env.root, "ABCD-1234", env.projects, "1" if clear else "0"],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


def test_desktop_ticket_is_accepted_and_ingested(env):
    env.sony_card()
    d = env.daemon()
    d.tick()
    tid = run_desktop(env)
    d.tick()
    st = env.status(tid)
    assert st["state"] == "done", st
    assert os.path.exists(os.path.join(env.projects, "Interop Shoot", "Footage", "Video", "C0001.MP4"))


def test_desktop_clear_confirm_flow(env):
    env.cfg_overrides["allow_clear"] = True
    env.sony_card()
    d = env.daemon()
    d.tick()
    tid = run_desktop(env, clear=True)
    d.tick()
    token = env.status(tid)["clear"]["token"]
    js = (r"const s=require(process.argv[1]+'/core/share');"
          r"s.submitClearConfirm(process.argv[2],process.argv[3],process.argv[4],{machine:'m',user:'u'})")
    subprocess.run(["node", "-e", js, os.path.abspath(DESKTOP), env.root, tid, token], check=True)
    d.tick()
    assert env.status(tid)["clear"]["state"] == "cleared"
    assert not os.path.exists(os.path.join(env.card, "PRIVATE/M4ROOT/CLIP/C0001.MP4"))
