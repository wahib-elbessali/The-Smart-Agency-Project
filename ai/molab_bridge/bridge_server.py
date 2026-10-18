"""The local half of the molab GPU bridge: a small service that owns the
ngrok tunnel and relays frame bundles to a molab notebook.

    python molab_bridge/bridge_server.py            # -> prints a tunnel URL

Runs as its OWN process on its own port, deliberately, rather than being
mounted into features/main.py:

  * features/ is a standalone package that may not import anything outside
    itself; a bridge living inside it would break that.
  * molab sessions are ephemeral. A separate process means re-establishing
    the tunnel does not restart the CV service, drop its WebSocket clients,
    or -- the part that actually matters -- destroy every track id that
    /people is holding.
  * it can be run and smoke-tested with no CV service present at all.

The cost is one extra localhost hop per cycle, which is ~1 ms against a
~100 ms round trip. Not a real cost.

WHY REQUEST/RESPONSE, NOT THE TEMPLATE'S PIPELINE
-------------------------------------------------
The upstream template (Documents/Random/molab) pipelines hard: frames are
pushed continuously and up to MAX_IN_FLIGHT=30 bundles sit unacknowledged
on the wire, because it is chasing 60 fps and its throughput ceiling is
MAX_IN_FLIGHT/RTT. That is the right design for that problem.

It is the wrong design for this one. /people runs a cycle every
update_interval -- 0.5 s at the deployed setting, so ~2 fps -- while
1/RTT on a ~100 ms link is ~10 fps. Pipelining buys nothing we can use, and
it costs the property we most want: that the boxes a tracking cycle acts on
belong to the frames that same cycle captured. Coasting a track on boxes
from an earlier bundle is how identity quietly rots.

So: one bundle outstanding at a time, seq-matched, with a timeout. That is
the template's credit system with MAX_IN_FLIGHT=1, which is what its own
formula recommends once your target fps is far below 1/RTT. If /people is
ever run at a much shorter update_interval than the link's RTT, revisit
this -- the machinery to relax it is a small change here and a queue on the
notebook side.

NO AUTH, consistent with the rest of this project -- and note that this one
carries live footage of people off-premises through a public URL. Fine for
a demo; see README.md before pointing it at a real site.
"""
import asyncio
import json
import pathlib
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from protocol import pack_bundle, unpack_bundle  # noqa: E402

PORT = 8100
# Set False (or pass --no-tunnel) to skip ngrok entirely -- what the smoke
# test wants, since it talks to the bridge over localhost.
TUNNEL = True
NGROK_API = "http://127.0.0.1:4040/api/tunnels"

# How long a caller waits for the notebook to answer one bundle. Generous:
# a cold molab session compiles and loads the model on its first frame, and
# 4 HD JPEGs take real time to push up a home connection. A caller that
# hits this gets an exception, never an empty result -- see detect().
RESULT_TIMEOUT_S = 30.0


