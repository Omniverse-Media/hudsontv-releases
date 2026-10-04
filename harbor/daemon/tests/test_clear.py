import json
import os

import pytest

CLIP1 = "PRIVATE/M4ROOT/CLIP/C0001.MP4"
CLIP2 = "PRIVATE/M4ROOT/CLIP/C0002.MP4"


@pytest.fixture
def done(env):
    env.cfg_overrides["allow_clear"] = True
    env.sony_card()
    d = env.daemon()
    d.tick()
    t = env.ticket(rels=[CLIP1], clear=True)
    env.submit(t)
    d.tick()
    return env, d, t


def confirm(env, t, token):
    return env.submit({"type": "clear_confirm", "ticket_id": t["ticket_id"], "token": token,
                       "created_at": "2026-10-04T12:00:00Z", "origin": {"machine": "m", "user": "u"}},
                      suffix=".clear.json")


def card(env, rel):
    return os.path.join(env.card, rel)


def test_clear_is_armed_but_does_nothing_until_confirmed(done):
    env, d, t = done
    st = env.status(t["ticket_id"])
    assert st["state"] == "done"
    assert st["clear"]["state"] == "awaiting_confirmation" and st["clear"]["token"]
    assert os.path.exists(card(env, CLIP1))


def test_wrong_token_deletes_nothing(done):
    env, d, t = done
    confirm(env, t, "wrong")
    d.tick()
    assert os.path.exists(card(env, CLIP1))
    st = env.status(t["ticket_id"])
    assert st["clear"]["state"] == "awaiting_confirmation" and "token" in st["clear"]["last_error"]


def test_confirmed_clear_deletes_only_selected_files(done):
    env, d, t = done
    token = env.status(t["ticket_id"])["clear"]["token"]
    confirm(env, t, token)
    d.tick()
    assert not os.path.exists(card(env, CLIP1))
    assert os.path.exists(card(env, CLIP2))  # not selected: untouched
    assert os.path.exists(card(env, "DCIM/100MSDCF/DSC00001.ARW"))
    assert os.path.isdir(os.path.dirname(card(env, CLIP1)))  # directories stay
    assert env.status(t["ticket_id"])["clear"]["state"] == "cleared"
    # token is single use
    confirm(env, t, token)
    d.tick()
    events = [json.loads(l) for l in open(os.path.join(env.cfg().logs_dir, t["ticket_id"] + ".jsonl"))]
    assert [e["event"] for e in events].count("card_cleared") == 1


def test_clear_aborts_if_destination_copy_was_damaged(done):
    env, d, t = done
    token = env.status(t["ticket_id"])["clear"]["token"]
    dest = os.path.join(env.projects, "ShootA", "Footage", "Video", "C0001.MP4")
    os.chmod(dest, 0o644)
    with open(dest, "r+b") as f:
        f.write(b"\x00\x00\x00")
    confirm(env, t, token)
    d.tick()
    assert os.path.exists(card(env, CLIP1))
    assert "does not match" in env.status(t["ticket_id"])["clear"]["last_error"]


def test_clear_aborts_if_card_file_changed(done):
    env, d, t = done
    token = env.status(t["ticket_id"])["clear"]["token"]
    with open(card(env, CLIP1), "r+b") as f:
        f.write(b"\x01")
    confirm(env, t, token)
    d.tick()
    assert os.path.exists(card(env, CLIP1))


def test_clear_refused_when_ticket_did_not_request_it(env):
    env.cfg_overrides["allow_clear"] = True
    env.sony_card()
    d = env.daemon()
    d.tick()
    t = env.ticket(rels=[CLIP1], clear=False)
    env.submit(t)
    d.tick()
    assert "clear" not in env.status(t["ticket_id"])
    confirm(env, t, "anything")
    d.tick()
    assert os.path.exists(card(env, CLIP1))


def test_clear_disabled_server_rejects_ticket(env):
    env.sony_card()
    d = env.daemon()
    d.tick()
    t = env.ticket(rels=[CLIP1], clear=True)
    env.submit(t)
    d.tick()
    st = env.status(t["ticket_id"])
    assert st["state"] == "failed" and "disabled" in st["error"]
