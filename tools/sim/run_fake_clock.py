"""Run the backend under a fake clock that ticks in real time.

    python tools/sim/run_fake_clock.py [START]        START: ISO time in UTC, e.g. 2026-10-19T07:00:00Z

Lets you play a whole working day (opening, rush, lunch, closing) in a few
minutes by jumping the clock instead of waiting. Everything that reads the
time - tickets, attendance, alerts, end-of-day closing - follows it.

Control:  GET  /_sim/clock                -> {"now": ...}
          POST /_sim/clock {"to": ISO}    -> jump (python tools/sim/w.py clock HH:MM does this)

Restart it at the CURRENT fake time (read /_sim/clock first), or the day
jumps back to START. Port: SIM_BACKEND_PORT (default 8000). Needs freezegun
(tools/sim/requirements.txt). See docs/mocking-guide.md.
"""
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))
os.chdir(BACKEND_DIR)  # the backend reads its .env from here

from freezegun import freeze_time  # noqa: E402

start = sys.argv[1] if len(sys.argv) > 1 else datetime.now(timezone.utc).strftime("%Y-%m-%dT07:00:00Z")
freezer = freeze_time(start.replace("Z", "+00:00"), tick=True,
                      ignore=["asyncio", "uvicorn", "anyio", "starlette", "httpx", "httpcore",
                              "websockets", "paho", "threading", "selectors", "queue"])

from fastapi import Body  # noqa: E402
from app.main import app  # noqa: E402

factory = freezer.start()

# Column defaults like default=datetime.utcnow were bound to the REAL function
# at import time, before the freeze, so rows stamped by the database layer
# (alerts.created_at, ...) would get real time. Rebind them to the frozen clock.
import datetime as _dt  # noqa: E402
from app.database.base import Base  # noqa: E402
import app.models.entities as _entities  # noqa: E402,F401  (registers every table)

_fixed = 0
for _table in Base.metadata.tables.values():
    for _col in _table.columns:
        for _attr in ("default", "onupdate"):
            _d = getattr(_col, _attr)
            if _d is None or not getattr(_d, "is_callable", False):
                continue
            try:
                _v = _d.arg(None)
            except Exception:
                continue
            if isinstance(_v, _dt.datetime):  # a timestamp default: follow the frozen clock
                _d.arg = (lambda ctx: _dt.datetime.utcnow()) if _v.tzinfo is None else (lambda ctx: _dt.datetime.now(_dt.timezone.utc))
                _fixed += 1
print(f"[fake-clock] started at {start}, rebound {_fixed} timestamp column defaults", flush=True)


@app.get("/_sim/clock")
def get_clock():
    return {"now": datetime.now(timezone.utc).isoformat()}


@app.post("/_sim/clock")
def set_clock(body: dict = Body(...)):
    target = datetime.fromisoformat(body["to"].replace("Z", "+00:00"))
    factory.move_to(target)
    return {"now": datetime.now(timezone.utc).isoformat()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("SIM_BACKEND_PORT", 8000)))
