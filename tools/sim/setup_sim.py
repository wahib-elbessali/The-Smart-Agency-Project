"""Prepare a branch for the live world mock.

    python tools/sim/setup_sim.py devices   # 1. before starting world.py
    python tools/sim/setup_sim.py vision    # 2. with world.py running
    python tools/sim/setup_sim.py rooms     # refresh the badge room list for w.py

devices  Finds the branch, registers the four simulated devices (kiosk, gate
         reader, queue display, door/sensor board) or gives existing ones a new
         key, and writes tools/sim/sim_config.json (agency, device ids and
         keys, URLs). world.py and w.py read that file. A board marked real
         ("w.py real kiosk on", before this step) is left alone.
vision   Adds cameras cam1..cam4 if missing, calibrates cam1 and cam2 on the
         world's floor rectangle, aligns them, registers them for people
         tracking, draws the world zones (Gate, Kiosk zone, Waiting area,
         Counter 1/2 desk zone), sets the branch's kiosk zone and face camera,
         the gate reader's badge zone, and a workstation per counter desk.
         Everything goes through the backend's own API, so it is exactly what
         a person would do in the dashboard.
rooms    Reads the branch's badge rooms into sim_config.json (for "w.py door").

Login: --email/--password, or SIM_ADMIN_EMAIL / SIM_ADMIN_PASSWORD (an ADMIN,
or a MANAGER of the branch). Branch: --agency NAME (part of it), default the
first active one. Development data only: rotating a device key takes the
real device with that id offline. See docs/mocking-guide.md.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.environ.get("SIM_CONFIG", os.path.join(HERE, "sim_config.json"))

DEVICES = {  # role -> (mqtt_client_id, name, device_type)
    "kiosk": ("ticket-kiosk-01", "Borne tickets", "TICKET_KIOSK"),
    "gate": ("rfid-gate-01", "Portique badge", "RFID_READER"),
    "display": ("queue-display-01", "Afficheur file", "QUEUE_DISPLAY"),
    "door": ("access-sensors-1", "Capteurs + porte", "ACCESS_SENSORS"),
}
CAMERAS = {  # name -> detections it runs
    "cam1": ["weapon", "fire"],
    "cam2": ["weapon", "fire"],
    "cam3": ["wanted", "emotion"],  # kiosk face camera
    "cam4": [],  # door camera, badge + face rooms only
}
STREAM = "rtsp://127.0.0.1:8554/{}"
# world zones: name -> (centre x, centre y, width, depth) in the world's metres
ZONES = {
    "Gate": (1.0, 7.2, 1.4, 1.2),
    "Kiosk zone": (2.5, 6.0, 1.2, 1.0),
    "Waiting area": (4.5, 5.4, 2.6, 1.8),
    "Counter 1 desk zone": (7.0, 1.4, 1.4, 1.4),
    "Counter 2 desk zone": (9.0, 1.4, 1.4, 1.4),
}
WORKSTATIONS = {"Guichet 1": "Counter 1 desk zone", "Guichet 2": "Counter 2 desk zone"}
# floor spots both cam1 and cam2 see, for alignment
SHARED = ["center", "waiting", "counter1", "counter2", "kiosk", "office3"]


class Api:
    def __init__(self, base, token=None):
        self.base, self.token = base.rstrip("/"), token

    def __call__(self, method, path, body=None, ok=(200, 201, 204)):
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(self.base + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            if e.code in ok:
                return None
            sys.exit(f"{method} {path} -> {e.code} {detail}")
        except urllib.error.URLError as e:
            sys.exit(f"{method} {self.base}{path}: {e.reason} (is it running?)")


def load():
    return json.load(open(CONFIG, encoding="utf-8")) if os.path.exists(CONFIG) else {}


def save(cfg):
    json.dump(cfg, open(CONFIG, "w", encoding="utf-8"), indent=1)
    print(f"wrote {CONFIG}")


def login(args):
    api = Api(args.backend)
    email = args.email or os.environ.get("SIM_ADMIN_EMAIL")
    password = args.password or os.environ.get("SIM_ADMIN_PASSWORD")
    if not email or not password:
        sys.exit("give --email and --password (or SIM_ADMIN_EMAIL / SIM_ADMIN_PASSWORD)")
    api.token = api("POST", "/api/auth/login", {"email": email, "password": password})["access_token"]
    return api


def agency(api, wanted):
    agencies = [a for a in api("GET", "/api/agencies") if a.get("is_active", True)]
    if wanted:
        agencies = [a for a in agencies if wanted.lower() in a["name"].lower()]
    if not agencies:
        sys.exit("no matching active branch")
    a = agencies[0]
    print(f"branch: {a['name']} ({a['id']})")
    return a


def cmd_devices(args):
    api = login(args)
    a = agency(api, args.agency)
    cfg = load()
    known = {d["mqtt_client_id"]: d for d in api("GET", "/api/devices") if d["agency_id"] == a["id"]}
    devices = {}
    real = cfg.get("real", {})
    for role, (client_id, name, dtype) in DEVICES.items():
        if real.get(role):  # its key is flashed on the board: rotating it would take the board offline
            if client_id not in known:
                print(f"  {client_id}: REAL, not registered yet: add it on the Devices page and flash its key")
            else:
                print(f"  {client_id}: REAL, left as it is")
            devices[role] = {"id": client_id, "device_uuid": (known.get(client_id) or {}).get("id")}
            continue
        if client_id in known:
            reg = api("POST", f"/api/devices/{known[client_id]['id']}/rotate-key")
            print(f"  {client_id}: existing device, new key")
        else:
            reg = api("POST", f"/api/devices/agencies/{a['id']}",
                      {"name": name, "device_type": dtype, "mqtt_client_id": client_id})
            print(f"  {client_id}: registered")
        devices[role] = {"id": client_id, "key": reg["device_key"], "device_uuid": reg["id"]}
    cfg.update(agency_id=a["id"], agency_name=a["name"], devices=devices, backend_url=args.backend,
               world_url=args.world, real_ai_url=args.real_ai, mqtt_host=args.mqtt_host, mqtt_port=args.mqtt_port)
    save(cfg)
    print("next: start world.py, point the backend's AI_SERVICE_URL at it, then run: setup_sim.py vision")


def cmd_rooms(args, api=None, cfg=None):
    api = api or login(args)
    cfg = cfg or load()
    rooms = api("GET", f"/api/agencies/{cfg['agency_id']}/access-zones")
    cfg["badge_rooms"] = {r["name"]: r["id"] for r in rooms}
    save(cfg)
    print("  badge rooms:", ", ".join(cfg["badge_rooms"]) or "none yet (create them on the branch page)")


def cmd_vision(args):
    cfg = load()
    if "agency_id" not in cfg:
        sys.exit("run setup_sim.py devices first")
    api = login(args)
    world = Api(cfg.get("world_url", args.world))
    aid = cfg["agency_id"]
    geo = world("GET", "/_sim/geometry")
    img_w, img_h = geo["image"]

    cams = {c["name"]: c for c in api("GET", f"/api/agencies/{aid}/cameras")}
    for name, features in CAMERAS.items():
        if name not in cams:
            cams[name] = api("POST", f"/api/agencies/{aid}/cameras",
                             {"name": name, "stream_url": STREAM.format(name), "ai_features": features})
            print(f"  camera {name}: added")
    cid = {name: cams[name]["id"] for name in CAMERAS}

    for name in ("cam1", "cam2"):
        api("POST", "/api/calibration/rect", {"camera_id": cid[name], "points": geo["cameras"][name]["rect_px"],
                                              "img_w": img_w, "img_h": img_h})
        print(f"  {name}: calibrated on the 1.5 m x 1 m floor rectangle")

    places = geo["places"]
    seen = {cam: world("POST", "/_sim/project", {"camera": cam, "points": [places[p] for p in SHARED]})["points"]
            for cam in ("cam1", "cam2")}
    points = [{cid["cam1"]: a["px"], cid["cam2"]: b["px"]}
              for a, b in zip(seen["cam1"], seen["cam2"]) if a["seen"] and b["seen"]]
    api("POST", "/api/calibration/align", {"points": points})
    print(f"  cam1 + cam2: aligned on {len(points)} shared floor points")

    api("POST", "/api/people/sources", {"camera_ids": [cid["cam1"], cid["cam2"]]})
    print("  people tracking: cam1 + cam2 registered")

    for zone, (x, y, w, d) in ZONES.items():
        corners = [[x - w / 2, y - d / 2], [x + w / 2, y - d / 2], [x + w / 2, y + d / 2], [x - w / 2, y + d / 2]]
        px = [p["px"] for p in world("POST", "/_sim/project", {"camera": "cam1", "points": corners})["points"]]
        api("POST", "/api/zones", {"name": zone, "camera_id": cid["cam1"], "polygon": px,
                                   "extra_camera_ids": [cid["cam2"]]})
        print(f"  zone {zone}: drawn")

    api("PUT", f"/api/agencies/{aid}", {"kiosk_zone_name": "Kiosk zone", "kiosk_face_camera_id": cid["cam3"]})
    gate = cfg["devices"]["gate"].get("device_uuid")
    if gate:
        api("PUT", f"/api/devices/{gate}", {"badge_zone_name": "Gate"})
    print("  kiosk zone + face camera set; gate reader badge zone = Gate")

    have = {w["name"] for w in api("GET", "/api/workstations")}
    for name, zone in WORKSTATIONS.items():
        if name not in have:
            api("POST", "/api/workstations", {"name": name, "zone": zone})
            print(f"  workstation {name} -> {zone}")

    cmd_rooms(args, api, cfg)
    print("done: open the Live map; python tools/sim/w.py add Visitor1 visitor door waiting")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("step", choices=["devices", "vision", "rooms"])
    p.add_argument("--email")
    p.add_argument("--password")
    p.add_argument("--agency", help="part of the branch name (default: first active branch)")
    p.add_argument("--backend", default=os.environ.get("SIM_BACKEND_URL", "http://127.0.0.1:8000"))
    p.add_argument("--world", default=os.environ.get("SIM_WORLD_URL", "http://127.0.0.1:8123"))
    p.add_argument("--real-ai", default=os.environ.get("SIM_REAL_AI_URL", "http://127.0.0.1:8001"))
    p.add_argument("--mqtt-host", default=os.environ.get("SIM_MQTT_HOST", "127.0.0.1"))
    p.add_argument("--mqtt-port", type=int, default=int(os.environ.get("SIM_MQTT_PORT", 1883)))
    args = p.parse_args()
    {"devices": cmd_devices, "vision": cmd_vision, "rooms": cmd_rooms}[args.step](args)


if __name__ == "__main__":
    main()
