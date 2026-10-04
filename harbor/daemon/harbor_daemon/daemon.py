"""The Harbor daemon main loop: detect cards, publish manifests, run tickets."""
import errno
import fcntl
import json
import logging
import os
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

from . import __version__, clear, detect, manifest as manifest_mod
from .atomicio import write_json_atomic
from .config import Config
from .joblog import JobLog
from .profiles import ProfileSet, load_profiles
from .state import CardStore, JobStore, now_iso
from .status import StatusWriter
from .ticket import TicketError, validate
from .transfer import JobRunner

log = logging.getLogger("harbor")
_ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
PARTIAL_TICKET_GRACE = 10.0  # seconds: a half-uploaded ticket may still be arriving over SMB


class _Card:
    def __init__(self, mount, fingerprint, source):
        self.mount = mount
        self.fingerprint = fingerprint
        self.source = source
        self.manifest = None
        self.stop = threading.Event()


class _Inline:
    """Executor stand-in for tests: runs the task immediately."""

    def submit(self, fn, *a, **kw):
        fn(*a, **kw)

    def shutdown(self, wait=True):
        pass


class Daemon:
    def __init__(self, cfg: Config, profiles: ProfileSet = None, mount_source=detect.read_mounts,
                 serial_resolver=None, sync=False):
        self.cfg = cfg
        cfg.ensure_dirs()
        self.profiles = profiles or load_profiles(cfg.profiles_file)
        self.detector = detect.MountDetector(cfg, mount_source)
        self.serial_resolver = serial_resolver
        self.cards = {}  # fingerprint -> _Card
        self.lock = threading.RLock()
        self.card_store = CardStore(cfg.state_dir)
        self.jobs = JobStore(cfg.state_dir)
        self.status = StatusWriter(cfg.status_dir)
        self.stop_event = threading.Event()
        self.inflight = set()
        self.retry_after = {}
        self._last_msg = {}
        self._last_heartbeat = 0.0
        self._lock_fd = None
        self.job_pool = _Inline() if sync else ThreadPoolExecutor(max_workers=1, thread_name_prefix="harbor-job")
        self.scan_pool = _Inline() if sync else ThreadPoolExecutor(max_workers=2, thread_name_prefix="harbor-scan")

    # ---- lifecycle -----------------------------------------------------
    def acquire_lock(self):
        path = os.path.join(self.cfg.state_dir, "daemon.lock")
        self._lock_fd = open(path, "w")
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EACCES):
                raise SystemExit("another harbor daemon is already running on %s" % self.cfg.harbor_root)
            raise

    def run_forever(self):
        self.acquire_lock()
        log.info("harbor daemon %s started; root=%s", __version__, self.cfg.harbor_root)
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                log.error("tick failed:\n%s", traceback.format_exc())
            self.stop_event.wait(self.cfg.poll_interval_seconds)
        self.shutdown()

    def shutdown(self):
        self.stop_event.set()
        for c in list(self.cards.values()):
            c.stop.set()
        self.scan_pool.shutdown(wait=True)
        self.job_pool.shutdown(wait=True)

    def tick(self):
        self._heartbeat()
        self._scan_cards()
        self._scan_incoming()

    # ---- published daemon info for the desktop ------------------------
    def _heartbeat(self):
        if time.monotonic() - self._last_heartbeat < 10 and self._last_heartbeat:
            return
        self._last_heartbeat = time.monotonic()
        write_json_atomic(os.path.join(self.cfg.cards_dir, "_daemon.json"), {
            "version": __version__,
            "updated_at": now_iso(),
            "approved_roots": self.cfg.approved_roots,
            "checksum_algorithm": self.cfg.checksum_algorithm,
            "layout": self.cfg.layout,
            "allow_clear": self.cfg.allow_clear,
            "profiles": [p.name for p in self.profiles.profiles],
        })

    # ---- cards ---------------------------------------------------------
    def _card_by_mount(self, path):
        with self.lock:
            return next((c for c in self.cards.values() if c.mount.path == path), None)

    def card_mount_path(self, fingerprint):
        with self.lock:
            c = self.cards.get(fingerprint)
            return c.mount.path if c else None

    def card_present(self, fingerprint):
        p = self.card_mount_path(fingerprint)
        return bool(p) and os.path.isdir(p)

    def _scan_cards(self):
        added, removed = self.detector.poll()
        for m in removed:
            c = self._card_by_mount(m.path)
            if c:
                c.stop.set()
                with self.lock:
                    self.cards.pop(c.fingerprint, None)
                if c.manifest:
                    c.manifest["present"] = False
                    self._publish_manifest(c)
                log.info("card removed: %s", c.fingerprint)
        for m in added:
            fp, src = detect.card_fingerprint(self.cfg, m, self.serial_resolver)
            if fp in self.cfg.known_server_volume_serials:
                continue
            card = _Card(m, fp, src)
            with self.lock:
                self.cards[fp] = card
            log.info("card detected: %s (%s) at %s", fp, src, m.path)
            self.scan_pool.submit(self._build_manifest, card)

    def _publish_manifest(self, card):
        write_json_atomic(os.path.join(self.cfg.cards_dir, card.fingerprint + ".json"),
                          manifest_mod.public_view(card.manifest))

    def _build_manifest(self, card):
        try:
            record = self.card_store.record(card.fingerprint)
            card.manifest = manifest_mod.build_listing(
                self.cfg, self.profiles, card.mount, card.fingerprint, card.source, record, time.time())
            self._publish_manifest(card)
            cache = self.card_store.hash_cache(card.fingerprint)
            cache = manifest_mod.fill_checksums(
                self.cfg, card.mount, card.manifest, cache,
                publish=lambda m: self._publish_manifest(card),
                should_stop=lambda: card.stop.is_set() or self.stop_event.is_set())
            self.card_store.save_hash_cache(card.fingerprint, cache)
            if card.manifest["checksum_state"] == manifest_mod.PHASE_COMPLETE:
                self._publish_manifest(card)
        except Exception:
            log.error("manifest build failed for %s:\n%s", card.fingerprint, traceback.format_exc())

    # ---- tickets -------------------------------------------------------
    def _scan_incoming(self):
        try:
            names = os.listdir(self.cfg.incoming_dir)
        except OSError:
            return
        paths = []
        for n in names:
            if n.startswith(".") or not n.endswith(".json"):
                continue
            p = os.path.join(self.cfg.incoming_dir, n)
            try:
                paths.append((os.stat(p).st_mtime, p))
            except OSError:
                continue
        for _mtime, p in sorted(paths):
            if self.stop_event.is_set():
                break
            name = os.path.basename(p)
            if name.endswith(".clear.json"):
                self._handle_clear_file(p, name[: -len(".clear.json")])
            else:
                self._handle_ticket_file(p, name[: -len(".json")])

    def _move_processed(self, path):
        dest = os.path.join(self.cfg.processed_dir, os.path.basename(path))
        if os.path.exists(dest):
            dest += "." + str(int(time.time()))
        try:
            os.replace(path, dest)
        except OSError:
            log.error("could not move %s to processed", path)

    def _reject(self, path, tid, reason):
        log.warning("ticket rejected %s: %s", tid, reason)
        if tid and set(tid) <= _ID_CHARS and len(tid) <= 64:
            self.status.write(tid, "failed", [], 0.0, error="rejected: %s" % reason)
            JobLog(self.cfg.logs_dir, tid).event("ticket_rejected", reason=reason)
        self._move_processed(path)

    def _handle_ticket_file(self, path, name_id):
        tid = name_id.lower()
        if tid in self.inflight or self.retry_after.get(tid, 0) > time.time():
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (ValueError, UnicodeDecodeError) as e:
            try:
                age = time.time() - os.stat(path).st_mtime
            except OSError:
                return
            if age < PARTIAL_TICKET_GRACE:
                return  # probably still being written
            return self._reject(path, tid, "unreadable ticket JSON: %s" % e)
        except OSError:
            return
        try:
            ticket = validate(raw, self.cfg, filename_id=tid)
        except TicketError as e:
            return self._reject(path, tid, str(e))

        existing = self.jobs.load(tid)
        if existing and existing["state"] in ("done", "failed"):
            return self._move_processed(path)  # already finished; just tidy up

        if not self.card_present(ticket.fingerprint):
            msg = "waiting for card %s to be inserted" % ticket.fingerprint
            if self._last_msg.get(tid) != msg:
                self._last_msg[tid] = msg
                prev = self.status.read(tid)
                self.status.write(tid, "in_progress" if existing else "received",
                                  (prev or {}).get("files", []), (prev or {}).get("progress", 0.0), message=msg)
            return
        self._last_msg.pop(tid, None)
        self.inflight.add(tid)
        self.job_pool.submit(self._run_job, ticket, path)

    def _run_job(self, ticket, path):
        tid = ticket.ticket_id
        try:
            mount = self.card_mount_path(ticket.fingerprint)
            if not mount:
                return
            runner = JobRunner(self.cfg, self.profiles, self.jobs, self.status, self.card_store, ticket, mount,
                               lambda: self.card_present(ticket.fingerprint))
            runner.should_stop = self.stop_event.is_set
            outcome = runner.run()
            if outcome in ("done", "failed"):
                self._move_processed(path)
            else:
                self.retry_after[tid] = time.time() + self.cfg.pause_retry_seconds
        except TicketError as e:
            self._reject(path, tid, str(e))
        except Exception:
            log.error("job %s crashed:\n%s", tid, traceback.format_exc())
            self.retry_after[tid] = time.time() + 60
            self.status.write(tid, "in_progress", message="internal error; will retry (see daemon log)")
        finally:
            self.inflight.discard(tid)

    # ---- clear confirmations ------------------------------------------
    def _handle_clear_file(self, path, name_id):
        key = "clear:" + name_id
        if key in self.inflight:
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (ValueError, OSError):
            try:
                if time.time() - os.stat(path).st_mtime < PARTIAL_TICKET_GRACE:
                    return
            except OSError:
                return
            return self._move_processed(path)
        try:
            tid, token = clear.parse_confirm(raw, name_id.lower())
        except clear.ClearError as e:
            log.warning("bad clear confirm %s: %s", name_id, e)
            return self._move_processed(path)
        self.inflight.add(key)
        self.job_pool.submit(self._run_clear, path, tid, token, key)

    def _run_clear(self, path, tid, token, key):
        try:
            j = self.jobs.load(tid)
            mount = self.card_mount_path(j["fingerprint"]) if j else None
            try:
                clear.run_clear(self.cfg, self.jobs, self.status, tid, token, mount)
            except clear.ClearError as e:
                log.warning("clear refused for %s: %s", tid, e)
                JobLog(self.cfg.logs_dir, tid).event("clear_refused", reason=str(e))
                clear.record_failure(self.jobs, self.status, tid, str(e))
            self._move_processed(path)
        except Exception:
            log.error("clear crashed:\n%s", traceback.format_exc())
        finally:
            self.inflight.discard(key)
