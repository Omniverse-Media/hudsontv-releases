import json
import os


def dit_ticket(env, group="Camera A", prefix="A", day="2026-04-29", **kw):
    t = env.ticket(**kw)
    t["destination"]["dit"] = {"day": day, "group": group, "roll_prefix": prefix}
    return t


def test_dit_layout_keeps_card_tree_under_a_roll(env):
    env.sony_card()
    d = env.daemon()
    d.tick()
    t = dit_ticket(env)
    env.submit(t)
    d.tick()
    st = env.status(t["ticket_id"])
    assert st["state"] == "done", st
    roll = os.path.join(env.projects, "ShootA", "2026-04-29", "Camera A", "A001")
    assert os.path.isfile(os.path.join(roll, "PRIVATE", "M4ROOT", "CLIP", "C0001.MP4"))
    assert os.path.isfile(os.path.join(roll, "DCIM", "100MSDCF", "DSC00001.ARW"))
    with open(os.path.join(env.cfg().logs_dir, t["ticket_id"] + ".report.json")) as f:
        assert json.load(f)["dit"]["roll"] == "A001"


def test_same_card_keeps_its_roll_and_next_card_gets_the_next(env):
    env.sony_card()
    d = env.daemon()
    d.tick()
    first = dit_ticket(env, rels=["PRIVATE/M4ROOT/CLIP/C0001.MP4"])
    env.submit(first)
    d.tick()
    again = dit_ticket(env, rels=["PRIVATE/M4ROOT/CLIP/C0002.MP4"])
    env.submit(again)
    d.tick()
    group = os.path.join(env.projects, "ShootA", "2026-04-29", "Camera A")
    assert os.listdir(group) == ["A001"]
    assert os.path.isfile(os.path.join(group, "A001", "PRIVATE", "M4ROOT", "CLIP", "C0002.MP4"))

    # A different card in the same group and day becomes A002.
    from harbor_daemon.state import RollBook
    rb = RollBook(env.cfg().state_dir)
    assert rb.assign(env.projects, "ShootA", "2026-04-29", "Camera A", "A", "OTHER-CARD", os.listdir(group)) == "A002"


def test_dit_fields_are_validated(env):
    env.sony_card()
    d = env.daemon()
    d.tick()
    for bad in ({"day": "../x", "group": "Camera A", "roll_prefix": "A"},
                {"day": "2026-04-29", "group": "Camera A", "roll_prefix": "A/1"},
                {"day": "2026-04-29", "group": ".hidden", "roll_prefix": "A"}):
        t = env.ticket()
        t["destination"]["dit"] = bad
        env.submit(t)
        d.tick()
        assert env.status(t["ticket_id"])["state"] == "failed"
