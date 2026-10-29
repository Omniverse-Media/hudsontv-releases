"""Deliverables written next to the footage after an offload: an ASC MHL v2 generation per roll, so any
post house can re-check the copy with standard tools, and a human-readable offload report per job.

Both are best-effort extras: the copy is already verified, so a failure here is logged, never fatal.
"""
import csv
import datetime
import hashlib
import html
import io
import os
import re
import socket
from xml.sax.saxutils import escape, quoteattr

from . import __version__
from .atomicio import write_bytes_atomic

MHL_HASH_NAMES = {"xxh64": "xxh64", "sha256": None}  # ASC MHL v2 has no sha256 element
IGNORE = (".DS_Store", "ascmhl", "ascmhl/", "*.harbor-partial", "Harbor reports")
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def c4_id(data):
    """SMPTE ST 2114 C4 ID: 'c4' + base58 of the SHA-512, left-padded to 90 characters."""
    n = int.from_bytes(hashlib.sha512(data).digest(), "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    return "c4" + out.rjust(88, "1")


def _iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).replace(microsecond=0).isoformat()


def write_mhl(root, entries, algo, now=None, hostname=None):
    """Add one MHL generation for `entries` (dicts: path relative to root, size, mtime, hexdigest) to
    <root>/ascmhl/ and register it in ascmhl_chain.xml. Returns the generation's path, or None."""
    tag = MHL_HASH_NAMES.get(algo)
    if not tag or not entries:
        return None
    now = now or datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    mdir = os.path.join(root, "ascmhl")
    os.makedirs(mdir, exist_ok=True)
    seq = 1 + max([int(m.group(1)) for m in (re.match(r"(\d{4})_.*\.mhl$", n) for n in os.listdir(mdir)) if m] or [0])
    name = "%04d_%s_%s.mhl" % (seq, re.sub(r"[^\w.-]+", "_", os.path.basename(root.rstrip("/"))), now.strftime("%Y-%m-%d_%H%M%SZ"))
    stamp = now.isoformat()
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<hashlist version="2.0" xmlns="urn:ASC:MHL:v2.0">',
        "  <creatorinfo>",
        "    <creationdate>%s</creationdate>" % stamp,
        "    <hostname>%s</hostname>" % escape(hostname or socket.gethostname()),
        '    <tool version=%s>Harbor</tool>' % quoteattr(__version__),
        "  </creatorinfo>",
        "  <processinfo>",
        "    <process>transfer</process>",
        "    <ignore>%s</ignore>" % "".join("<pattern>%s</pattern>" % escape(p) for p in IGNORE),
        "  </processinfo>",
        "  <hashes>",
    ]
    for e in sorted(entries, key=lambda e: e["path"]):
        lines.append('    <hash><path size="%d" lastmodificationdate="%s">%s</path><%s action="original" hashdate="%s">%s</%s></hash>'
                     % (e["size"], _iso(e["mtime"]), escape(e["path"]), tag, stamp, e["hexdigest"], tag))
    lines += ["  </hashes>", "</hashlist>", ""]
    body = "\n".join(lines).encode("utf-8")
    path = os.path.join(mdir, name)
    write_bytes_atomic(path, body)

    chain = os.path.join(mdir, "ascmhl_chain.xml")
    items = []
    try:
        with open(chain, encoding="utf-8") as fh:
            items = re.findall(r'<hashlist sequencenr="(\d+)">\s*<path>(.*?)</path>\s*<c4>(.*?)</c4>', fh.read(), re.S)
    except OSError:
        pass
    items.append((str(seq), escape(name), c4_id(body)))
    doc = ['<?xml version="1.0" encoding="UTF-8"?>', '<ascmhldirectory xmlns="urn:ASC:MHL:DIRECTORY:v2.0">']
    doc += ['  <hashlist sequencenr="%s">\n    <path>%s</path>\n    <c4>%s</c4>\n  </hashlist>' % it for it in items]
    doc += ["</ascmhldirectory>", ""]
    write_bytes_atomic(chain, "\n".join(doc).encode("utf-8"))
    return path


