"""Live world mock: a simulated branch the real backend talks to.

Run it where the backend expects the AI service (set the backend's
AI_SERVICE_URL to this process, e.g. http://127.0.0.1:8123):

- AI: everything that needs real video is simulated from a small world of
  people walking around a 12 m x 8 m branch floor, seen by pinhole cameras
  cam1 (entrance wall) and cam2 (side wall), cam3 (kiosk face camera) and
  cam4 (door camera). The live streams, /frame, /face/scan, /face/capture,
  /people/status and workstation status come from here. Everything else
  (cameras, calibration, zones, workstations, face gallery, watchlist,
  config) is proxied to the REAL AI service (SIM_REAL_AI_URL), so setup done
  in the dashboard is real.
- IoT: the devices keep living. Sensors publish every 30 s drifting toward a
  target, the kiosk polls its config, and every device listens on its MQTT
  topics (7-segment display, buzzer, fan, door, manual-control acks).

Configuration: sim_config.json next to this file (written by setup_sim.py),
overridable with SIM_CONFIG, SIM_REAL_AI_URL, SIM_BACKEND_URL, SIM_MQTT_HOST,
SIM_MQTT_PORT.

Simulated or real: sim_config.json's "real" section ("w.py real kiosk on")
marks the cameras or a board (kiosk, gate, display, door) as real. The world
then stops playing it: no sensor readings, kiosk polling or MQTT acks for a
real board, and the commands that would play it are refused. Read live, so it
can change while the world runs.

Control: POST /_sim/cmd, GET /_sim/state, GET /_sim/log (driven by w.py),
GET /_sim/geometry and POST /_sim/project (used by setup_sim.py).
See docs/mocking-guide.md.
"""
import asyncio, base64, hashlib, json, math, os, random, threading, time
from datetime import datetime, timedelta, timezone

import cv2
import httpx
import numpy as np
import paho.mqtt.client as mqtt
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_FILE = os.environ.get("SIM_CONFIG", os.path.join(HERE, "sim_config.json"))
CFG = json.load(open(CFG_FILE, encoding="utf-8"))
REAL_AI = os.environ.get("SIM_REAL_AI_URL", CFG.get("real_ai_url", "http://127.0.0.1:8001"))
BACKEND = os.environ.get("SIM_BACKEND_URL", CFG.get("backend_url", "http://127.0.0.1:8000"))
MQTT_HOST = os.environ.get("SIM_MQTT_HOST", CFG.get("mqtt_host", "127.0.0.1"))
MQTT_PORT = int(os.environ.get("SIM_MQTT_PORT", CFG.get("mqtt_port", 1883)))
AGENCY = CFG["agency_id"]
# role -> {"id": mqtt_client_id, "key": device key}
KIOSK, GATE, DISPLAY, DOOR = (CFG["devices"][r]["id"] for r in ("kiosk", "gate", "display", "door"))
KEYS = {d["id"]: d.get("key") for d in CFG["devices"].values()}  # a real board's key is not ours
ROLES = ("cameras", "kiosk", "gate", "display", "door")
_real = {"mtime": None, "flags": {}}


def is_real(role):
    """Whether the cameras / a board are the real thing (sim_config.json "real"),
    re-read when the file changes."""
    try:
        m = os.path.getmtime(CFG_FILE)
        if m != _real["mtime"]:
            _real["flags"] = json.load(open(CFG_FILE, encoding="utf-8")).get("real", {})
            _real["mtime"] = m
    except (OSError, ValueError):
        pass
    return bool(_real["flags"].get(role))


ROLE_OF = {KIOSK: "kiosk", GATE: "gate", DISPLAY: "display", DOOR: "door"}
W, H = 1280, 720
ROOM = (12.0, 8.0)  # metres

# ---------------------------------------------------------------- geometry
PLACES = {
    "outside": (1.0, 9.5), "door": (1.0, 7.6), "entrance": (1.0, 7.0),
    "kiosk": (2.5, 6.0), "waiting": (4.5, 5.0), "waiting2": (5.0, 5.8), "waiting3": (4.0, 6.2),
    "counter1": (7.0, 2.6), "desk1": (7.0, 1.0),
    "counter2": (9.0, 2.6), "desk2": (9.0, 1.0),
    "office3": (10.5, 4.5), "desk3": (11.4, 4.5),
    "office4": (10.5, 6.5), "desk4": (11.4, 6.5),
    "bureau": (1.0, 1.0), "technique": (3.0, 1.0), "center": (6.0, 4.0),
    "bureau_door": (1.6, 1.6),
}
LABELS = {"kiosk": "BORNE", "counter1": "GUICHET 1", "counter2": "GUICHET 2", "office3": "BUREAU 3",
          "office4": "BUREAU 4", "door": "ENTREE", "bureau": "DIRECTION", "technique": "LOCAL TECH",
          "waiting": "ATTENTE"}
RECT = [(5.25, 3.5), (6.75, 3.5), (6.75, 4.5), (5.25, 4.5)]  # 1.5 m x 1 m: short side is exactly 1 m
CAMS = {  # real pinhole cameras (principal point at the image centre, square pixels) on two different walls
    "cam1": {"xr": (0, 12), "pos": (6.3, 12.0, 10.0), "look": (6.0, 4.0, 0.0)},   # entrance wall, looking in
    "cam2": {"xr": (0, 12), "pos": (15.5, 4.4, 12.0), "look": (6.0, 4.0, 0.0)},   # right side wall, looking across
    # Kiosk camera: head height, a metre behind the kiosk, facing the people
    # standing at it - the one camera that sees faces well. Only covers the
    # few metres in front of it.
    "cam3": {"xr": (1.0, 4.0), "yr": (3.6, 7.6), "pos": (2.5, 2.6, 2.2), "look": (2.5, 6.5, 0.9), "f": 560},
    # Door camera of the director's office: face height, facing whoever
    # stands at that door to badge. Only used on demand (/face/scan).
    "cam4": {"xr": (0.0, 2.6), "yr": (0.0, 2.6), "pos": (2.9, 2.9, 2.0), "look": (1.0, 1.0, 1.0), "f": 520},
}


def _pinhole(pos, look, f=None):
    C, T = np.array(pos, float), np.array(look, float)
    fwd = (T - C) / np.linalg.norm(T - C)
    right = np.cross(fwd, [0, 0, 1.0]); right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.vstack([right, down, fwd]); t = -R @ C
    if f is None:  # frame the whole room
        corners = [R @ np.array([x, y, z]) + t for x in (0, 12) for y in (0, 8) for z in (0,)]
        f = min(610 / max(abs(c[0] / c[2]) for c in corners), 340 / max(abs(c[1] / c[2]) for c in corners))
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])
    return K @ np.hstack([R, t[:, None]])  # 3x4


for c in CAMS.values():
    c["P"] = _pinhole(c["pos"], c["look"], c.get("f"))
    c["rect"] = RECT


def proj(cam, x, y, z=0.0):
    v = CAMS[cam]["P"] @ np.array([x, y, z, 1.0])
    return float(v[0] / v[2]), float(v[1] / v[2])


def yrange(cam):
    return CAMS[cam].get("yr", (0, ROOM[1]))


def sees(cam, x, y):
    lo, hi = CAMS[cam]["xr"]
    ylo, yhi = yrange(cam)
    return lo - 0.3 <= x <= hi + 0.3 and ylo - 0.3 <= y <= yhi + 0.3


def px_height(cam, x, y, metres=1.7):
    a, b = proj(cam, x, y), proj(cam, x, y, metres)
    return math.hypot(b[0] - a[0], b[1] - a[1])


# ---------------------------------------------------------------- state
LOCK = threading.RLock()  # re-entrant: tick() logs while holding it
LOG = []          # [(n, fake_time, text)]
people = {}       # name -> dict
fires = []        # [{"at": (x,y), "kind": "fire"}]
next_track = [1]
sensors = {"temperature": [22.0, 22.0, "C"], "humidity": [45.0, 45.0, "%"], "gas_co": [2.0, 2.0, "ppm"]}  # value, target
devices = {"display": {}, "buzzer": {}, "fan": False, "door": "locked", "acks": 0}
ai_down = [False]
real = {"zones": {}, "calib": {}, "cameras": {}, "workstations": [], "people_sources": {}, "absence": 300.0,
        # the REAL service's live detection thresholds (GET /config), so a
        # threshold changed in the app actually hides weaker detections here
        "thresholds": {"weapon": 0.25, "fire": 0.25, "wanted": 0.5},
        # names in the REAL face gallery (employees enrolled for badge + face doors)
        "face_gallery": set()}
clock_offset = [0.0]  # backend fake clock - real clock, seconds
clock_synced = threading.Event()  # devices must not publish real-time stamps before the first sync
LOCAL_TZ = datetime.now().astimezone().tzinfo  # this PC's timezone, what the browser shows


def fake_now():
    return datetime.now(timezone.utc) + timedelta(seconds=clock_offset[0])


def log(text):
    with LOCK:
        LOG.append((len(LOG) + 1, fake_now().astimezone(LOCAL_TZ).strftime("%H:%M:%S"), text))
    print("[world]", text, flush=True)


def fake_epoch():
    return time.time() + clock_offset[0]


def zone_centre(name):
    """Middle of a zone the user drew, back in simulated metres: its pixel
    outline's centroid through the inverse floor projection of that camera."""
    z = real["zones"].get(name) or next((v for k, v in real["zones"].items() if k.lower() == name.lower()), None)
    if not z:
        raise ValueError(f"unknown zone {name!r}; known: {', '.join(real['zones'])}")
    cf = z.get("converted_from") or {}
    cam, poly = (cf.get("camera"), cf.get("polygon_px")) if cf else (z.get("camera"), z.get("polygon_px"))
    if cam not in CAMS or not poly:
        raise ValueError(f"zone {name!r} has no pixel outline on cam1/cam2")
    u = sum(p[0] for p in poly) / len(poly); v = sum(p[1] for p in poly) / len(poly)
    P = CAMS[cam]["P"]; Hf = np.column_stack([P[:, 0], P[:, 1], P[:, 3]])
    w = np.linalg.inv(Hf) @ np.array([u, v, 1.0])
    return float(w[0] / w[2]), float(w[1] / w[2])


def place(p):
    if isinstance(p, (list, tuple)):
        return float(p[0]), float(p[1])
    if isinstance(p, str) and p.startswith("zone:"):
        return zone_centre(p[5:])
    if p not in PLACES:
        raise ValueError(f"unknown place {p!r}; known: {', '.join(PLACES)}")
    return PLACES[p]


def embedding_for(name):
    rng = np.random.default_rng(int(hashlib.sha256(name.lower().encode()).hexdigest()[:8], 16))
    v = rng.normal(size=512)
    return (v / np.linalg.norm(v)).round(6).tolist()


def in_room(p):
    return 0 <= p["x"] <= ROOM[0] and 0 <= p["y"] <= ROOM[1]


# ---------------------------------------------------------------- AI-world mapping (via the REAL calibration)
def calib_entry(cam):
    e = real["calib"].get(cam)
    return e if isinstance(e, dict) and e.get("Hinv") else None


def is_aligned(cam):
    e = calib_entry(cam)
    if not e:
        return False
    d = e.get("diagnostics") or {}
    return bool(d.get("aligned", e.get("aligned")))


