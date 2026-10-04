"""USB card detection: baseline of server volumes, diffed against current mounts."""
import hashlib
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass

from .atomicio import read_json, write_json_atomic


@dataclass(frozen=True)
class Mount:
    device: str
    path: str
    fstype: str


def read_mounts(proc_mounts="/proc/mounts"):
    mounts = []
    with open(proc_mounts, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.split()
            if len(parts) < 3:
                continue
            unesc = lambda s: re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)
            mounts.append(Mount(unesc(parts[0]), unesc(parts[1]), parts[2]))
    return mounts


def _is_removable_path(cfg, path):
    return any(path.startswith(p) for p in cfg.removable_mount_prefixes)


class MountDetector:
    """Finds cards: mounts under a removable prefix that are not baseline server volumes.

    The baseline is persisted at <state>/baseline.json. It records every mount that is
    NOT under a removable prefix (internal volumes) so a card already inserted when the
    daemon starts is still seen as new. Permanently attached USB drives are pinned with
    `harbor-daemon baseline --include-removable` or `known_server_volume_serials`.
    """

    def __init__(self, cfg, mount_source=read_mounts):
        self.cfg = cfg
        self.mount_source = mount_source
        self._baseline_path = os.path.join(cfg.state_dir, "baseline.json")
        self._seen = {}

    def snapshot_baseline(self, include_removable=False):
        entries = [
            {"device": m.device, "path": m.path}
            for m in self.mount_source()
            if include_removable or not _is_removable_path(self.cfg, m.path)
        ]
        write_json_atomic(self._baseline_path, {"created_at": time.time(), "mounts": entries})
        return entries

    def _baseline(self):
        data = read_json(self._baseline_path)
        if data is None:
            self.snapshot_baseline()
            data = read_json(self._baseline_path)
        return {(e["device"], e["path"]) for e in data["mounts"]}

    def candidates(self):
        baseline = self._baseline()
        out = {}
        for m in self.mount_source():
            if (m.device, m.path) in baseline:
                continue
            if not _is_removable_path(self.cfg, m.path):
                continue
            if m.fstype not in self.cfg.card_fstypes:
                continue
            if not os.path.isdir(m.path):
                continue
            out[m.path] = m
        return out

    def poll(self):
        """Return (added, removed) candidate mounts since the previous poll."""
        current = self.candidates()
        added = [m for p, m in current.items() if p not in self._seen]
        removed = [m for p, m in self._seen.items() if p not in current]
        self._seen = current
        return added, removed


# ---- fingerprinting ----------------------------------------------------

_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def sanitize_fingerprint(value):
    return _SAFE.sub("-", value)[:64] or "unknown"


def _serial_by_uuid(device):
    base = "/dev/disk/by-uuid"
    try:
        real = os.path.realpath(device)
        for name in os.listdir(base):
            if os.path.realpath(os.path.join(base, name)) == real:
                return name
    except OSError:
        pass
    return None


def _serial_by_command(template, device):
    try:
        out = subprocess.run(template.format(device=device).split(), capture_output=True, text=True, timeout=10)
        val = out.stdout.strip()
        return val or None
    except (OSError, subprocess.SubprocessError):
        return None


def _serial_by_blkid(device):
    exe = shutil.which("blkid")
    if not exe:
        return None
    return _serial_by_command(exe + " -s UUID -o value {device}", device)


def _synthesized(mount):
    """Last resort when the OS exposes no volume serial: hash size, fstype and the
    earliest-modified files. Marked 'synthesized' so the desktop can warn."""
    try:
        st = os.statvfs(mount.path)
        size = st.f_blocks * st.f_frsize
    except OSError:
        size = 0
    stamps = []
    for dirpath, _dirs, files in os.walk(mount.path):
        for fn in files:
            p = os.path.join(dirpath, fn)
            try:
                s = os.stat(p)
            except OSError:
                continue
            stamps.append((s.st_mtime_ns, os.path.relpath(p, mount.path), s.st_size))
        if len(stamps) > 5000:
            break
    stamps.sort()
    h = hashlib.sha256(repr((size, mount.fstype, stamps[:3])).encode())
    return "synth-" + h.hexdigest()[:16]


def card_fingerprint(cfg, mount, resolver=None):
    """Return (fingerprint, source). Source is 'volume-serial' or 'synthesized'."""
    if resolver is not None:
        val = resolver(mount)
        if val:
            return sanitize_fingerprint(val), "volume-serial"
    else:
        val = None
        if cfg.serial_command:
            val = _serial_by_command(cfg.serial_command, mount.device)
        val = val or _serial_by_uuid(mount.device) or _serial_by_blkid(mount.device)
        if val:
            return sanitize_fingerprint(val), "volume-serial"
    return _synthesized(mount), "synthesized"