def _fmt_bytes(n):
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return ("%.0f %s" if u == "B" else "%.1f %s") % (n, u)
        n /= 1024.0


def write_report_files(out_dir, base_name, report, card_label=None):
    """Write <base>.csv (one row per file) and <base>.html (printable summary) into out_dir."""
    os.makedirs(out_dir, exist_ok=True)
    files = report["files"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["file", "type", "bytes", "state", "checksum", "verified_checksum", "destination", "note", "error"])
    for f in files:
        w.writerow([f["relative_path"], f["media_type"], f["size"], f["state"], f["source_checksum"] or "",
                    f["staged_checksum"] or "", f["destination"] or "", f["note"] or "", f["error"] or ""])
    write_bytes_atomic(os.path.join(out_dir, base_name + ".csv"), buf.getvalue().encode("utf-8"))

    dit = report.get("dit") or {}
    t = report["totals"]
    ok = report["outcome"] == "done"
    e = html.escape
    rows = "".join(
        "<tr class='%s'><td>%s</td><td>%s</td><td class='n'>%s</td><td>%s</td><td class='mono'>%s</td></tr>"
        % ("" if f["state"] == "staged" else "bad", e(f["relative_path"]), e(f["media_type"]), _fmt_bytes(f["size"]),
           "verified" if f["state"] == "staged" else e(f["error"] or f["state"]), e((f["source_checksum"] or "").split(":")[-1]))
        for f in files)
    facts = [
        ("Project", report["project"]), ("Day", dit.get("day")), ("Group", dit.get("group")), ("Roll", dit.get("roll")),
        ("Card", "%s (%s)" % (card_label, report["source_card"]["fingerprint"]) if card_label else report["source_card"]["fingerprint"]),
        ("Files", "%d of %d verified" % (t["staged"], t["files"])), ("Size", _fmt_bytes(t["bytes"])),
        ("Checksum", report["checksum_algorithm"]), ("Started", report["started_at"]), ("Finished", report["finished_at"]),
        ("Offloaded by", "%s on %s" % (report["origin"].get("user"), report["origin"].get("machine"))),
        ("MHL", report.get("mhl")),
    ]
    page = """<!doctype html><html><head><meta charset="utf-8"><title>Offload report %s</title><style>
body{font:13px/1.45 -apple-system,Helvetica,Arial,sans-serif;color:#14181f;margin:32px}
h1{font-size:20px;margin:0 0 4px}.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-weight:700;color:#fff;background:%s}
dl{display:grid;grid-template-columns:130px 1fr;gap:4px 12px;margin:18px 0}dt{color:#667085}dd{margin:0}
table{border-collapse:collapse;width:100%%}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #e1e4ea}
th{font-size:11px;text-transform:uppercase;color:#667085}.n{text-align:right;white-space:nowrap}.mono{font-family:Menlo,monospace;font-size:11px}
tr.bad td{color:#b42318}footer{margin-top:18px;color:#667085;font-size:11px}</style></head><body>
<h1>Offload report: %s</h1><span class="badge">%s</span>
<dl>%s</dl>
<table><thead><tr><th>File</th><th>Type</th><th class="n">Size</th><th>Result</th><th>Checksum</th></tr></thead><tbody>%s</tbody></table>
<footer>Every file was read back from the server and compared with the checksum taken while reading the card. Generated by Harbor %s. Job %s.</footer>
</body></html>""" % (e(report["project"]), "#12805c" if ok else "#b42318", e(" / ".join(x for x in (report["project"], dit.get("group"), dit.get("roll")) if x)),
                     "ALL FILES VERIFIED" if ok else "%d FILE(S) FAILED" % t["failed"],
                     "".join("<dt>%s</dt><dd>%s</dd>" % (e(k), e(str(v))) for k, v in facts if v), rows, e(__version__), e(report["ticket_id"]))
    write_bytes_atomic(os.path.join(out_dir, base_name + ".html"), page.encode("utf-8"))
