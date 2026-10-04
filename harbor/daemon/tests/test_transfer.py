import errno
import json
import os

import pytest

from harbor_daemon import hashing, transfer
from harbor_daemon.transfer import JobRunner


def dest(env, *p):
    return os.path.join(env.projects, "ShootA", *p)


def read(path):
    with open(path, "rb") as f:
        return f.read()


@pytest.fixture
def ready(env):
    env.sony_card()
    env.daemon().tick()
    return env


def test_happy_path(ready):
    t = ready.ticket()
    path = ready.submit(t)
    d = ready.daemon()
    d.tick()
    st = ready.status(t["ticket_id"])
    assert st["state"] == "done" and st["progress"] == 1.0 and st["error"] is None
    assert {f["state"] for f in st["files"]} == {"staged"}
    # bytes are identical and landed in mapped subfolders; card untouched
    for rel, sub in [("PRIVATE/M4ROOT/CLIP/C0001.MP4", "Footage/Video"), ("DCIM/100MSDCF/DSC00001.ARW", "Footage/Photo")]:
        name = os.path.basename(rel)
        assert read(dest(ready, sub, name)) == read(os.path.join(ready.card, rel))
        assert os.path.getmtime(dest(ready, sub, name)) == pytest.approx(os.path.getmtime(os.path.join(ready.card, rel)), abs=1)
        assert os.path.exists(os.path.join(ready.card, rel))
    # ticket tidied, staging empty, proof of capture written
    assert not os.path.exists(path)
    assert os.path.exists(os.path.join(ready.cfg().processed_dir, t["ticket_id"] + ".json"))
    assert not os.path.exists(os.path.join(ready.cfg().staging_dir, t["ticket_id"]))
    report = json.load(open(os.path.join(ready.cfg().logs_dir, t["ticket_id"] + ".report.json")))
    assert report["outcome"] == "done" and report["totals"]["staged"] == 3
    assert all(f["source_checksum"] == f["staged_checksum"] for f in report["files"])
    assert os.path.exists(os.path.join(ready.cfg().logs_dir, t["ticket_id"] + ".jsonl"))
    # last-ingest tracking: a rescan now flags nothing as recent
    ready.card_gone_and_back = None
    d2 = ready.daemon(poll_interval_seconds=0.02)
    ready.mounted = False
    d2.tick()
    ready.mounted = True
    d2.tick()
    assert all(f["recent"] is False for f in ready.manifest()["files"])
    ready.add_card_file("PRIVATE/M4ROOT/CLIP/C0003.MP4")
    ready.mounted = False
    d2.tick()
    ready.mounted = True
    d2.tick()
    recents = [f["relative_path"] for f in ready.manifest()["files"] if f["recent"]]
    assert recents == ["PRIVATE/M4ROOT/CLIP/C0003.MP4"]


def test_staged_file_corruption_is_caught_and_recopied(ready, monkeypatch):
    orig = JobRunner._copy
    calls = {"n": 0}

    def corrupting(self, rel, f, src):
        orig(self, rel, f, src)
        calls["n"] += 1
        if calls["n"] == 1:  # flip a byte in the first staged file after it was written
            with open(f["staging_path"], "r+b") as fh:
                fh.write(b"\xff")

    monkeypatch.setattr(JobRunner, "_copy", corrupting)
    t = ready.ticket(rels=["PRIVATE/M4ROOT/CLIP/C0001.MP4"])
    ready.submit(t)
    ready.daemon().tick()
    assert ready.status(t["ticket_id"])["state"] == "done"
    assert read(dest(ready, "Footage/Video", "C0001.MP4")) == read(os.path.join(ready.card, "PRIVATE/M4ROOT/CLIP/C0001.MP4"))
    assert calls["n"] == 2


def test_persistent_corruption_fails_and_nothing_reaches_project(ready, monkeypatch):
    orig = JobRunner._copy

    def always_corrupt(self, rel, f, src):
        orig(self, rel, f, src)
        with open(f["staging_path"], "r+b") as fh:
            fh.write(b"\xff\xff")

    monkeypatch.setattr(JobRunner, "_copy", always_corrupt)
    t = ready.ticket(rels=["PRIVATE/M4ROOT/CLIP/C0001.MP4"])
    ready.submit(t)
    ready.daemon().tick()
    st = ready.status(t["ticket_id"])
    assert st["state"] == "failed" and st["files"][0]["state"] == "failed"
    assert not os.path.exists(dest(ready, "Footage", "Video", "C0001.MP4"))
    # a failed job must not advance last-ingest tracking
    assert ready.daemon().card_store.record("ABCD-1234")["last_ingested_file_ts"] is None


def test_card_content_differing_from_manifest_checksum_fails(ready):
    t = ready.ticket(rels=["PRIVATE/M4ROOT/CLIP/C0002.MP4"])
    t["selection"][0]["checksum"] = "xxh64:0000000000000000"
    ready.submit(t)
    ready.daemon().tick()
    st = ready.status(t["ticket_id"])
    assert st["state"] == "failed"
    assert not os.path.exists(dest(ready, "Footage"))


