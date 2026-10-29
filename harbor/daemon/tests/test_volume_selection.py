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
