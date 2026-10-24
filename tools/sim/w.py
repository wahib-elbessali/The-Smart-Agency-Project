"""Drive the live world (tools/sim/world.py).  python w.py <op> ...

People
  add NAME [visitor|employee] [AT] [TO] [rfid=..] [face=..]   appears at AT, walks to TO
  move NAME PLACE        teleport NAME PLACE        leave NAME        remove NAME
  set NAME weapon=pistol|knife|none emotion=Anger|none wanted=NAME|none face=NAME|none
  lose NAME [seconds] [to=PLACE]      the tracker drops them; they come back as a new track
Devices
  kiosk NAME|- SERVICE   a visitor (or nobody, "-") presses the kiosk button for SERVICE (code or name)
  callnext SERVICE       the counter's call-next button
  gate NAME|RFID         a badge at the gate reader
  door NAME|RFID ROOM    a badge at a badge room's door (ROOM: name, or part of it)
  sensor temperature=33 gas_co=25 [jump] [now]     drift (or jump) the sensors to these values
Events
  fire PLACE [smoke]  |  fire clear
  ai down|up             the AI service stops / comes back
Simulated or real (the world stops playing what is real)
  real                   show what is simulated and what is real
  real PART on|off       PART: cameras, kiosk, gate, display, door (several: real kiosk=on gate=on)
Clock (backend started with run_fake_clock.py)
  clock                  show the backend's time
  clock HH:MM            move it to HH:MM today, in this computer's timezone
Inspect
  state     log [SINCE]  places

PLACE is a named spot (see "places") or zone:ZONE NAME for the middle of a drawn zone.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_FILE = os.environ.get("SIM_CONFIG", os.path.join(HERE, "sim_config.json"))
CFG = json.load(open(CFG_FILE, encoding="utf-8")) if os.path.exists(CFG_FILE) else {}
WORLD = os.environ.get("SIM_WORLD_URL", CFG.get("world_url", "http://127.0.0.1:8123"))
BACKEND = os.environ.get("SIM_BACKEND_URL", CFG.get("backend_url", "http://127.0.0.1:8000"))


def call(base, path, body=None):
    req = urllib.request.Request(base + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except ValueError:
            return {"status": e.code}


def kv(args):
    out = {}
    for a in args:
        k, v = a.split("=", 1)
        out[k] = None if v.lower() == "none" else v
    return out


def badge_room(text):
    rooms = CFG.get("badge_rooms", {})
    hits = [(name, rid) for name, rid in rooms.items() if text.lower() in name.lower()]
    if len(hits) != 1:
        sys.exit(f"badge room {text!r} not found or ambiguous; known: {', '.join(rooms) or 'none (run setup_sim.py rooms)'}")
    return hits[0]


def clock(args):
    if not args:
        return call(BACKEND, "/_sim/clock")
    h, m = (int(x) for x in args[0].split(":"))
    now = datetime.fromisoformat(call(BACKEND, "/_sim/clock")["now"])
    local = now.astimezone().replace(hour=h, minute=m, second=0, microsecond=0)
    return call(BACKEND, "/_sim/clock", {"to": local.astimezone(timezone.utc).isoformat()})


ROLES = ("cameras", "kiosk", "gate", "display", "door")


def real(args):
    """Show or change sim_config.json's "real" section (what the world must not play)."""
    cfg = json.load(open(CFG_FILE, encoding="utf-8")) if os.path.exists(CFG_FILE) else {}
    flags = cfg.setdefault("real", {})
    pairs = dict(x.split("=", 1) for x in args if "=" in x)
    if len(args) == 2 and "=" not in args[0]:
        pairs = {args[0]: args[1]}
    for role, v in pairs.items():
        if role not in ROLES or v not in ("on", "off"):
            sys.exit(f"real {role} {v}: PART is one of {', '.join(ROLES)}, then on or off")
        flags[role] = v == "on"
    if pairs:
        json.dump(cfg, open(CFG_FILE, "w", encoding="utf-8"), indent=1)
    for role in ROLES:
        print(f"  {role:8} {'REAL' if flags.get(role) else 'simulated'}")


def main(a):
    if not a:
        sys.exit(__doc__)
    op = a[0]
    if op == "state":
        return print(json.dumps(call(WORLD, "/_sim/state"), indent=1, ensure_ascii=False))
    if op == "log":
        for n, t, text in call(WORLD, f"/_sim/log?since={a[1] if len(a) > 1 else 0}"):
            print(n, t, text)
        return
    if op == "places":
        return print(", ".join(call(WORLD, "/_sim/geometry")["places"]))
    if op == "clock":
        return print(json.dumps(clock(a[1:])))
    if op == "real":
        return real(a[1:])

    pos = [x for x in a[1:] if "=" not in x]
    extra = kv([x for x in a[1:] if "=" in x])
    if op == "add":
        body = {"op": "add", "name": pos[0], "kind": pos[1] if len(pos) > 1 else "visitor", **extra}
        if len(pos) > 2:
            body["at"] = pos[2]
        if len(pos) > 3:
            body["to"] = pos[3]
    elif op in ("move", "teleport"):
        body = {"op": op, "name": pos[0], "to": pos[1]}
    elif op in ("leave", "remove"):
        body = {"op": op, "name": pos[0]}
    elif op == "set":
        body = {"op": "set", "name": pos[0], **extra}
    elif op == "kiosk":
        body = {"op": "kiosk", "name": pos[0] if pos[0] != "-" else None, "service": pos[1]}
    elif op == "callnext":
        body = {"op": "callnext", "service": pos[0]}
    elif op in ("gate", "door"):
        who = pos[0]
        body = {"op": op, ("rfid" if who.upper().startswith("RFID") else "name"): who}
        if op == "door":
            name, room_id = badge_room(" ".join(pos[1:]))
            body.update(zone_id=room_id, zone_name=name)
    elif op == "fire":
        body = {"op": "fire", "clear": True} if pos[0] == "clear" else {"op": "fire", "at": pos[0], "kind": pos[1] if len(pos) > 1 else "fire"}
    elif op == "sensor":
        body = {"op": "sensor", **{k: float(v) for k, v in extra.items()}, "jump": "jump" in pos, "publish_now": "now" in pos}
    elif op == "lose":
        body = {"op": "lose", "name": pos[0], "seconds": float(pos[1]) if len(pos) > 1 else 1.0, **extra}
    elif op == "ai":
        body = {"op": "ai_down", "down": pos[0] == "down"}
    else:
        sys.exit(__doc__)
    print(json.dumps(call(WORLD, "/_sim/cmd", body), ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
