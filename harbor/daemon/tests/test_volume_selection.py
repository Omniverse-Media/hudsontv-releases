import json
import os

import pytest

from harbor_daemon.config import ConfigError, from_dict


def select(env, role, fp="ABCD-1234", over=None):
    d = env.cfg().incoming_dir
    os.makedirs(d, exist_ok=True)
    body = {"type": "volume_select", "fingerprint": fp, "role": role, "origin": {"machine": "mac-1", "user": "ed"}}
    body.update(over or {})
    with open(os.path.join(d, fp + ".select.json"), "w") as f:
        json.dump(body, f)


def test_ask_mode_lists_volume_without_reading_it(env):
    env.sony_card()
    env.daemon(card_selection="ask").tick()
    m = env.manifest()
    assert m["role"] == "unassigned"
    assert m["files"] == [] and m["checksum_state"] == "not_scanned"
    assert m["card"]["label"] == "USB 1" and m["card"]["fstype"] == "exfat"
    assert not os.path.exists(os.path.join(env.cfg().state_dir, "cards", "ABCD-1234.hashes.json"))


def test_marking_a_volume_as_card_scans_it_and_is_remembered(env):
    env.sony_card()
    d = env.daemon(card_selection="ask")
    d.tick()
    select(env, "card")
    d.tick()
    m = env.manifest()
    assert m["role"] == "card" and m["checksum_state"] == "complete" and len(m["files"]) == 3
    assert not os.listdir(env.cfg().incoming_dir)

    env.mounted = False
    d.tick()
    env.mounted = True
    d.tick()
    assert env.manifest()["role"] == "card"


def test_ignored_volume_stays_ignored_and_rejects_tickets(env):
    env.sony_card()
    d = env.daemon(card_selection="ask")
    d.tick()
    select(env, "ignore")
    d.tick()
    assert env.manifest()["role"] == "ignored"

    t = env.ticket()
    t["selection"] = [{"relative_path": "PRIVATE/M4ROOT/CLIP/C0001.MP4", "size": 300_000, "checksum": None}]
    env.submit(t)
    d.tick()
    st = env.status(t["ticket_id"])
    assert st["state"] == "failed" and "not marked as a card" in st["error"]

    env.mounted = False
    d.tick()
    env.mounted = True
    d.tick()
    assert env.manifest()["role"] == "ignored"


def test_card_can_be_switched_to_ignored(env):
    env.sony_card()
    d = env.daemon(card_selection="ask")
    d.tick()
    select(env, "card")
    d.tick()
    select(env, "ignore")
    d.tick()
    assert env.manifest()["role"] == "ignored" and env.manifest()["files"] == []


@pytest.mark.parametrize("body", [
    {"role": "delete"},
    {"type": "something_else"},
    {"fingerprint": "OTHER-FP"},
])
def test_bad_selection_is_discarded(env, body):
    env.sony_card()
    d = env.daemon(card_selection="ask")
    d.tick()
    select(env, "card", over=body)
    d.tick()
    assert env.manifest()["role"] == "unassigned"
    assert not os.listdir(env.cfg().incoming_dir)


def test_auto_mode_is_unchanged(env):
    env.sony_card()
    env.daemon().tick()
    m = env.manifest()
    assert m["role"] == "card" and len(m["files"]) == 3


def test_card_selection_is_validated():
    with pytest.raises(ConfigError):
        from_dict({"card_selection": "maybe"})


def local_note(env, files, fp="ABCD-1234", over=None):
    d = env.cfg().incoming_dir
    os.makedirs(d, exist_ok=True)
    body = {"type": "local_ingest", "fingerprint": fp, "files": files, "origin": {"machine": "laptop", "user": "dee"}}
    body.update(over or {})
    with open(os.path.join(d, fp + ".local.json"), "w") as f:
        json.dump(body, f)


def test_desktop_only_ingest_marks_those_files_as_offloaded(env):
    import time
    now = time.time()
    env.add_card_file("PRIVATE/M4ROOT/CLIP/C0001.MP4", os.urandom(1000), mtime=now - 300)
    env.add_card_file("PRIVATE/M4ROOT/CLIP/C0002.MP4", os.urandom(1000), mtime=now - 200)
    env.add_card_file("PRIVATE/M4ROOT/CLIP/C0003.MP4", os.urandom(1000), mtime=now - 100)
    d = env.daemon()
    d.tick()
    assert all(f["recent"] for f in env.manifest()["files"])
    local_note(env, ["PRIVATE/M4ROOT/CLIP/C0001.MP4", "PRIVATE/M4ROOT/CLIP/C0002.MP4", "../../etc/passwd"])
    d.tick()
    m = env.manifest()
    recent = {f["relative_path"].split("/")[-1]: f["recent"] for f in m["files"]}
    assert recent == {"C0001.MP4": False, "C0002.MP4": False, "C0003.MP4": True}
    assert m["last_ingest_at"] and m["recent_basis"] == "last_ingested_file_ts"
    assert not os.listdir(env.cfg().incoming_dir)
    # remembered across restarts: a fresh scan of the same card agrees
    env.daemon(card_selection="auto").tick()
    assert {f["relative_path"].split("/")[-1]: f["recent"] for f in env.manifest()["files"]} == recent


def test_bad_local_notes_are_dropped_without_effect(env):
    env.sony_card()
    d = env.daemon()
    d.tick()
    local_note(env, [], over={})
    d.tick()
    local_note(env, ["PRIVATE/M4ROOT/CLIP/C0001.MP4"], over={"type": "nope"})
    d.tick()
    local_note(env, ["PRIVATE/M4ROOT/CLIP/C0001.MP4"], over={"fingerprint": "OTHER"})
    d.tick()
    assert env.manifest()["last_ingest_at"] is None
    assert not os.listdir(env.cfg().incoming_dir)
