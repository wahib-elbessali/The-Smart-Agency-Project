"""Play a scenario file: one w.py command per line, with waits.

    python tools/sim/play.py tools/sim/scenarios/full_day.txt
    python tools/sim/play.py tools/sim/scenarios/full_day.txt --from "Opening"

Lines:
  # comment                       ignored
  section NAME                    a part of the scenario; --from NAME starts there
  say Text shown to the tester    printed, e.g. "watch the Alerts screen"
  do Something to do by hand      printed, then waits for Enter (e.g. "calibrate cam1")
  pause                           wait for Enter (give the tester time to look)
  wait 5                          pause 5 real seconds
  clock HH:MM                     moves the backend's fake clock; on the real
                                  clock it only says the story's time
  COMMAND >> what to do for real  a w.py command, e.g. "kiosk Karim VIR >> press
                                  Virement on the kiosk"

Simulated or real ("w.py real"): a command runs in the world when the part it
plays is simulated. When that part is real (cameras for people, fire and the
AI service; kiosk, gate, display, door for their commands; door for sensors),
the text after ">>" is shown as what to do in real life and the player waits
for Enter; a real command with no ">>" text is skipped (the line before it
already said what to do).

A failing command asks: retry, skip or quit.
"""
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_FILE = os.environ.get("SIM_CONFIG", os.path.join(HERE, "sim_config.json"))
# which part of the branch plays each command (anything else: the cameras)
ROLE = {"kiosk": "kiosk", "gate": "gate", "door": "door", "callnext": "display", "sensor": "door"}


def config():
    try:
        return json.load(open(CFG_FILE, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def fake_clock():
    """True when the backend runs on run_fake_clock.py (it then answers /_sim/clock)."""
    base = os.environ.get("SIM_BACKEND_URL", config().get("backend_url", "http://127.0.0.1:8000"))
    try:
        with urllib.request.urlopen(base + "/_sim/clock", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def ask(prompt):
    try:
        return input(prompt).strip().lower()
    except EOFError:
        return "q"


def run(line):
    while True:
        out = subprocess.run([sys.executable, os.path.join(HERE, "w.py"), *shlex.split(line)],
                             capture_output=True, text=True)
        text = (out.stdout or out.stderr).strip()
        print(f"  > {line}\n    {text[:300]}")
        try:
            answer = json.loads(text.splitlines()[-1]) if text else {}
        except ValueError:
            answer = {}
        failed = out.returncode != 0 or (isinstance(answer, dict) and (
            answer.get("error") or (isinstance(answer.get("status"), int) and answer["status"] >= 300)))
        if not failed:
            return
        choice = ask("  failed: [r]etry, [s]kip, [q]uit? ")
        if choice == "s":
            return
        if choice != "r":
            sys.exit(f"stopped at: {line}")


def main(path, start=None):
    flags = config().get("real", {})
    on_fake_clock = fake_clock()
    print("Simulated or real:", ", ".join(f"{r} {'REAL' if flags.get(r) else 'sim'}"
                                          for r in ("cameras", "kiosk", "gate", "display", "door")))
    print("Clock:", "fake (the story's times are applied)" if on_fake_clock else "real (story times are only shown)")
    skipping = start is not None
    for raw in open(path, encoding="utf-8"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        word, _, rest = line.partition(" ")
        if word == "section":
            if skipping and start.lower() in rest.lower():
                skipping = False
            if not skipping:
                print(f"\n######## {rest}")
            continue
        if skipping:
            continue
        if word == "wait":
            time.sleep(float(rest or 1))
        elif word == "say":
            print(f"\n== {rest}")
        elif word == "do":
            print(f"\n>> TO DO: {rest}")
            ask("   (press Enter when done) ")
        elif word == "pause":
            ask("  (press Enter to continue) ")
        elif word == "clock":
            if on_fake_clock:
                run(line)
            else:
                print(f"  (story time {rest})")
        else:
            command, _, by_hand = line.partition(">>")
            role = ROLE.get(command.split()[0], "cameras")
            if config().get("real", {}).get(role):  # re-read: it can change while the scenario runs
                if by_hand.strip():
                    print(f"\n>> REAL {role}: {by_hand.strip()}")
                    ask("   (press Enter when done) ")
            else:
                run(command.strip())
    if skipping:
        sys.exit(f"no section matches {start!r}")


if __name__ == "__main__":
    args = sys.argv[1:]
    start = None
    if "--from" in args:
        i = args.index("--from")
        if i + 1 >= len(args):
            sys.exit("--from needs a section name")
        start = args[i + 1]
        del args[i:i + 2]
    if len(args) != 1:
        sys.exit(__doc__)
    main(args[0], start)
