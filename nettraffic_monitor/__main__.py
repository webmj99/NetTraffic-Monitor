"""NetTraffic-Monitor entry point: python -m nettraffic_monitor (see --help)."""
import argparse
import ctypes
import json
import os
import subprocess
import sys
import threading
import webbrowser

from .collector import Collector
from .maintenance import Maintenance
from .netclass import Classifier
from .server import serve
from .store import Store

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except OSError:
        return False


def relaunch_elevated():
    params = subprocess.list2cmdline(["-m", "nettraffic_monitor", *sys.argv[1:]])
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, params, ROOT, 1)
    if rc <= 32:
        print("Administrator rights were denied - NetTraffic-Monitor needs them for the ETW network trace.")
        sys.exit(1)
    sys.exit(0)


def load_config(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    return {}


def main(argv=None, stop_event=None):
    """stop_event (threading.Event) lets the Windows service host end the loop instead of Ctrl+C."""
    stop_event = stop_event or threading.Event()
    ap = argparse.ArgumentParser(prog="nettraffic_monitor")
    ap.add_argument("--port", type=int, help="overrides \"port\" in config.json (default 8765)")
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "nettraffic-monitor.db"))
    ap.add_argument("--config", default=os.path.join(ROOT, "config.json"))
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--no-autostart", action="store_true")
    args = ap.parse_args(argv)

    if not is_admin():
        relaunch_elevated()

    cfg = load_config(args.config)
    port = args.port or int(cfg.get("port", 8765))
    os.makedirs(os.path.dirname(os.path.abspath(args.db)), exist_ok=True)
    store = Store(args.db)
    collector = Collector(store, Classifier(cfg.get("internal_networks", [])))
    httpd = serve(collector, store, Maintenance(store), port)
    url = f"http://127.0.0.1:{port}/"
    print(f"NetTraffic-Monitor running: {url}  (database: {os.path.abspath(args.db)})")
    print("Press Ctrl+C to quit NetTraffic-Monitor.")

    if not args.no_autostart:
        try:
            collector.start()
            print("Monitoring started.")
        except OSError as e:
            print(f"Monitoring could not start: {e}")
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, (url,)).start()

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        while not stop_event.wait(1):
            pass
    except KeyboardInterrupt:
        pass
    finally:
        print("Shutting down ...")
        collector.stop()
        store.flush()
        httpd.shutdown()


if __name__ == "__main__":
    main()
