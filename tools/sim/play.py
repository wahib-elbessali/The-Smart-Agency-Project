"""Play a scenario file: one w.py command per line, with waits.

    python tools/sim/play.py tools/sim/scenarios/demo_day.txt

Lines:
  # comment                       ignored
  wait 5                          pause 5 real seconds
  say Text shown to the tester    printed, e.g. "watch the Alerts screen"
  pause                           wait for Enter (give the tester time to look)
  anything else                   a w.py command, e.g. "add Visitor1 visitor door waiting"

Stops at the first command that fails (an error in its answer).
"""
import json
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def run(line):
    out = subprocess.run([sys.executable, os.path.join(HERE, "w.py"), *shlex.split(line)],
                         capture_output=True, text=True)
    text = (out.stdout or out.stderr).strip()
    print(f"  > {line}\n    {text[:300]}")
    try:
        answer = json.loads(text.splitlines()[-1]) if text else {}
    except ValueError:
        answer = {}
    if out.returncode != 0 or (isinstance(answer, dict) and answer.get("error")):
        sys.exit(f"stopped: {line!r} failed")


def main(path):
    for raw in open(path, encoding="utf-8"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        word, _, rest = line.partition(" ")
        if word == "wait":
            time.sleep(float(rest or 1))
        elif word == "say":
            print(f"\n== {rest}")
        elif word == "pause":
            input("  (press Enter to continue) ")
        else:
            run(line)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
