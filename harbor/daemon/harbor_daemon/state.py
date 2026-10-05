"""Per-card and per-job persistent state under <harbor_root>/state."""
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
