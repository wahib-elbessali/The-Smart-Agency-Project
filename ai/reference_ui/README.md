# Reference UI

These are the original local Flask+HTML click-UIs for calibration and zone-drawing, kept here as a
working reference for whoever builds the real frontend — they are **not** the deployed surface.

The real, deployed logic now lives behind REST APIs in `features/calibration/api.py` and
`features/zoning/api.py`. The split: a real frontend owns showing a camera image and letting someone
click points; these APIs just receive the resulting coordinates and do the math (homography fit,
alignment, cross-check, zone save, occupancy). These two apps show one way that interaction can work
end to end — point-by-point accumulation, the draggable 4th-corner handle, polygon closing — useful
to look at even though the production UI won't be a server-rendered Flask page.

Still fully runnable if you want to calibrate/draw zones locally without waiting on a real frontend:

```bash
python reference_ui/calibration/calibration_app.py --video 0=cam0.mp4 --video 1=cam1.mp4
python reference_ui/zoning/zone_app.py --video 0=cam0.mp4 --video 1=cam1.mp4
```

## `console/` — manual test console for the deployed API

Different from the two apps above: `console/index.html` is a single static page with **no backend of
its own** — it calls the real, running `uvicorn features.main:app` directly over HTTP/WebSocket, using
the exact same request/response shapes documented in `docs/api.md`. Useful for poking at every feature
(calibration, zoning, person tracking, face recognition, weapon/fire/emotion/wanted alert streams) by
hand without building a real frontend first.

```bash
# 1. run the service
uvicorn features.main:app --port 8000

# 2. serve the console (don't just double-click the file -- some browsers block
#    fetch()/WebSocket from a file:// origin regardless of CORS)
python -m http.server 8080 --directory reference_ui/console
# open http://127.0.0.1:8080, set "API base" to http://127.0.0.1:8000, click Ping
```

Requires `features/main.py`'s CORS middleware (`allow_origins=["*"]`, added alongside this console) --
the console's origin (`:8080`) is different from the API's (`:8000`), and browsers block cross-origin
`fetch`/WebSocket without it. This adds no new risk beyond the service's existing no-authentication
stance (see `features/main.py`'s docstring) — restrict both together before deploying beyond a trusted LAN.

The page keeps a local, in-browser scratchpad of `{camera id: source}` — it is **not** persisted
server-side. Each feature panel has its own "register" button that pushes the current scratchpad to
that feature's own `POST .../sources` (every feature keeps an independent registry, by design).
