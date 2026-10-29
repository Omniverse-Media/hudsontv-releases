"""Per-card and per-job persistent state under <harbor_root>/state."""
import json
import os
import re
import threading
from datetime import datetime, timezone

from .atomicio import read_json, write_json_atomic

_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class CardStore:
    """Last-ingest tracking and a checksum cache, keyed by card fingerprint."""

    def __init__(self, state_dir):
        self.dir = os.path.join(state_dir, "cards")
        os.makedirs(self.dir, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, fp, suffix=""):
        if not _ID.match(fp):
            raise ValueError("bad fingerprint")
        return os.path.join(self.dir, fp + suffix + ".json")

    def record(self, fp):
        return read_json(self._path(fp), {"fingerprint": fp, "last_ingest_at": None, "last_ingested_file_ts": None})

    def note_ingest(self, fp, file_timestamps):
        """Called when a job completes. file_timestamps: epoch seconds of ingested files."""
        with self._lock:
            rec = self.record(fp)
            rec["last_ingest_at"] = now_iso()
            if file_timestamps:
                newest = max(file_timestamps)
                prev = rec.get("last_ingested_file_ts") or 0
                rec["last_ingested_file_ts"] = max(prev, newest)
            write_json_atomic(self._path(fp), rec)

    def hash_cache(self, fp):
        return read_json(self._path(fp, ".hashes"), {})

    def save_hash_cache(self, fp, cache):
        write_json_atomic(self._path(fp, ".hashes"), cache)


class VolumeRoles:
    """The user's choice per USB volume fingerprint: "card" (scan it) or "ignore" (part of the server)."""

    ROLES = ("card", "ignore")

    def __init__(self, state_dir):
        self.path = os.path.join(state_dir, "volume_roles.json")
        self._lock = threading.Lock()

    def get(self, fp):
        return (read_json(self.path, {}).get(fp) or {}).get("role")

    def set(self, fp, role, origin=None):
        if role not in self.ROLES or not _ID.match(fp):
            raise ValueError("bad volume role")
        with self._lock:
            data = read_json(self.path, {})
            data[fp] = {"role": role, "set_at": now_iso(), "origin": origin or {}}
            write_json_atomic(self.path, data)


class RollBook:
    """DIT roll numbers. A card offloaded into a group on a day keeps its roll (A001), so a second pass over
    the same card adds to that roll; the next card gets the next number."""

    def __init__(self, state_dir):
        self.path = os.path.join(state_dir, "rolls.json")
        self._lock = threading.Lock()

    def assign(self, root, project, day, group, prefix, fingerprint, existing_names):
        scope = [root, project, day, group]
        key = json.dumps(scope + [fingerprint])
        pat = re.compile(r"^%s(\d{3,})$" % re.escape(prefix), re.I)
        with self._lock:
            data = read_json(self.path, {})
            if key in data:
                return data[key]
            used = [n for n in existing_names if pat.match(n)]
            used += [v for k, v in data.items() if json.loads(k)[:4] == scope]
            nums = [int(pat.match(n).group(1)) for n in used if pat.match(n)]
            roll = "%s%03d" % (prefix, max(nums, default=0) + 1)
            data[key] = roll
            write_json_atomic(self.path, data)
            return roll


class JobStore:
    """Per-ticket journal: the source of truth for resuming an interrupted job."""

    def __init__(self, state_dir):
        self.dir = os.path.join(state_dir, "jobs")
        os.makedirs(self.dir, exist_ok=True)

    def path(self, ticket_id):
        if not _ID.match(ticket_id):
            raise ValueError("bad ticket id")
        return os.path.join(self.dir, ticket_id + ".json")

    def load(self, ticket_id):
        return read_json(self.path(ticket_id))

    def save(self, journal):
        write_json_atomic(self.path(journal["ticket_id"]), journal)
