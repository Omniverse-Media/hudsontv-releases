"""Status handshake: /harbor/tickets/status/<ticket_id>.json, rewritten atomically."""
import os
import time

from .atomicio import read_json, write_json_atomic
from .state import now_iso

_FILE_STATES_DONE = ("verified", "staged")


class StatusWriter:
    def __init__(self, status_dir, min_interval=0.5):
        self.dir = status_dir
        self.min_interval = min_interval
        self._last = {}

    def path(self, ticket_id):
        return os.path.join(self.dir, ticket_id + ".json")

    def read(self, ticket_id):
        return read_json(self.path(ticket_id))

    def write(self, ticket_id, state, files=None, progress=0.0, error=None, message=None, clear=None, force=True):
        """files: list of {relative_path, state}. force=False throttles progress-only writes."""
        now = time.monotonic()
        if not force and now - self._last.get(ticket_id, 0) < self.min_interval:
            return
        self._last[ticket_id] = now
        prev = self.read(ticket_id) or {}
        doc = {
            "ticket_id": ticket_id,
            "state": state,
            "files": files if files is not None else prev.get("files", []),
            "progress": round(min(max(progress, 0.0), 1.0), 4),
            "error": error,
            "message": message,
            "updated_at": now_iso(),
        }
        c = clear if clear is not None else prev.get("clear")
        if c is not None:
            doc["clear"] = c
        write_json_atomic(self.path(ticket_id), doc)

    def set_clear(self, ticket_id, clear):
        doc = self.read(ticket_id) or {"ticket_id": ticket_id, "state": "done", "files": [], "progress": 1.0, "error": None}
        doc["clear"] = clear
        doc["updated_at"] = now_iso()
        write_json_atomic(self.path(ticket_id), doc)


def all_files_ok(files):
    return bool(files) and all(f["state"] in _FILE_STATES_DONE for f in files)