def ai_world(x, y):
    """Simulated metres -> the AI service's own floor frame (cm), through a
    camera's pixels and its real Hinv, exactly like a real detection."""
    for cam in CAMS:
        if sees(cam, x, y) and is_aligned(cam):
            u, v = proj(cam, x, y)
            r = np.array(calib_entry(cam)["Hinv"], dtype=float) @ np.array([u, v, 1.0])
            return float(r[0] / r[2]), float(r[1] / r[2])
    return None


def people_phase():
    known = set(real["people_sources"].get("sources_known") or [])
    ok = [c for c in CAMS if c in known and is_aligned(c)]
    return ("running" if len(ok) >= 2 else "idle"), ok


def point_in_poly(x, y, poly):
    inside, n = False, len(poly)
    for i in range(n):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-9) + x1:
            inside = not inside
        if abs((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) < 1e-6 and min(x1, x2) <= x <= max(x1, x2) and min(y1, y2) <= y <= max(y1, y2):
            return True
    return inside


def zone_counts():
    phase, _ = people_phase()
    out = {}
    for name, z in real["zones"].items():
        if not isinstance(z, dict):
            continue
        pts = []
        if z.get("mode") == "world" or z.get("polygon_m"):
            ready = phase == "running"
            poly = [[a * 100, b * 100] for a, b in z.get("polygon_m") or []]
            if ready and len(poly) >= 3:
                for p in people.values():
                    if in_room(p):
                        w = ai_world(p["x"], p["y"])
                        if w and point_in_poly(w[0], w[1], poly):
                            pts.append([round(w[0], 1), round(w[1], 1)])
        else:
            ready, cam = True, z.get("camera")
            poly = z.get("polygon_px") or z.get("polygon") or []
            if cam in CAMS and len(poly) >= 3:
                for p in people.values():
                    if in_room(p) and sees(cam, p["x"], p["y"]):
                        u, v = proj(cam, p["x"], p["y"])
                        if point_in_poly(u, v, poly):
                            pts.append([round(u, 1), round(v, 1)])
        out[name] = {"count": len(pts), "points": pts, "people_tracking_ready": ready}
    return out


def bbox(cam, x, y):
    u, v = proj(cam, x, y)
    h = px_height(cam, x, y)
    return [round(u - h * 0.22, 1), round(v - h, 1), round(u + h * 0.22, 1), round(v, 1)]


def cam_features(cam):
    c = (real["cameras"].get("cameras") or {}).get(cam) or {}
    return set(c.get("features") or [])


def detections(feature):
    out = {}
    for cam in CAMS:
        if feature not in cam_features(cam):
            continue
        dets = []
        if feature == "fire":
            for f in fires:
                x, y = f["at"]
                if sees(cam, x, y):
                    u, v = proj(cam, x, y); s = px_height(cam, x, y, 1.0)
                    dets.append({"class": f["kind"], "confidence": f.get("conf", 0.78), "bbox": [round(u - s / 2, 1), round(v - s, 1), round(u + s / 2, 1), round(v, 1)]})
        else:
            for p in people.values():
                if not in_room(p) or not sees(cam, p["x"], p["y"]):
                    continue
                if feature == "weapon" and p.get("weapon"):
                    dets.append({"class": p["weapon"], "confidence": float(p.get("weapon_conf") or 0.86), "bbox": bbox(cam, p["x"], p["y"])})
                if feature == "emotion" and p.get("emotion"):
                    dets.append({"class": p["emotion"], "confidence": 0.55, "bbox": bbox(cam, p["x"], p["y"])})
                if feature == "wanted" and p.get("wanted"):
                    b = bbox(cam, p["x"], p["y"])
                    dets.append({"class": p["wanted"], "confidence": float(p.get("wanted_conf") or 0.612), "bbox": [b[0], b[1], b[2], b[1] + (b[3] - b[1]) * 0.18],
                                 "det_score": 0.88, "face_px": 94})
        # Like the real service: below the live threshold, nothing is reported.
        floor = real["thresholds"].get(feature)
        if floor is not None:
            dets = [d for d in dets if d["confidence"] >= floor]
        if feature == "wanted" and dets:
            dets[0]["snapshot"] = base64.b64encode(cv2.imencode(".jpg", cv2.resize(render(cam), (960, 540)), [cv2.IMWRITE_JPEG_QUALITY, 60])[1]).decode()
        out[cam] = dets
    return out


# ---------------------------------------------------------------- rendering
def render(cam):
    img = np.full((H, W, 3), 38, np.uint8)
    floor = np.int32([proj(cam, x, y) for x, y in [(0, 0), (12, 0), (12, 8), (0, 8)]])
    lo, hi = CAMS[cam]["xr"]
    ylo, yhi = yrange(cam)
    vis = np.int32([proj(cam, x, y) for x, y in [(lo, ylo), (hi, ylo), (hi, yhi), (lo, yhi)]])
    cv2.fillPoly(img, [vis], (70, 74, 78))
    for gx in range(math.ceil(lo), math.floor(hi) + 1):
        cv2.line(img, tuple(map(int, proj(cam, gx, ylo))), tuple(map(int, proj(cam, gx, yhi))), (95, 100, 105), 1)
    for gy in range(math.ceil(ylo), math.floor(yhi) + 1):
        cv2.line(img, tuple(map(int, proj(cam, lo, gy))), tuple(map(int, proj(cam, hi, gy))), (95, 100, 105), 1)
    rect = CAMS[cam]["rect"] if all(sees(cam, *p) for p in CAMS[cam]["rect"]) else []
    if rect:
        cv2.polylines(img, [np.int32([proj(cam, *p) for p in rect])], True, (0, 215, 255), 3)
    for i, p in enumerate(rect):
        u, v = proj(cam, *p)
        cv2.circle(img, (int(u), int(v)), 6, (0, 215, 255), -1)
        cv2.putText(img, f"R{i + 1}", (int(u) + 8, int(v) - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 215, 255), 2)
    for i, (mx, my) in enumerate([(1, 1), (6, 1), (11, 1), (1, 7), (6, 7), (11, 7)]):  # shared markers, seen by both cams
        if sees(cam, mx, my):
            u, v = proj(cam, mx, my)
            cv2.drawMarker(img, (int(u), int(v)), (255, 120, 255), cv2.MARKER_CROSS, 18, 3)
            cv2.putText(img, f"M{i + 1}", (int(u) + 8, int(v) + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 120, 255), 2)
    for key, label in LABELS.items():
        x, y = PLACES[key]
        if sees(cam, x, y):
            u, v = proj(cam, x, y)
            cv2.putText(img, label, (int(u) - 40, int(v) + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
    for f in fires:
        if sees(cam, *f["at"]):
            u, v = proj(cam, *f["at"]); s = int(px_height(cam, *f["at"], 1.0))
            cv2.ellipse(img, (int(u), int(v) - s // 2), (s // 3, s // 2), 0, 0, 360, (0, 100, 255) if f["kind"] == "fire" else (160, 160, 160), -1)
    cx_, cy_ = CAMS[cam]["pos"][:2]
    for p in sorted(people.values(), key=lambda p: -math.hypot(p["x"] - cx_, p["y"] - cy_)):  # far first
        if not in_room(p) or not sees(cam, p["x"], p["y"]):
            continue
        x1, y1, x2, y2 = map(int, bbox(cam, p["x"], p["y"]))
        col = (90, 200, 90) if p["kind"] == "employee" else (220, 150, 60)
        cv2.rectangle(img, (x1, y1 + (y2 - y1) // 5), (x2, y2), col, -1)
        cv2.circle(img, ((x1 + x2) // 2, y1 + (y2 - y1) // 10), max(4, (x2 - x1) // 3), (180, 200, 230), -1)
        if p.get("wanted"):
            cv2.rectangle(img, (x1 - 3, y1 - 3), (x2 + 3, y2 + 3), (0, 0, 255), 2)
        if p.get("weapon"):
            cv2.line(img, (x2, (y1 + y2) // 2), (x2 + (x2 - x1) // 2, (y1 + y2) // 2), (20, 20, 20), 4)
        cv2.putText(img, p["name"], (x1, y1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    cv2.putText(img, f"{cam}  {fake_now().astimezone(LOCAL_TZ).strftime('%Y-%m-%d %H:%M:%S')}",
                (16, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    return img


# ---------------------------------------------------------------- WS hub
class Hub:
    def __init__(self):
        self.subs = {}

    def add(self, key):
        q = asyncio.Queue()
        self.subs.setdefault(key, set()).add(q)
        return q

    def remove(self, key, q):
        self.subs.get(key, set()).discard(q)

    def send(self, key, msg):
        for q in list(self.subs.get(key, ())):
            q.put_nowait(msg)

    def kick_all(self):
        for qs in self.subs.values():
            for q in list(qs):
                q.put_nowait(None)


hub = Hub()
last = {"alerts": {f: {} for f in ("weapon", "fire", "emotion", "wanted")}, "zones": {}, "ws": {}, "phase": "idle"}
ws_state = {}  # workstation name -> {"status", "since", "empty_since"}


def workstation_rows():
    rows = []
    for w in real["workstations"]:
        st = ws_state.get(w["name"], {"status": "unknown", "since": fake_epoch()})
        rows.append({"name": w["name"], "zone": w["zone"], "status": st["status"], "since": st["since"],
                     "zone_known": w["zone"] in last["zones"]})
    return rows


def step_streams():
    for f in last["alerts"]:
        cur = detections(f)
        for cam, dets in cur.items():
            sig = sorted(d["class"] for d in dets)
            if sorted(d["class"] for d in last["alerts"][f].get(cam, [])) != sig:
                hub.send(f, {"type": "update", "camera": cam, "detections": dets})
                if dets or last["alerts"][f].get(cam):
                    log(f"AI {f} @ {cam}: {', '.join(sig) or 'all clear'}")
        last["alerts"][f] = cur
    zc = zone_counts()
    for name, z in zc.items():
        old = last["zones"].get(name)
        if old is None or old["count"] != z["count"] or old["people_tracking_ready"] != z["people_tracking_ready"]:
            hub.send("zoning", {"type": "update", "zone": name, **z})
    last["zones"] = zc
    now = fake_epoch()  # 'since' is read by the browser, which runs on the fake clock
    for w in real["workstations"]:
        z = zc.get(w["zone"])
        st = ws_state.setdefault(w["name"], {"status": "unknown", "since": now, "empty_since": None})
        if z is None:
            continue
        new = st["status"]
        if z["count"] > 0:
            st["empty_since"] = None; new = "present"
        else:
            st["empty_since"] = st["empty_since"] or now
            if now - st["empty_since"] >= real["absence"] or st["status"] == "unknown" and now - st["empty_since"] >= real["absence"]:
                new = "away"
        if new != st["status"]:
            st["status"], st["since"] = new, now
            row = next(r for r in workstation_rows() if r["name"] == w["name"])
            hub.send("ws", {"type": "update", **row})
            log(f"AI workstation {w['name']}: {new}")
    phase, cams = people_phase()
    if phase != last["phase"]:
        last["phase"] = phase
        hub.send("people", {"type": "state", **status_dict()})  # full status, as the real service sends
        log(f"AI people tracking: {phase}")
    if phase == "running":
        hub.send("people", tracks_msg(cams))


def tracks_msg(cams):
    tracks, boxes = [], {c: [] for c in cams}
    for p in people.values():
        if not in_room(p):
            continue
        # "lose": the tracker dropped this person; they come back as a new track
        if p.get("hidden_until", 0) > time.time():
            continue
        w = ai_world(p["x"], p["y"])
        if not w:
            continue
        if p.get("track") is None:
            p["track"] = next_track[0]; next_track[0] += 1
        p["hits"] = p.get("hits", 0) + 1
        tracks.append({"id": p["track"], "x": round(w[0], 1), "y": round(w[1], 1), "hits": p["hits"], "misses": 0})
        for c in cams:
            if sees(c, p["x"], p["y"]):
                boxes[c].append(bbox(c, p["x"], p["y"]))
    return {"type": "tracks", "tracks": tracks, "boxes": boxes}


# ---------------------------------------------------------------- app
app = FastAPI()
client = httpx.AsyncClient(base_url=REAL_AI, timeout=30)


async def poll_real():
    while True:
        try:
            for key, path in [("zones", "/zoning/zones"), ("calib", "/calibration"), ("cameras", "/cameras"),
                              ("workstations", "/employee_activity/workstations"), ("people_sources", "/people/sources")]:
                r = await client.get(path)
                if r.status_code == 200:
                    real[key] = r.json()
            r = await client.get("/face/faces")
            if r.status_code == 200:
                real["face_gallery"] = {e.get("name") for e in r.json()}
            r = await client.get("/config")
            if r.status_code == 200:
                cfg = r.json()["config"]
                real["absence"] = float(cfg["employee_activity"]["absence_seconds"])
                real["thresholds"] = {"weapon": float(cfg["weapon"]["conf"]), "fire": float(cfg["fire"]["conf"]),
                                      "wanted": float(cfg["wanted"]["threshold"])}
        except Exception as e:
            print("[world] real AI poll failed:", e, flush=True)
        try:
            async with httpx.AsyncClient(timeout=3) as b:
                r = await b.get(BACKEND + "/_sim/clock")
                if r.status_code == 404:  # backend on the real clock (not run_fake_clock.py)
                    clock_offset[0] = 0.0
                else:
                    clock_offset[0] = (datetime.fromisoformat(r.json()["now"]) - datetime.now(timezone.utc)).total_seconds()
                clock_synced.set()
        except Exception:
            pass
        await asyncio.sleep(2)


async def tick():
    n = 0
    while True:
        await asyncio.sleep(0.5)
        with LOCK:
            for p in list(people.values()):
                if p.get("target"):
                    tx, ty = p["target"]; dx, dy = tx - p["x"], ty - p["y"]; d = math.hypot(dx, dy); s = 0.6
                    if d <= s:
                        p["x"], p["y"], p["target"] = tx, ty, None
                        if p.get("leaving"):
                            del people[p["name"]]; log(f"{p['name']} left the building")
                    else:
                        p["x"] += dx / d * s; p["y"] += dy / d * s
        n += 1
        if n % 4 == 0:
            save_people()  # survives a restart: same people, same spots, same track ids
        if n % 2 == 0 and not ai_down[0]:
            try:
                step_streams()
            except Exception as e:
                print("[world] stream step failed:", repr(e), flush=True)


PEOPLE_FILE = os.path.join(HERE, "world_people.json")


def save_people():
    try:
        json.dump({"people": people, "next_track": next_track[0], "fires": fires, "sensors": sensors}, open(PEOPLE_FILE, "w"))
    except Exception as e:
        print("[world] save failed:", e, flush=True)


def load_people():
    if os.path.exists(PEOPLE_FILE):
        d = json.load(open(PEOPLE_FILE))
        people.update(d.get("people", {}))
        next_track[0] = d.get("next_track", 1)
        fires.extend({"at": tuple(f["at"]), "kind": f["kind"]} for f in d.get("fires", []))
        sensors.update(d.get("sensors", {}))  # a restart must not "cool the room"
        for p in people.values():
            if p.get("target"):
                p["target"] = tuple(p["target"])
        print(f"[world] restored {len(people)} people", flush=True)


@app.on_event("startup")
async def startup():
    load_people()
    asyncio.create_task(poll_real())
    asyncio.create_task(tick())
    threading.Thread(target=iot_main, daemon=True).start()


async def stream(ws: WebSocket, key, snapshot):
    if ai_down[0]:
        await ws.close(code=1011); return
    await ws.accept()
    q = hub.add(key)
    try:
        await ws.send_json(snapshot())
        while True:
            msg = await q.get()
            if msg is None:
                await ws.close(code=1011); return
            await ws.send_json(msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        hub.remove(key, q)


def alert_snapshot(f):
    return lambda: {"type": "snapshot", "cameras": {c: d for c, d in last["alerts"][f].items()}}


for _f in ("weapon", "fire", "emotion", "wanted"):
    async def _alerts(ws: WebSocket, f=_f):
        await stream(ws, f, alert_snapshot(f))
    app.websocket(f"/{_f}/alerts/stream")(_alerts)


@app.websocket("/zoning/occupancy/stream")
async def zoning_ws(ws: WebSocket):
    await stream(ws, "zoning", lambda: {"type": "snapshot", "zones": last["zones"]})


@app.websocket("/employee_activity/status/stream")
async def ws_ws(ws: WebSocket):
    await stream(ws, "ws", lambda: {"type": "snapshot", "workstations": workstation_rows()})


@app.websocket("/people/tracks/stream")
async def people_ws(ws: WebSocket):
    def snap():
        phase, cams = people_phase()
        return {"type": "snapshot", "state": phase, "tracks": tracks_msg(cams)["tracks"] if phase == "running" else []}
    await stream(ws, "people", snap)


@app.get("/employee_activity/workstations")
async def get_workstations():
    # Fresh from the real service, like the real endpoint: a workstation added
    # a second ago must already be listed (only the status is simulated).
    r = await client.get("/employee_activity/workstations")
    if r.status_code == 200:
        real["workstations"] = r.json()
    return workstation_rows()


@app.get("/people/status")
async def people_status():
    return status_dict()


def status_dict():
    phase, cams = people_phase()
    room = None
    corners = [ai_world(x, y) for x, y in [(0.2, 0.2), (11.8, 0.2), (11.8, 7.8), (0.2, 7.8)]]
    if all(corners):
        xs, ys = [c[0] for c in corners], [c[1] for c in corners]
        room = {"xmin": min(xs), "xmax": max(xs), "ymin": min(ys), "ymax": max(ys)}
    active = len([p for p in people.values() if in_room(p)]) if phase == "running" else None
    return {"phase": phase, "warnings": [], "error": None, "person_scale": 33.1 if phase == "running" else None,
            "room": room, "fps": 25.0 if phase == "running" else None, "cams_bootstrapped": cams if phase == "running" else None,
            "gates_loaded": 0, "active_tracks": active}


def cam_for(camera=None, source=None):
    if camera in CAMS:
        return camera
    for cid, c in (real["cameras"].get("cameras") or {}).items():
        if source and c.get("url") == source and cid in CAMS:
            return cid
    # The real /face/scan opens any source, registered or not (a door camera
    # with no detections is never registered): match the stream path.
    tail = (source or "").rstrip("/").rsplit("/", 1)[-1]
    return tail if tail in CAMS else None


@app.get("/frame")
async def frame(camera: str | None = None, source: str | None = None, format: str = "png", quality: int = 90):
    cam = cam_for(camera, source)
    if cam is None:
        return JSONResponse({"detail": "could not open source"}, 404)
    img = render(cam)
    if format == "jpeg":
        return Response(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])[1].tobytes(), media_type="image/jpeg")
    return Response(cv2.imencode(".png", img)[1].tobytes(), media_type="image/png")


@app.post("/face/scan")
async def face_scan(req: Request):
    """On-demand access-control scan, like the real one: watch the camera
    until a face shows, answer who it is (only if enrolled in the REAL
    gallery) or unknown, or time out. A person's face identity is their
    `face` attribute (an employee's is emp-<employee id>)."""
    body = await req.json()
    src, timeout = body.get("source"), float(body.get("timeout_seconds", 5))
    cam = cam_for(None, src)
    if cam is None:
        return {"source": src, "name": None, "score": None, "timed_out": False, "error": "could not open source"}
    end = time.time() + timeout
    while time.time() < end:
        cx, cy = CAMS[cam]["pos"][:2]
        near = [p for p in people.values() if in_room(p) and sees(cam, p["x"], p["y"])
                and math.hypot(p["x"] - cx, p["y"] - cy) < 2.5]
        if near:
            p = min(near, key=lambda q: math.hypot(q["x"] - cx, q["y"] - cy))
            face = p.get("face")
            known = face in real["face_gallery"]
            log(f"AI face scan @ {cam}: {p['name']} -> {face if known else 'unknown'}")
            return {"source": src, "name": face if known else None, "score": 0.71 if known else 0.06,
                    "timed_out": False, "error": None}
        await asyncio.sleep(0.3)
    log(f"AI face scan @ {cam}: nobody in front (timed out)")
    return {"source": src, "name": None, "score": None, "timed_out": True, "error": None}


@app.post("/face/capture")
async def face_capture(req: Request):
    body = await req.json()
    src, timeout = body.get("source"), float(body.get("timeout_seconds", 15))
    cam = cam_for(None, src)
    if cam is None:
        return {"source": src, "image": None, "bbox": None, "det_score": None, "embedding": None, "timed_out": False, "error": "could not open source"}
    end = time.time() + timeout
    kx, ky = PLACES["kiosk"]
    while time.time() < end:
        near = [p for p in people.values() if in_room(p) and sees(cam, p["x"], p["y"]) and math.hypot(p["x"] - kx, p["y"] - ky) < 1.5]
        if near:
            p = min(near, key=lambda p: math.hypot(p["x"] - kx, p["y"] - ky))
            b = [int(v) for v in bbox(cam, p["x"], p["y"])]
            crop = render(cam)[max(0, b[1] - 20):b[3], max(0, b[0] - 20):b[2] + 20]
            log(f"AI face capture @ {cam}: {p['name']}")
            return {"source": src, "image": base64.b64encode(cv2.imencode(".jpg", crop)[1]).decode(), "bbox": b,
                    "det_score": 0.91, "embedding": embedding_for(p.get("face") or p["name"]), "timed_out": False, "error": None}
        await asyncio.sleep(0.5)
    log(f"AI face capture @ {cam}: nobody at the kiosk (timed out)")
    return {"source": src, "image": None, "bbox": None, "det_score": None, "embedding": None, "timed_out": True, "error": None}


# ---------------------------------------------------------------- control
@app.get("/_sim/state")
async def sim_state():
    phase, _ = people_phase()
    return {"time": fake_now().astimezone(LOCAL_TZ).strftime("%H:%M:%S"),
            "people": {n: {k: (round(v, 2) if isinstance(v, float) else v) for k, v in p.items() if k not in ("hits",)} for n, p in people.items()},
            "fires": fires, "sensors": {k: round(v[0], 1) for k, v in sensors.items()},
            "sensor_targets": {k: v[1] for k, v in sensors.items()}, "devices": devices, "ai_down": ai_down[0],
            "people_tracking": phase, "zones": {k: v["count"] for k, v in last["zones"].items()},
            "workstations": {r["name"]: r["status"] for r in workstation_rows()},
            "alerts": {f: {c: [d["class"] for d in ds] for c, ds in v.items() if ds} for f, v in last["alerts"].items()},
            "real": {r: is_real(r) for r in ROLES}}


@app.get("/_sim/log")
async def sim_log(since: int = 0):
    return [l for l in LOG if l[0] > since]


@app.post("/_sim/cmd")
async def sim_cmd(req: Request):
    c = await req.json()
    op = c["op"]
    role = {"kiosk": "kiosk", "gate": "gate", "door": "door", "callnext": "display", "sensor": "door"}.get(op, "cameras")
    if is_real(role):
        what = "the cameras are" if role == "cameras" else f"the {role} board is"
        return JSONResponse({"error": f"{what} real: do it for real (or: w.py real {role} off)"}, 409)
    try:
        if op == "add":
            name = c["name"]
            at = place(c.get("at", "door"))
            people[name] = {"name": name, "kind": c.get("kind", "visitor"), "x": at[0], "y": at[1], "target": None,
                            "rfid": c.get("rfid"), "face": c.get("face"), "track": None}
            for k in ("weapon", "emotion", "wanted", "weapon_conf", "wanted_conf"):  # same as "set"
                if c.get(k):
                    people[name][k] = c[k]
            log(f"{name} ({people[name]['kind']}) appears at {c.get('at', 'door')}")
            if c.get("to"):
                people[name]["target"] = place(c["to"])
        elif op == "move":
            p = people[c["name"]]; p["target"] = place(c["to"]); log(f"{c['name']} walks to {c['to']}")
        elif op == "teleport":
            p = people[c["name"]]; p["x"], p["y"] = place(c["to"]); p["target"] = None
        elif op == "leave":
            p = people[c["name"]]; p["target"] = PLACES["outside"]; p["leaving"] = True; log(f"{c['name']} heads out")
        elif op == "remove":
            people.pop(c["name"], None)
        elif op == "lose":  # the tracker loses them for a moment, then a NEW track id
            p = people[c["name"]]
            p["hidden_until"] = time.time() + float(c.get("seconds", 1.0)); p["track"] = None; p["hits"] = 0
            if c.get("to"):
                p["x"], p["y"] = place(c["to"]); p["target"] = None
            log(f"tracker loses {c['name']} for {c.get('seconds', 1.0)} s" + (f", reappears at {c['to']}" if c.get("to") else ""))
        elif op == "set":  # weapon / emotion / wanted, null clears
            p = people[c["name"]]
            for k in ("weapon", "emotion", "wanted", "weapon_conf", "wanted_conf", "face"):
                if k in c:
                    p[k] = c[k]; log(f"{c['name']}: {k} = {c[k]}")
        elif op == "fire":
            if c.get("clear"):
                fires.clear(); log("fire/smoke cleared")
            else:
                fires.append({"at": place(c.get("at", "center")), "kind": c.get("kind", "fire")}); log(f"{c.get('kind', 'fire')} starts at {c.get('at')}")
        elif op == "sensor":  # targets; jump=True sets the value now
            for k in ("temperature", "humidity", "gas_co"):
                if k in c:
                    sensors[k][1] = float(c[k])
                    if c.get("jump"):
                        sensors[k][0] = float(c[k])
            log("sensor targets " + ", ".join(f"{k}={v[1]}" for k, v in sensors.items()))
            if c.get("publish_now"):
                publish_sensors()
        elif op == "ai_down":
            ai_down[0] = bool(c["down"]); log(f"AI service {'DOWN' if ai_down[0] else 'back UP'}")
            if ai_down[0]:
                hub.kick_all()
        elif op in ("kiosk", "gate", "door", "callnext"):
            return await device_action(c)
        else:
            return JSONResponse({"error": f"unknown op {op}"}, 400)
    except KeyError as e:
        return JSONResponse({"error": f"unknown person {e}"}, 400)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, 400)
    return {"ok": True}


# ---------------------------------------------------------------- devices: REST ingestion
def now_iso():
    return fake_now().strftime("%Y-%m-%dT%H:%M:%SZ")


async def device_action(c):
    op = c["op"]
    async with httpx.AsyncClient(base_url=BACKEND, timeout=30) as b:
        def h(dev):
            return {"X-Device-Key": KEYS[dev]}
        if op in ("kiosk", "callnext"):
            dev = KIOSK if op == "kiosk" else DISPLAY  # any device of the branch may read it
            r = await b.get(f"/internal/tickets/kiosk-config?agency_id={AGENCY}&device_id={dev}", headers=h(dev))
            svcs = r.json()["services"]
            q = c["service"].lower()
            sv = next((s for s in svcs if q in s["code"].lower() or q in s["name"].lower()), None)
            if sv is None:
                return {"error": "unknown service", "services": [s["code"] for s in svcs]}
        if op == "kiosk":
            body = {"agency_id": AGENCY, "device_id": KIOSK, "service_id": sv["service_id"], "timestamp": now_iso()}
            if c.get("name"):
                body["visitor"] = {"full_name": c["name"]}
            r = await b.post("/internal/tickets/walk-in", json=body, headers=h(KIOSK))
            log(f"KIOSK button ({sv['code']}) by {c.get('name') or 'anonymous'} -> {r.status_code} {r.json().get('ticket_number', r.text[:120])}")
        elif op == "callnext":
            if not sv["counter_id"]:
                return {"error": "service has no open counter"}
            r = await b.post("/internal/tickets/call-next", json={"agency_id": AGENCY, "device_id": DISPLAY,
                             "service_id": sv["service_id"], "counter_id": sv["counter_id"]}, headers=h(DISPLAY))
            log(f"QUEUE button call-next ({sv['code']}) -> {r.status_code} {r.text[:160]}")
        elif op == "gate":
            rfid = c.get("rfid") or (people.get(c.get("name"), {}) or {}).get("rfid")
            r = await b.post("/internal/attendance/check-rfid", json={"agency_id": AGENCY, "device_id": GATE,
                             "employee_rfid": rfid, "timestamp": now_iso()}, headers=h(GATE))
            log(f"RFID GATE badge {rfid} -> {r.status_code} {r.text[:160]}")
        elif op == "door":
            rfid = c.get("rfid") or (people.get(c.get("name"), {}) or {}).get("rfid")
            r = await b.post("/internal/access/door-access", json={"agency_id": AGENCY, "device_id": DOOR,
                             "employee_rfid": rfid, "zone_id": c["zone_id"], "timestamp": now_iso()}, headers=h(DOOR))
            ok = r.status_code == 200 and r.json().get("authorized")
            if ok:
                devices["door"] = "open (servo)"
            log(f"DOOR reader badge {rfid} zone {c.get('zone_name')} -> {r.status_code} {r.text[:160]}")
        return {"status": r.status_code, "body": r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text}


# ---------------------------------------------------------------- devices: MQTT side
mq = None


def publish_sensors():
    readings = []
    for k, (v, t, unit) in sensors.items():
        nv = v + (t - v) * 0.35 + random.uniform(-0.15, 0.15) * (0.2 if k == "gas_co" else 1)
        if k == "gas_co":
            nv = max(0.0, nv)
        sensors[k][0] = nv
        readings.append({"sensor_type": k, "value": round(nv, 1), "unit": unit})
    mq.publish(f"agency/{AGENCY}/device/{DOOR}/sensor", json.dumps({"readings": readings, "timestamp": now_iso()}), qos=1)


def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload)
    except Exception:
        return
    dev, kind = msg.topic.split("/")[3], msg.topic.split("/")[4]
    if dev in ROLE_OF and is_real(ROLE_OF[dev]):  # the real board answers for itself
        return
    if kind == "ticket-called":
        devices["display"][payload.get("service_code")] = payload.get("ticket_number", "")[-1:]
        log(f"7-SEG {dev}: {payload.get('service_code')} -> {payload.get('ticket_number')}  display {devices['display']}")
    elif kind == "alert":
        devices["buzzer"][payload.get("alert_type")] = payload.get("active")
        log(f"BUZZER/LED {dev}: {payload.get('alert_type')} active={payload.get('active')} ({payload.get('severity')})")
    elif kind == "climate":
        if devices["fan"] != payload.get("active"):
            log(f"FAN {dev}: {'ON' if payload.get('active') else 'OFF'}")
        devices["fan"] = payload.get("active")
    elif kind == "control":
        # Like the firmware per contracts/ingestion.md 6b: the door actions it
        # implements, unknown_action for anything else.
        action = str(payload.get("action", "")).lower()
        known = action in ("lock", "unlock")
        if known:
            devices["door"] = {"lock": "locked", "unlock": "unlocked"}[action]
        devices["acks"] += 1
        status = "ok" if known else "unknown_action"
        log(f"CONTROL {dev}: {payload.get('action')} {payload.get('target') or ''} -> ack {status}")
        if payload.get("correlation_id"):
            client.publish(f"agency/{AGENCY}/device/{dev}/control-ack",
                           json.dumps({"correlation_id": payload["correlation_id"], "status": status,
                                       "detail": f"simulated {dev}: {payload.get('action')}"}), qos=1)


def iot_main():
    global mq
    mq = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="world-sim")
    mq.on_message = on_message
    mq.on_connect = lambda c, u, f, rc, p=None: [c.subscribe(f"agency/{AGENCY}/device/+/{k}", qos=1) for k in ("ticket-called", "alert", "climate", "control")]
    mq.connect(MQTT_HOST, MQTT_PORT)
    mq.loop_start()
    clock_synced.wait(timeout=30)
    n = 0
    while True:
        try:
            if n % 30 == 0 and not is_real("door"):
                publish_sensors()
            if n % 60 == 0 and not is_real("kiosk"):
                httpx.get(f"{BACKEND}/internal/tickets/kiosk-config", params={"agency_id": AGENCY, "device_id": KIOSK},
                          headers={"X-Device-Key": KEYS[KIOSK]}, timeout=10)
        except Exception as e:
            print("[world] iot loop:", e, flush=True)
        n += 1
        time.sleep(1)


# ---------------------------------------------------------------- geometry, for setup_sim.py
@app.get("/_sim/geometry")
async def sim_geometry():
    """What a person would click in the dashboard: each camera's view of the
    1.5 m x 1 m calibration rectangle drawn on the floor, and where the named
    places are. setup_sim.py turns this into calibration, alignment and zones."""
    return {
        "image": [W, H],
        "rect_m": RECT,
        "cameras": {cam: {"rect_px": [list(proj(cam, x, y)) for x, y in RECT]} for cam in CAMS},
        "places": {name: list(xy) for name, xy in PLACES.items()},
    }


@app.post("/_sim/project")
async def sim_project(req: Request):
    """Floor points (metres) -> pixels on one camera, plus whether it sees them."""
    body = await req.json()
    cam = body["camera"]
    return {"points": [{"px": list(proj(cam, x, y)), "seen": sees(cam, x, y)} for x, y in body["points"]]}


# ---------------------------------------------------------------- everything else -> the real AI service
@app.get("/")
async def root():
    if ai_down[0]:
        return JSONResponse({"detail": "down"}, 503)
    r = await client.get("/")
    return Response(r.content, r.status_code, media_type="application/json")


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy(path: str, req: Request):
    if ai_down[0]:
        return JSONResponse({"detail": "down"}, 503)
    headers = {k: v for k, v in req.headers.items() if k.lower() in ("content-type", "accept")}
    r = await client.request(req.method, "/" + path, params=req.query_params, content=await req.body(), headers=headers)
    return Response(r.content, r.status_code, media_type=r.headers.get("content-type"))
