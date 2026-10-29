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


def test_offload_writes_asc_mhl_and_report(env):
    import xml.etree.ElementTree as ET
    import xxhash
    env.sony_card()
    d = env.daemon()
    d.tick()
    first = dit_ticket(env, rels=["PRIVATE/M4ROOT/CLIP/C0001.MP4"])
    env.submit(first)
    d.tick()
    second = dit_ticket(env, rels=["PRIVATE/M4ROOT/CLIP/C0002.MP4"])
    env.submit(second)
    d.tick()
    roll = os.path.join(env.projects, "ShootA", "2026-04-29", "Camera A", "A001")
    mhls = sorted(n for n in os.listdir(os.path.join(roll, "ascmhl")) if n.endswith(".mhl"))
    assert [n[:5] for n in mhls] == ["0001_", "0002_"] and all("_A001_" in n for n in mhls)
    ns = {"m": "urn:ASC:MHL:v2.0"}
    h = ET.parse(os.path.join(roll, "ascmhl", mhls[0])).getroot().find("m:hashes/m:hash", ns)
    rel = h.find("m:path", ns).text
    assert rel == "PRIVATE/M4ROOT/CLIP/C0001.MP4"
    with open(os.path.join(roll, *rel.split("/")), "rb") as fh:
        assert h.find("m:xxh64", ns).text == xxhash.xxh64(fh.read()).hexdigest()
    chain = ET.parse(os.path.join(roll, "ascmhl", "ascmhl_chain.xml")).getroot()
    gens = chain.findall("{urn:ASC:MHL:DIRECTORY:v2.0}hashlist")
    assert [g.get("sequencenr") for g in gens] == ["1", "2"] and all(g[1].text.startswith("c4") and len(g[1].text) == 90 for g in gens)

    reports = os.listdir(os.path.join(env.projects, "ShootA", "2026-04-29", "Harbor reports"))
    assert sorted(n.rsplit(".", 1)[1] for n in reports) == ["csv", "csv", "html", "html"]
    page = open(os.path.join(env.projects, "ShootA", "2026-04-29", "Harbor reports", [n for n in reports if n.endswith(".html")][0])).read()
    assert "ALL FILES VERIFIED" in page and "A001" in page
    with open(os.path.join(env.cfg().logs_dir, first["ticket_id"] + ".report.json")) as f:
        assert json.load(f)["mhl"].startswith("2026-04-29/Camera A/A001/ascmhl/0001_")


def test_ingest_that_does_not_fit_is_refused_up_front(env):
    env.sony_card()
    d = env.daemon(min_free_bytes=1 << 60)
    d.tick()
    t = dit_ticket(env)
    env.submit(t)
    d.tick()
    st = env.status(t["ticket_id"])
    assert st["state"] == "failed" and "not enough space" in st["error"]
    assert not os.path.exists(os.path.join(env.projects, "ShootA"))
