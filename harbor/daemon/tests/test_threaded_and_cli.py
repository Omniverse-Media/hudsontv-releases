import json
import os
import time

from harbor_daemon.__main__ import main
from harbor_daemon.daemon import Daemon


def test_threaded_daemon_end_to_end(env):
    env.sony_card()
    d = Daemon(env.cfg(), mount_source=env.mount_source, serial_resolver=lambda m: "ABCD-1234", sync=False)
    d.tick()
    d.scan_pool.shutdown(wait=True)  # let the manifest finish
    t = env.ticket(rels=["DCIM/100MSDCF/DSC00001.ARW"])
    env.submit(t)
    d.tick()
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            if env.status(t["ticket_id"])["state"] == "done":
                break
        except FileNotFoundError:
            pass
        time.sleep(0.05)
    assert env.status(t["ticket_id"])["state"] == "done"
    d.shutdown()


def test_cli_check_config(tmp_path, capsys):
    p = tmp_path / "h.json"
    p.write_text(json.dumps({"harbor_root": str(tmp_path / "h"), "approved_roots": ["/volume1/Projects"]}))
    assert main(["--config", str(p), "check-config"]) == 0
    p.write_text(json.dumps({"approved_roots": ["relative/path"]}))
    assert main(["--config", str(p), "check-config"]) == 2
    p.write_text(json.dumps({"bogus": 1}))
    assert main(["--config", str(p), "check-config"]) == 2
