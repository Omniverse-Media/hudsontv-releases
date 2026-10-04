import copy
import os

import pytest

from harbor_daemon.ticket import TicketError, bind_to_card, validate
from harbor_daemon.profiles import load_profiles


@pytest.fixture
def ready(env):
    env.sony_card()
    env.daemon().tick()
    return env


def test_valid_ticket(ready):
    t = ready.ticket()
    v = validate(t, ready.cfg(), filename_id=t["ticket_id"])
    assert v.project_name == "ShootA" and len(v.selection) == 3


@pytest.mark.parametrize("mutate,msg", [
    (lambda t: t["destination"].update(approved_root="/etc"), "allowlist"),
    (lambda t: t["destination"].update(approved_root="/tmp/../etc"), "'..'"),
    (lambda t: t["destination"].update(project_name="../evil"), "project_name"),
    (lambda t: t["destination"]["subfolder_map"].update(video="../../etc"), "subfolder_map"),
    (lambda t: t["destination"]["subfolder_map"].update(video="/abs"), "subfolder_map"),
    (lambda t: t["selection"][0].update(relative_path="../../etc/passwd"), "relative_path"),
    (lambda t: t["selection"].append(dict(t["selection"][0])), "duplicate"),
    (lambda t: t["operation"].update(verify=False), "verify"),
    (lambda t: t["operation"].update(copy=False), "copy"),
    (lambda t: t["operation"].update(clear_card=True), "disabled"),
    (lambda t: t.update(selection=[]), "empty"),
    (lambda t: t.update(ticket_id="not-a-uuid"), "UUID"),
    (lambda t: t["source"].update(card_fingerprint="/dev/sda"), "fingerprint"),
    (lambda t: t.pop("operation"), "operation"),
])
def test_rejections(ready, mutate, msg):
    t = ready.ticket()
    mutate(t)
    with pytest.raises(TicketError, match=msg):
        validate(t, ready.cfg())


def test_filename_must_match_ticket_id(ready):
    t = ready.ticket()
    with pytest.raises(TicketError, match="file name"):
        validate(t, ready.cfg(), filename_id="00000000-0000-4000-8000-000000000000")


def test_bind_rejects_missing_file_and_size_change(ready):
    ps = load_profiles()
    v = validate(ready.ticket(), ready.cfg())
    mount = ready.card
    v.selection[0].relative_path = "PRIVATE/M4ROOT/CLIP/NOPE.MP4"
    with pytest.raises(TicketError, match="not found"):
        bind_to_card(v, mount, ps)
    v = validate(ready.ticket(), ready.cfg())
    v.selection[0].size += 1
    with pytest.raises(TicketError, match="size mismatch"):
        bind_to_card(v, mount, ps)


def test_bind_rejects_symlink_escape_on_card(ready, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("secret")
    os.symlink(secret, os.path.join(ready.card, "DCIM", "evil.jpg"))
    t = ready.ticket()
    t["selection"] = [{"relative_path": "DCIM/evil.jpg", "size": 6, "checksum": None}]
    v = validate(t, ready.cfg())
    with pytest.raises(TicketError, match="escapes|symlink"):
        bind_to_card(v, ready.card, load_profiles())


def test_bind_needs_subfolder_for_media_type(ready):
    t = ready.ticket()
    del t["destination"]["subfolder_map"]["photo"]
    v = validate(t, ready.cfg())
    with pytest.raises(TicketError, match="subfolder_map entry"):
        bind_to_card(v, ready.card, load_profiles())


def test_destination_symlink_escape_blocked_at_write(ready, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, os.path.join(ready.projects, "ShootA"))
    t = ready.ticket()
    ready.submit(t)
    ready.daemon().tick()
    st = ready.status(t["ticket_id"])
    assert st["state"] == "failed"
    assert not any(outside.iterdir())
