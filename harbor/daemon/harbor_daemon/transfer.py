"""Copy -> verify -> stage engine. Never an OS-level move from the card.

Per file: copy card->staging (hashing the bytes read from the card), re-read the staged
file from disk and hash it, compare. Only a verified file is handed off into the project
folder, so a watcher on the project (ShareSync) only ever sees complete, verified files.

State is journaled after every transition, so an interrupted job resumes per file and
nothing already staged is repeated.
"""
import errno
import os
import shutil
import time

from . import hashing
from .pathsafe import PathError
from .state import now_iso
from .ticket import TicketError, bind_to_card, destination_dir

# Weights for the progress bar: copy, verify, handoff.
_W_COPY, _W_VERIFY, _W_STAGE = 0.45, 0.45, 0.10
_LINK_FALLBACK_ERRNOS = (errno.EXDEV, errno.EPERM, errno.EMLINK, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EACCES)


class PauseJob(Exception):
    """Interruption (card removed, disk full). The ticket stays open and resumes later."""


class FileFailed(Exception):
    pass


class JobRunner:
    def __init__(self, cfg, profiles, jobs, status, card_store, ticket, mount_path, fingerprint_present):
        self.cfg = cfg
        self.profiles = profiles
        self.jobs = jobs
        self.status = status
        self.card_store = card_store
        self.ticket = ticket
        self.mount_path = mount_path
        self.card_present = fingerprint_present
        self.algo = cfg.checksum_algorithm
        from .joblog import JobLog

        self.log = JobLog(cfg.logs_dir, ticket.ticket_id)
        self.staging = os.path.join(cfg.staging_dir, ticket.ticket_id)
        self.journal = None
        self.should_stop = lambda: False

    # ---- journal -------------------------------------------------------
    def _open_journal(self, bound):
        j = self.jobs.load(self.ticket.ticket_id)
        if j is not None:
            if j.get("ticket_digest") != self.ticket.digest:
                raise TicketError("ticket was modified after it was accepted")
            self.log.event("job_resumed")
            return j
        j = {
            "ticket_id": self.ticket.ticket_id,
            "ticket_digest": self.ticket.digest,
            "fingerprint": self.ticket.fingerprint,
            "state": "in_progress",
            "clear_card": self.ticket.clear_card,
            "clear": None,
            "started_at": now_iso(),
            "finished_at": None,
            "files": {},
        }
        for i, item in enumerate(self.ticket.selection):
            j["files"][item.relative_path] = {
                "index": i,
                "state": "pending",
                "size": item.size,
                "media_type": bound[item.relative_path]["media_type"],
                "expected_checksum": item.checksum,
                "src_checksum": None,
                "stage_checksum": None,
                "staging_path": None,
                "dest_path": None,
                "src_mtime": None,
                "attempts": 0,
                "error": None,
                "note": None,
                "times": {},
            }
        self.log.event("job_accepted", origin=self.ticket.origin, fingerprint=self.ticket.fingerprint,
                       project=self.ticket.project_name, files=len(self.ticket.selection),
                       checksum_algorithm=self.algo)
        return j

    def _save(self):
        self.jobs.save(self.journal)

    # ---- status --------------------------------------------------------
    def _file_states(self):
        return [{"relative_path": rel, "state": f["state"]} for rel, f in self.journal["files"].items()]

    def _progress(self, current=None):
        total = sum(f["size"] for f in self.journal["files"].values()) or 1
        done = 0.0
        for rel, f in self.journal["files"].items():
            frac = {"pending": 0, "copying": 0, "copied": _W_COPY, "verified": _W_COPY + _W_VERIFY,
                    "staged": 1.0, "failed": 0}[f["state"]]
            done += f["size"] * frac
        if current:
            done += current
        return done / total

    def _publish(self, state="in_progress", error=None, message=None, force=True, current=0.0):
        if not force and self.should_stop():
            raise PauseJob("daemon stopping")
        self.status.write(self.ticket.ticket_id, state, self._file_states(), self._progress(current),
                          error, message, force=force)

    # ---- main entry ----------------------------------------------------
    def run(self):
        """Returns 'done', 'failed' or 'paused'. Raises TicketError for a bad/changed ticket."""
        bound = bind_to_card(self.ticket, self.mount_path, self.profiles)
        self.journal = self._open_journal(bound)
        self._save()
        self._publish()
        os.makedirs(self.staging, exist_ok=True)
        try:
            for rel in self.journal["files"]:
                f = self.journal["files"][rel]
                if f["state"] in ("staged", "failed"):
                    continue
                if self.should_stop():
                    raise PauseJob("daemon stopping")
                self._process_file(rel, f, bound[rel]["abs"])
        except PauseJob as e:
            self.log.event("job_paused", reason=str(e))
            self._save()
            self._publish("in_progress", message="paused: %s" % e)
            return "paused"

        failed = [r for r, f in self.journal["files"].items() if f["state"] == "failed"]
        self.journal["finished_at"] = now_iso()
        if failed:
            self.journal["state"] = "failed"
            self._save()
            self._publish("failed", error="%d file(s) failed: %s" % (len(failed), ", ".join(failed[:5])))
            outcome = "failed"
        else:
            self.journal["state"] = "done"
            self._save()
            outcome = "done"
            self.card_store.note_ingest(
                self.ticket.fingerprint,
                [f["src_mtime"] for f in self.journal["files"].values() if f["src_mtime"] is not None],
            )
            if self.ticket.clear_card and self.cfg.allow_clear:
                from .clear import new_clear_state

                self.journal["clear"] = new_clear_state()
                self._save()
                self.status.set_clear(self.ticket.ticket_id, self.journal["clear"])
            self._publish("done", message="all files verified on the server")
        self._write_report(outcome)
        shutil.rmtree(self.staging, ignore_errors=True)
        return outcome

    # ---- per file ------------------------------------------------------
    def _process_file(self, rel, f, src):
        while f["state"] not in ("staged", "failed"):
            try:
                if f["state"] in ("pending", "copying"):
                    self._copy(rel, f, src)
                elif f["state"] == "copied":
                    self._verify(rel, f)
                elif f["state"] == "verified":
                    self._handoff(rel, f)
            except FileFailed as e:
                self._fail(rel, f, str(e))
            except PauseJob:
                raise
            except OSError as e:
                self._io_error(rel, f, e)

    def _fail(self, rel, f, why):
        f["state"] = "failed"
        f["error"] = why
        self.log.event("file_failed", path=rel, error=why)
        if f["staging_path"]:
            for p in (f["staging_path"], f["staging_path"] + ".part"):
                _silent_unlink(p)
        self._save()
        self._publish()

    def _io_error(self, rel, f, e):
        if e.errno == errno.ENOSPC:
            raise PauseJob("no space left on the server")
        if not self.card_present():
            raise PauseJob("card removed or unreadable")
        f["attempts"] += 1
        self.log.event("io_error", path=rel, error=str(e), attempt=f["attempts"])
        if f["attempts"] >= self.cfg.max_file_attempts:
            self._fail(rel, f, "I/O error after %d attempts: %s" % (f["attempts"], e))
        else:
            f["state"] = "pending"
            self._save()

    def _copy(self, rel, f, src):
        self.log.event("copy_start", path=rel, size=f["size"])
        f["state"] = "copying"
        f["staging_path"] = os.path.join(self.staging, "%06d__%s" % (f["index"], os.path.basename(rel)))
        part = f["staging_path"] + ".part"
        _silent_unlink(part)  # a partial from an interrupted run is restarted, never trusted
        h = hashing.new_hasher(self.algo)
        copied = 0
        with open(src, "rb") as fin, open(part, "wb") as fout:
            st = os.fstat(fin.fileno())
            if st.st_size != f["size"]:
                raise FileFailed("size changed on card (expected %d, now %d)" % (f["size"], st.st_size))
            while True:
                buf = fin.read(hashing.CHUNK)
                if not buf:
                    break
                h.update(buf)
                fout.write(buf)
                copied += len(buf)
                self._publish(force=False, current=copied * _W_COPY)
            fout.flush()
            os.fsync(fout.fileno())
        if copied != f["size"]:
            _silent_unlink(part)
            raise FileFailed("short read: copied %d of %d bytes" % (copied, f["size"]))
        os.utime(part, ns=(st.st_atime_ns, st.st_mtime_ns))
        src_sum = hashing.fmt(self.algo, h.hexdigest())
        if f["expected_checksum"] and f["expected_checksum"] != src_sum:
            _silent_unlink(part)
            raise FileFailed("card content differs from the manifest checksum (expected %s, read %s)"
                             % (f["expected_checksum"], src_sum))
        os.replace(part, f["staging_path"])
        f["src_checksum"] = src_sum
        f["src_mtime"] = st.st_mtime
        f["state"] = "copied"
        f["times"]["copied"] = now_iso()
        self.log.event("file_copied", path=rel, size=f["size"], source_checksum=src_sum)
        self._save()
        self._publish()

    def _verify(self, rel, f):
        if not os.path.exists(f["staging_path"]):
            f["state"] = "pending"  # staged copy vanished (e.g. staging cleaned); re-copy
            self._save()
            return
        got = hashing.hash_file(
            f["staging_path"], self.algo, cold=True,
            progress=lambda n: self._publish(force=False, current=n * _W_VERIFY),
        )
        f["stage_checksum"] = got
        if got != f["src_checksum"]:
            self.log.event("verify_mismatch", path=rel, source=f["src_checksum"], staged=got)
            _silent_unlink(f["staging_path"])
            f["attempts"] += 1
            if f["attempts"] >= self.cfg.max_file_attempts:
                raise FileFailed("verification failed: staged checksum %s != card checksum %s" % (got, f["src_checksum"]))
            f["state"] = "pending"
            f["stage_checksum"] = None
            self._save()
            return
        f["state"] = "verified"
        f["times"]["verified"] = now_iso()
        self.log.event("file_verified", path=rel, checksum=got)
        self._save()
        self._publish()

    def _handoff(self, rel, f):
        if not os.path.exists(f["staging_path"]) and not f["dest_path"]:
            f["state"] = "pending"
            self._save()
            return
        try:
            ddir = destination_dir(self.ticket, f["media_type"],
                                   os.path.dirname(rel) if self.cfg.layout == "preserve" else "")
        except (PathError, KeyError) as e:
            raise FileFailed("destination invalid at handoff: %s" % e)
        os.makedirs(ddir, exist_ok=True)
        # Re-resolve after makedirs: a symlink swapped in since validation must not escape.
        ddir = destination_dir(self.ticket, f["media_type"],
                               os.path.dirname(rel) if self.cfg.layout == "preserve" else "")

        name = os.path.basename(rel)
        final, dedup = self._choose_name(ddir, name, f["src_checksum"], f["size"])
        if dedup:
            f["note"] = "identical file already present; not duplicated"
        else:
            self._place(f["staging_path"], final, f["src_checksum"])
        f["dest_path"] = final
        _silent_unlink(f["staging_path"])
        f["state"] = "staged"
        f["times"]["staged"] = now_iso()
        self.log.event("file_staged", path=rel, dest=final, checksum=f["src_checksum"], note=f["note"])
        self._save()
        self._publish()

    def _choose_name(self, ddir, name, checksum, size):
        """Never overwrite. Identical existing file => dedupe; different => numbered suffix."""
        stem, ext = os.path.splitext(name)
        n = 0
        while True:
            cand = os.path.join(ddir, name if n == 0 else "%s_%d%s" % (stem, n, ext))
            if not os.path.lexists(cand):
                return cand, False
            try:
                if os.path.getsize(cand) == size and hashing.hash_file(cand, self.algo) == checksum:
                    return cand, True
            except OSError:
                pass
            n += 1

    def _place(self, staged, final, checksum):
        """Atomic, no-clobber handoff. Hard link on the same filesystem; otherwise copy to a
        partial-suffixed temp in the destination dir, re-verify, then link into place."""
        try:
            os.link(staged, final)
            return
        except FileExistsError:
            raise
        except OSError as e:
            if e.errno not in _LINK_FALLBACK_ERRNOS:
                raise
        tmp = os.path.join(os.path.dirname(final), "." + os.path.basename(final) + self.cfg.handoff_partial_suffix)
        _silent_unlink(tmp)
        shutil.copyfile(staged, tmp)
        shutil.copystat(staged, tmp)
        fd = os.open(tmp, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        if hashing.hash_file(tmp, self.algo, cold=True) != checksum:
            _silent_unlink(tmp)
            raise FileFailed("destination copy failed checksum verification")
        try:
            try:
                os.link(tmp, final)
            except OSError:
                if os.path.lexists(final):
                    raise
                os.rename(tmp, final)
        finally:
            _silent_unlink(tmp)

    # ---- report --------------------------------------------------------
    def _write_report(self, outcome):
        j = self.journal
        self.log.write_report({
            "ticket_id": j["ticket_id"],
            "outcome": outcome,
            "source_card": {"fingerprint": j["fingerprint"]},
            "origin": self.ticket.origin,
            "project": self.ticket.project_name,
            "approved_root": self.ticket.approved_root,
            "checksum_algorithm": self.algo,
            "started_at": j["started_at"],
            "finished_at": j["finished_at"],
            "totals": {
                "files": len(j["files"]),
                "bytes": sum(f["size"] for f in j["files"].values()),
                "staged": sum(1 for f in j["files"].values() if f["state"] == "staged"),
                "failed": sum(1 for f in j["files"].values() if f["state"] == "failed"),
            },
            "files": [
                {"relative_path": r, "size": f["size"], "media_type": f["media_type"], "state": f["state"],
                 "source_checksum": f["src_checksum"], "staged_checksum": f["stage_checksum"],
                 "destination": f["dest_path"], "times": f["times"], "error": f["error"], "note": f["note"]}
                for r, f in j["files"].items()
            ],
        })


def _silent_unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass
