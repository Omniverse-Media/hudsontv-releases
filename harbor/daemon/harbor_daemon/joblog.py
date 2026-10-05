"""Proof of capture: per-job event log (JSON lines, fsynced) and a final report."""
import json
import os

from .atomicio import write_json_atomic
from .state import now_iso


class JobLog:
    def __init__(self, logs_dir, ticket_id):
        self.events_path = os.path.join(logs_dir, ticket_id + ".jsonl")
        self.report_path = os.path.join(logs_dir, ticket_id + ".report.json")
        os.makedirs(logs_dir, exist_ok=True)

    def event(self, kind, **fields):
        rec = {"at": now_iso(), "event": kind}
        rec.update(fields)
        with open(self.events_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def write_report(self, report):
        write_json_atomic(self.report_path, report)