def test_interruption_resumes_without_recopying_finished_files(ready, monkeypatch):
    t = ready.ticket(rels=["PRIVATE/M4ROOT/CLIP/C0001.MP4", "PRIVATE/M4ROOT/CLIP/C0002.MP4"])
    ready.submit(t)
    orig = JobRunner._copy
    copies = []
    boomed = []

    def flaky(self, rel, f, src):
        if rel.endswith("C0002.MP4") and not boomed:
            boomed.append(1)
            ready.mounted = False  # card bumped out mid-job
            raise OSError(errno.EIO, "I/O error")
        copies.append(rel)
        return orig(self, rel, f, src)

    monkeypatch.setattr(JobRunner, "_copy", flaky)
    d = ready.daemon()
    # make the runner see the card as gone once it is unmounted
    real_present = d.card_present
    d.card_present = lambda fp: ready.mounted and real_present(fp)
    d.tick()
    st = ready.status(t["ticket_id"])
    assert st["state"] == "in_progress" and "paused" in st["message"]
    states = {f["relative_path"]: f["state"] for f in st["files"]}
    assert states["PRIVATE/M4ROOT/CLIP/C0001.MP4"] == "staged"
    assert os.path.exists(os.path.join(ready.cfg().incoming_dir, t["ticket_id"] + ".json"))  # ticket stays open
    assert os.path.exists(dest(ready, "Footage/Video", "C0001.MP4"))  # nothing deleted

    ready.mounted = True
    d.tick()  # card removed event processed
    ready.mounted = True
    d.detector._seen = {}  # card re-detected
    d.tick()
    d.tick()
    assert ready.status(t["ticket_id"])["state"] == "done"
    assert copies.count("PRIVATE/M4ROOT/CLIP/C0001.MP4") == 1  # not repeated
    assert read(dest(ready, "Footage/Video", "C0002.MP4")) == read(os.path.join(ready.card, "PRIVATE/M4ROOT/CLIP/C0002.MP4"))


def test_ticket_waits_for_card_then_runs(ready):
    t = ready.ticket(rels=["DCIM/100MSDCF/DSC00001.ARW"])
    ready.mounted = False
    d = ready.daemon()
    d.tick()  # card gone
    ready.submit(t)
    d.tick()
    st = ready.status(t["ticket_id"])
    assert st["state"] == "received" and "waiting for card" in st["message"]
    ready.mounted = True
    d.tick()  # card detected
    d.tick()
    assert ready.status(t["ticket_id"])["state"] == "done"


def test_name_collision_never_overwrites(ready):
    os.makedirs(dest(ready, "Footage/Video"))
    with open(dest(ready, "Footage/Video", "C0001.MP4"), "wb") as f:
        f.write(b"someone else's clip")
    t = ready.ticket(rels=["PRIVATE/M4ROOT/CLIP/C0001.MP4"])
    ready.submit(t)
    ready.daemon().tick()
    assert ready.status(t["ticket_id"])["state"] == "done"
    assert read(dest(ready, "Footage/Video", "C0001.MP4")) == b"someone else's clip"
    assert read(dest(ready, "Footage/Video", "C0001_1.MP4")) == read(os.path.join(ready.card, "PRIVATE/M4ROOT/CLIP/C0001.MP4"))


def test_identical_existing_file_is_deduplicated(ready):
    t = ready.ticket(rels=["PRIVATE/M4ROOT/CLIP/C0001.MP4"])
    ready.submit(t)
    d = ready.daemon()
    d.tick()
    t2 = ready.ticket(rels=["PRIVATE/M4ROOT/CLIP/C0001.MP4"])
    ready.submit(t2)
    d.tick()
    assert ready.status(t2["ticket_id"])["state"] == "done"
    assert sorted(os.listdir(dest(ready, "Footage/Video"))) == ["C0001.MP4"]


def test_cross_device_handoff_fallback(ready, monkeypatch):
    real_link = os.link
    calls = {"n": 0}

    def fake_link(src, dst, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError(errno.EXDEV, "cross-device")
        return real_link(src, dst, **kw)

    monkeypatch.setattr(os, "link", fake_link)
    t = ready.ticket(rels=["PRIVATE/M4ROOT/CLIP/C0002.MP4"])
    ready.submit(t)
    ready.daemon().tick()
    assert ready.status(t["ticket_id"])["state"] == "done"
    assert read(dest(ready, "Footage/Video", "C0002.MP4")) == read(os.path.join(ready.card, "PRIVATE/M4ROOT/CLIP/C0002.MP4"))
    # no stray partial files for ShareSync to find
    assert [n for n in os.listdir(dest(ready, "Footage/Video")) if "partial" in n] == []


def test_modified_ticket_after_acceptance_is_refused(ready, monkeypatch):
    t = ready.ticket(rels=["PRIVATE/M4ROOT/CLIP/C0001.MP4"])
    ready.submit(t)
    d = ready.daemon()
    monkeypatch.setattr(JobRunner, "_copy", lambda *a, **k: (_ for _ in ()).throw(transfer.PauseJob("test")))
    d.tick()
    assert ready.status(t["ticket_id"])["state"] == "in_progress"
    t["selection"][0]["size"] = t["selection"][0]["size"]  # same size, but change project => new digest
    t["destination"]["project_name"] = "Other"
    ready.submit(t)
    monkeypatch.undo()
    d.tick()
    st = ready.status(t["ticket_id"])
    assert st["state"] == "failed" and "modified" in st["error"]


def test_bad_json_ticket_is_rejected_after_grace(ready, monkeypatch):
    import harbor_daemon.daemon as dm

    monkeypatch.setattr(dm, "PARTIAL_TICKET_GRACE", 0)
    tid = "11111111-1111-4111-8111-111111111111"
    p = os.path.join(ready.cfg().incoming_dir, tid + ".json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write("{not json")
    ready.daemon().tick()
    assert ready.status(tid)["state"] == "failed"
    assert not os.path.exists(p)