class _Bridge:
    """The single notebook connection, and the one in-flight bundle."""

    def __init__(self):
        self.ws = None
        self.seq = 0
        self.pending = {}
        self.stats = {"bundles_sent": 0, "results_received": 0, "timeouts": 0,
                      "errors": 0, "last_infer_ms": None, "last_rtt_ms": None,
                      "connected_since": None}

    @property
    def connected(self) -> bool:
        return self.ws is not None

    async def detect(self, payload: bytes, seq: int) -> dict:
        """Send one bundle, wait for the result whose seq matches it.

        Raises rather than degrading. A bridge that returned "no boxes"
        when the notebook is gone would make /people report an empty, calm,
        entirely wrong "nobody is here" -- the silent-zero failure this
        project guards against everywhere else (see features/zoning's
        people_tracking_ready flag for the same reasoning). An exception
        surfaces as /people's structured `error` phase instead.
        """
        if self.ws is None:
            raise RuntimeError("no molab notebook is connected to this bridge")
        fut = asyncio.get_running_loop().create_future()
        self.pending[seq] = fut
        t0 = time.monotonic()
        try:
            await self.ws.send_bytes(payload)
            self.stats["bundles_sent"] += 1
            result = await asyncio.wait_for(fut, RESULT_TIMEOUT_S)
        except asyncio.TimeoutError:
            self.stats["timeouts"] += 1
            raise RuntimeError(
                f"molab did not return boxes for bundle {seq} within "
                f"{RESULT_TIMEOUT_S:.0f}s -- notebook stalled, or the upload is too "
                f"slow for this frame size (see README's bandwidth table)")
        finally:
            self.pending.pop(seq, None)
        self.stats["last_rtt_ms"] = round((time.monotonic() - t0) * 1000, 1)
        self.stats["last_infer_ms"] = result.get("infer_ms")
        return result

    def resolve(self, payload: dict) -> None:
        """A result arrived. Match it to its bundle by seq and hand it over.

        A result whose seq is not pending is DISCARDED, never applied to
        whatever is waiting now. That case is real: after a timeout the
        slow answer eventually shows up, and applying it would hand a cycle
        the boxes from an older set of frames -- the exact staleness this
        design exists to prevent."""
        self.stats["results_received"] += 1
        fut = self.pending.get(int(payload.get("seq", -1)))
        if fut is not None and not fut.done():
            fut.set_result(payload)


