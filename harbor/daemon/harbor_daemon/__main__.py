import argparse
import logging
import signal
import sys

from . import config as config_mod
from .daemon import Daemon
from .detect import MountDetector


def main(argv=None):
    ap = argparse.ArgumentParser(prog="harbor-daemon")
    ap.add_argument("--config", default="/etc/harbor/harbor.json")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("run", help="run the daemon (default)")
    sub.add_parser("check-config", help="validate configuration and exit")
    b = sub.add_parser("baseline", help="record currently mounted volumes as server volumes")
    b.add_argument("--include-removable", action="store_true",
                   help="also pin currently attached USB drives (e.g. a permanent backup disk)")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        cfg = config_mod.load(args.config)
    except (OSError, ValueError) as e:
        print("config error: %s" % e, file=sys.stderr)
        return 2
    if not cfg.approved_roots:
        print("warning: approved_roots is empty; every ticket will be rejected", file=sys.stderr)

    if args.cmd == "check-config":
        print("config ok")
        return 0
    if args.cmd == "baseline":
        cfg.ensure_dirs()
        entries = MountDetector(cfg).snapshot_baseline(args.include_removable)
        print("baseline recorded: %d mounts" % len(entries))
        return 0

    d = Daemon(cfg)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: d.stop_event.set())
    d.run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
