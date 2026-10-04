import json
import os
import uuid

import pytest

from harbor_daemon.config import from_dict
from harbor_daemon.daemon import Daemon
from harbor_daemon.detect import Mount


class Env:
    def __init__(self, tmp_path):
        self.root = str(tmp_path / "harbor")
        self.projects = str(tmp_path / "Projects")
        self.usb = str(tmp_path / "volumeUSB1")
        self.card = os.path.join(self.usb, "usbshare")
        os.makedirs(self.projects)
        os.makedirs(self.card)
        self.mounted = True
        self.cfg_overrides = {}
        self._daemon = None

    def cfg(self, **over):
        d = {
            "harbor_root": self.root,
            "approved_roots": [self.projects],
            "removable_mount_prefixes": [self.usb],
            "poll_interval_seconds": 0.01,
            "probe_duration": False,
            "pause_retry_seconds": 0,
        }
        d.update(self.cfg_overrides)
        d.update(over)
        return from_dict(d)

    def mount_source(self):
        base = [Mount("/dev/root", "/", "ext4")]
        if self.mounted:
            base.append(Mount("/dev/usb1p1", self.card, "exfat"))
        return base

    def daemon(self, **over):
        if self._daemon is None or over:
            self._daemon = Daemon(self.cfg(**over), mount_source=self.mount_source,
                                  serial_resolver=lambda m: "ABCD-1234", sync=True)
        return self._daemon

    # --- card helpers
    def add_card_file(self, rel, data=b"x" * 1000, mtime=None):
        p = os.path.join(self.card, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
        if mtime:
            os.utime(p, (mtime, mtime))
        return p

    def sony_card(self):
        self.add_card_file("PRIVATE/M4ROOT/CLIP/C0001.MP4", os.urandom(300_000))
        self.add_card_file("PRIVATE/M4ROOT/CLIP/C0002.MP4", os.urandom(200_000))
        self.add_card_file("DCIM/100MSDCF/DSC00001.ARW", os.urandom(50_000))

    def manifest(self):
        with open(os.path.join(self.cfg().cards_dir, "ABCD-1234.json")) as f:
            return json.load(f)

    def ticket(self, rels=None, project="ShootA", clear=False, **mods):
        m = self.manifest()
        files = [f for f in m["files"] if rels is None or f["relative_path"] in rels]
        t = {
            "ticket_id": str(uuid.uuid4()),
            "created_at": "2026-10-04T12:00:00Z",
            "origin": {"machine": "mac-1", "user": "editor"},
            "source": {"card_fingerprint": "ABCD-1234"},
            "destination": {
                "project_name": project,
                "approved_root": self.projects,
                "subfolder_map": {"video": "Footage/Video", "photo": "Footage/Photo",
                                  "audio": "Footage/Audio", "other": "Footage/Other"},
            },
            "selection": [{"relative_path": f["relative_path"], "size": f["size"], "checksum": f["checksum"]}
                          for f in files],
            "operation": {"copy": True, "verify": True, "clear_card": clear},
        }
        t.update(mods)
        return t

    def submit(self, ticket, suffix=".json"):
        d = self.cfg().incoming_dir
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, ticket["ticket_id"] + suffix)
        with open(p, "w") as f:
            json.dump(ticket, f)
        return p

    def status(self, tid):
        with open(os.path.join(self.cfg().status_dir, tid + ".json")) as f:
            return json.load(f)


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)