bridge = _Bridge()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Opens the tunnel from a BACKGROUND THREAD, not inline.

    uvicorn does not start listening until lifespan startup has returned,
    so waiting for the port from inside here can only ever time out --
    the server is waiting for us. Doing it inline made the bridge print
    'no tunnel: local server never started listening' on every single run,
    which reads like an optional warning and is in fact 'the tunnel is
    permanently broken'. The thread outlives startup and polls until
    uvicorn is actually up.
    """
    holder = {}

    def open_tunnel():
        try:
            _wait_for_local_server(PORT)
            holder["proc"] = start_tunnel(PORT)
        except Exception as e:           # a tunnel is optional for local-only tests
            print(f"[bridge] no tunnel: {e}")
            print(f"[bridge] serving on ws://127.0.0.1:{PORT}/ws only", flush=True)

    if TUNNEL:
        threading.Thread(target=open_tunnel, daemon=True).start()
    else:
        print(f"[bridge] --no-tunnel: serving on ws://127.0.0.1:{PORT}/ws only",
              flush=True)
    yield
    if holder.get("proc") is not None:
        holder["proc"].terminate()


app = FastAPI(title="molab bridge", lifespan=lifespan)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    """The molab notebook connects here (through the tunnel) and stays
    connected. One notebook at a time: a second connection replaces the
    first rather than silently alternating between two sessions that would
    each hold their own idea of what is going on."""
    await ws.accept()
    if bridge.ws is not None:
        try:
            await bridge.ws.close()
        except Exception:
            pass
    bridge.ws = ws
    bridge.stats["connected_since"] = time.time()
    print("[bridge] notebook connected", flush=True)
    try:
        while True:
            bridge.resolve(json.loads(await ws.receive_text()))
    except (WebSocketDisconnect, json.JSONDecodeError, RuntimeError):
        pass
    finally:
        if bridge.ws is ws:
            bridge.ws = None
            bridge.stats["connected_since"] = None
        print("[bridge] notebook disconnected", flush=True)


@app.post("/detect")
async def detect(request: Request):
    """Body: one packed bundle (see protocol.pack_bundle). -> the notebook's
    result JSON, with boxes still in TRANSMITTED coordinates -- the caller
    owns the rescale, because the caller is what chose the scale. See
    remote_detector.RemoteDetector, which does both halves.

    The seq in the incoming header is ignored and replaced: sequence
    numbers are this bridge's own, so two callers cannot collide on one.
    """
    payload = await request.body()
    try:
        header, by_cam = unpack_bundle(payload)
    except Exception as e:
        raise HTTPException(400, f"malformed bundle: {e}")
    seq = bridge.seq = bridge.seq + 1
    header["seq"] = seq
    jpegs = [by_cam[c["id"]] for c in header["cams"]]
    try:
        return await bridge.detect(pack_bundle(header, jpegs), seq)
    except RuntimeError as e:
        bridge.stats["errors"] += 1
        raise HTTPException(503, str(e))


@app.get("/status")
def status():
    """Enough to tell "the notebook is gone" from "the notebook is slow"
    without opening a log."""
    return JSONResponse({"connected": bridge.connected, **bridge.stats})


def _find_ngrok() -> str:
    exe = shutil.which("ngrok")
    if exe:
        return exe
    raise RuntimeError(
        "ngrok not found on PATH. Install it (winget install --id Ngrok.Ngrok -e), "
        "then run `ngrok config add-authtoken <token>` once, with a free ngrok.com account")


def _wait_for_local_server(port: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"local server never started listening on port {port}")


def start_tunnel(port: int) -> subprocess.Popen:
    """Launch ngrok and print the URL to paste into the notebook.

    Called only once the local server is already listening -- an ngrok
    started against a closed port can latch onto 'connection refused' and
    hand back a URL that never works until the tunnel is restarted.
    Polls ngrok's local status API rather than scraping stdout, which is
    stable across ngrok versions.

    ngrok rather than a cloudflared quick tunnel: those are anonymous and
    rate-limited to ~21-22 fps regardless of payload size or GPU speed --
    measured on the upstream bridge, and it looks exactly like a code
    bottleneck until you swap the tunnel out.
    """
    # stdout to DEVNULL, not PIPE: we poll the API for the URL and never
    # read this pipe, and an undrained pipe that fills stops ngrok dead
    # mid-startup -- a hang with no error, which is the worst shape a
    # failure can take here.
    proc = subprocess.Popen([_find_ngrok(), "http", str(port), "--log=stdout"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # 60s, not 30: measured ~16s to establish on this connection, and
    # ngrok's own update check can add a 5s timeout before it even starts.
    # 30 was cutting it close enough to fail intermittently.
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(
                "ngrok exited before reporting a tunnel URL. Most likely another "
                "ngrok agent is already running -- the free plan allows only one "
                "session at a time. Check with: ngrok http 8100")
        try:
            with urllib.request.urlopen(NGROK_API, timeout=1) as resp:
                tunnels = json.loads(resp.read()).get("tunnels", [])
            https = [t for t in tunnels if t.get("public_url", "").startswith("https://")]
            if https:
                url = https[0]["public_url"]
                bar = "=" * 70
                print(f'\n{bar}\n  TUNNEL_URL = "{url}"\n'
                      f'  paste that into molab_bridge/molab_notebook.py, then run all cells\n'
                      f'{bar}\n', flush=True)
                return proc
        except Exception:
            pass
        time.sleep(0.5)
    proc.terminate()
    raise RuntimeError(
        "ngrok did not report a tunnel URL within 60s. Try it by hand -- "
        "`ngrok http 8100` -- and see what it says; the usual causes are no "
        "authtoken (`ngrok config add-authtoken <token>`) or another agent "
        "session already running.")


if __name__ == "__main__":
    import argparse
    import uvicorn

    _ap = argparse.ArgumentParser(description="local half of the molab GPU bridge")
    _ap.add_argument("--no-tunnel", action="store_true",
                     help="serve on localhost only, don't launch ngrok")
    _ap.add_argument("--port", type=int, default=PORT)
    _args = _ap.parse_args()
    TUNNEL = not _args.no_tunnel
    PORT = _args.port
    # WebSocket keepalive disabled, matching the notebook side. The
    # websockets library's periodic ping races with frequent application
    # writes on the same connection and can kill it under load --
    # paradoxically making things worse the faster you push. Application
    # traffic already proves liveness here, and RESULT_TIMEOUT_S catches a
    # dead pipe.
    uvicorn.run(app, host="0.0.0.0", port=PORT, ws_ping_interval=None,
                ws_ping_timeout=None, log_level="warning")
