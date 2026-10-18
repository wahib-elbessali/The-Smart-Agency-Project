"""Deployable surface over tracker.py. Mounted at /employee_activity by the
unified app in features/main.py.

Answers "suivi du fonctionnement des employes" (from the product's 16-feature
roadmap) as presence-over-time at a named workstation, NOT face-identified
attendance (that's features/face_recognition + features/zoning composed by
the backend, a different feature: "presence des employes") and NOT
activity/idleness classification (researched and rejected as unreliable
everywhere it's been tried -- see tracker.py's docstring). This feature
never reads a face, so it works at whatever distance zoning's person
detector already handles, not face-recognition range.

A "workstation" is just a NAME bound to an EXISTING zoning zone -- create
the zone first via POST /zoning/zones (a pixel zone drawn on that desk's own
camera needs no calibration), then bind a workstation name to it here. No
detection runs in this module at all: it polls features/zoning's
already-computed occupancy (get_zone_count()) on its own background loop and
turns the count into a debounced present/away status per workstation -- see
tracker.py.

- POST      /employee_activity/workstations       -- {"name", "zone"} binds a
                                                      workstation to an
                                                      existing zoning zone.
- GET       /employee_activity/workstations         -- current status of
                                                      every registered
                                                      workstation.
- DELETE    /employee_activity/workstations/{name}
- WebSocket /employee_activity/status/stream        -- snapshot on connect,
                                                      then one update each
                                                      time a workstation's
                                                      status (present/away)
                                                      actually flips.

Each workstation's status is one of:
  "unknown" -- not yet classified (just registered, or zoning hasn't read
               that zone even once yet -- `zone_known: false` distinguishes
               "no data yet" from a genuine reading, same convention as
               zoning's own `people_tracking_ready`).
  "present" -- the zone had >= 1 person at the most recent poll (or has had
               one continuously since).
  "away"    -- the zone has been CONTINUOUSLY empty for
               >= employee_activity.absence_seconds.

Tunables live in features/config.json under "employee_activity":
poll_interval, absence_seconds (default 300s / 5 min -- a starting point,
not a measured one; see config.py). Workstation registrations persist at
features/data/employee_activity.json (see paths.py); the zones themselves
remain zoning's own data, untouched by this module.
"""
import asyncio
import json
import os
import threading
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from ..config import CONFIG
from ..paths import EMPLOYEE_ACTIVITY
from ..zoning.api import get_zone_count, zone_names
from . import tracker

_CFG = CONFIG["employee_activity"]
# poll_interval and absence_seconds are read from _CFG at use time (PATCH /config changes them live)

_lock = threading.Lock()
_workstations = {}   # {name: zone_name}, persisted
_states = {}          # {name: tracker state dict}, process-lifetime only
_ws_clients = set()


def _load():
    if EMPLOYEE_ACTIVITY.exists():
        return json.load(open(EMPLOYEE_ACTIVITY)).get("workstations", {})
    return {}


def _save():
    # Atomic replace, same pattern as wanted_detection/api.py's
    # _save_watchlist(): a crash mid-write must not corrupt this file, since
    # load_gallery-style code here would then raise at import.
    EMPLOYEE_ACTIVITY.parent.mkdir(parents=True, exist_ok=True)
    tmp = EMPLOYEE_ACTIVITY.with_suffix(".json.tmp")
    json.dump({"workstations": _workstations}, open(tmp, "w"), indent=2)
    os.replace(tmp, EMPLOYEE_ACTIVITY)


_workstations.update(_load())
for _name in _workstations:
    _states[_name] = tracker.new_state()


def _public_state(name):
    zone = _workstations[name]
    st = _states.setdefault(name, tracker.new_state())
    known = get_zone_count(zone) is not None
    return {"name": name, "zone": zone, "status": st["status"], "since": st["since"],
            "zone_known": known}


router = APIRouter(prefix="/employee_activity", tags=["employee activity"])


class WorkstationRequest(BaseModel):
    name: str
    zone: str


@router.post("/workstations")
def add_workstation(req: WorkstationRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(422, "empty workstation name")
    with _lock:
        if req.zone not in zone_names():
            raise HTTPException(422, f"no such zoning zone: {req.zone!r} -- create it first via "
                                     f"POST /zoning/zones, then bind a workstation to it")
        _workstations[name] = req.zone
        _states.setdefault(name, tracker.new_state())
        _save()
        out = _public_state(name)
    return out


@router.get("/workstations")
def list_workstations():
    with _lock:
        return [_public_state(name) for name in _workstations]


@router.delete("/workstations/{name}")
def delete_workstation(name: str):
    with _lock:
        if name not in _workstations:
            raise HTTPException(404, f"no such workstation: {name!r}")
        del _workstations[name]
        _states.pop(name, None)
        _save()
    return {"name": name, "deleted": True}


async def _broadcast(msg):
    dead = []
    for ws in list(_ws_clients):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _ws_clients.discard(ws)


async def _background_loop():
    while True:
        with _lock:
            snapshot = dict(_workstations)
        for name, zone in snapshot.items():
            zone_state = get_zone_count(zone)
            if zone_state is None:
                continue    # zoning hasn't read this zone even once yet -- stay "unknown", don't guess
            with _lock:
                if name not in _workstations:
                    continue   # deleted while this cycle was running
                state = _states.setdefault(name, tracker.new_state())
                _, changed = tracker.update(state, zone_state["count"], _CFG["absence_seconds"])
                payload = _public_state(name)
            if changed:
                await _broadcast({"type": "update", **payload})
        await asyncio.sleep(_CFG["poll_interval"])


@asynccontextmanager
async def lifespan():
    task = asyncio.create_task(_background_loop())
    yield
    task.cancel()


@router.websocket("/status/stream")
async def status_stream(ws: WebSocket):
    """Snapshot on connect ({"type": "snapshot", "workstations": [...]}), then
    one {"type": "update", "name", "zone", "status", "since", "zone_known"}
    message each time a workstation's status actually flips (present<->away,
    or the initial unknown->present/away). Reconnecting costs nothing; the
    background loop keeps running regardless of whether anyone is
    connected."""
    await ws.accept()
    _ws_clients.add(ws)
    try:
        with _lock:
            snapshot = [_public_state(name) for name in _workstations]
        await ws.send_json({"type": "snapshot", "workstations": snapshot})
        while True:
            # bare receive() returns a dict and does NOT raise on disconnect --
            # see features/zoning/api.py's identical fix for why this can't
            # just be a plain receive_json() loop.
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(ws)
