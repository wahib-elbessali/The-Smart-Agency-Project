"""End-to-end test of the bridge with no molab and no GPU involved.

    python molab_bridge/smoke_test.py                        # quick, imgsz 640
    python molab_bridge/smoke_test.py --imgsz 1920           # the real thing (slow on CPU)
    python molab_bridge/smoke_test.py --max-width 1280       # exercise the downscale path

Starts the real bridge_server in-process, connects a stand-in "notebook"
over a local WebSocket that runs the real local detector, pushes a real
multi-camera bundle from footage through it, and checks the boxes that come
back against a direct local call.

WHY THIS EXISTS. Two of the three things that can silently break here are
invisible to a demo that merely "works":

  1. The coordinate rescale. Downscale for bandwidth, forget to undo it,
     and every box is a well-formed lie at 0.67x of the truth. Nothing
     raises. It presents as a calibration fault. --max-width makes that
     path assert instead of hoping.
  2. Camera/box misalignment. Boxes come back keyed by camera id; a bundle
     packed in one order and unpacked in another would attribute camera 0's
     people to camera 3, which POM fusion would happily turn into confident
     phantoms somewhere between them. The per-camera IoU check catches it.

The third -- bandwidth -- is the one thing this test cannot tell you,
because there is no network in it. See README.md's table for that.
"""
import argparse
import asyncio
import json
import pathlib
import sys
import threading
import time

import cv2
import numpy as np
import requests
import uvicorn
import websockets

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import bridge_server                                    # noqa: E402
from remote_detector import RemoteDetector              # noqa: E402
from protocol import unpack_bundle                      # noqa: E402

PORT = bridge_server.PORT


def iou(a, b):
    """max-IoU of every box in `a` against `b`; -> median, or nan if either empty."""
    if not len(a) or not len(b):
        return float("nan")
    a, b = np.asarray(a, float), np.asarray(b, float)
    out = []
    for box in a:
        x1 = np.maximum(box[0], b[:, 0]); y1 = np.maximum(box[1], b[:, 1])
        x2 = np.minimum(box[2], b[:, 2]); y2 = np.minimum(box[3], b[:, 3])
        inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
        area_a = (box[2] - box[0]) * (box[3] - box[1])
        area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
        out.append((inter / (area_a + area_b - inter)).max())
    return float(np.median(out))


async def fake_notebook(models, stop, face_detect=None):
    """Stands in for molab_notebook.py, running LOCAL models. Mirrors that
    file's infer()/infer_detect()/infer_faces() -- if you change one,
    change the others.

    `models`: {"person"|"weapon"|"fire": an ultralytics-shaped model}, any
    subset -- routed by the incoming bundle's `model` field.
    `face_detect`: optional callable(frame_bgr, det_size) -> [dict, ...] in
    features/face_recognition/engine.detect_faces()'s own shape, used for
    "faces" bundles. Passing the real detect_faces() here (unpatched) is
    exactly how this proves the remote "faces" path reproduces the local
    one -- same trick the detect-family tests already use.
    """
    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws", max_size=None,
                                  ping_interval=None) as ws:
        print("[fake notebook] connected")
        while not stop.is_set():
            try:
                message = await asyncio.wait_for(ws.recv(), 0.5)
            except asyncio.TimeoutError:
                continue
            header, jpegs = unpack_bundle(message)
            cams = [c["id"] for c in header["cams"]]
            frames = [cv2.imdecode(np.frombuffer(jpegs[c], np.uint8), cv2.IMREAD_COLOR)
                      for c in cams]
            model_key = header.get("model", "person")
            t0 = time.monotonic()

            if model_key == "faces":
                faces = {}
                for cam, frame in zip(cams, frames):
                    out = [{"bbox": [round(float(v), 2) for v in f["bbox"]],
                           "det_score": round(float(f["det_score"]), 4),
                           "embedding": [round(float(v), 5) for v in f["embedding"]]}
                          for f in face_detect(frame, tuple(header.get("det_size", (640, 640))))]
                    faces[cam] = out
                payload = {"faces": faces}
            else:
                model = models[model_key]
                results = model(frames, imgsz=header["imgsz"], conf=header["conf"],
                                classes=header.get("classes"),
                                agnostic_nms=header.get("agnostic_nms", False), verbose=False)
                boxes = {}
                for cam, r in zip(cams, results):
                    b = r.boxes
                    if b is None or not len(b):
                        boxes[cam] = []
                        continue
                    xyxy = b.xyxy.cpu().numpy()
                    score = b.conf.cpu().numpy().reshape(-1, 1)
                    cls = b.cls.cpu().numpy().reshape(-1, 1)
                    boxes[cam] = np.round(np.hstack([xyxy, score, cls]), 2).tolist()
                payload = {"boxes": boxes}

            await ws.send(json.dumps({"seq": header["seq"], "t": header["t"],
                                      "infer_ms": round((time.monotonic() - t0) * 1000, 1),
                                      **payload}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--max-width", type=int, default=None,
                    help="downscale before sending -- exercises the rescale path")
    ap.add_argument("--quality", type=int, default=75)
    ap.add_argument("--frames", default=None,
                    help="glob of videos; default is 4 cameras of Warehouse_027")
    ap.add_argument("--external-bridge", action="store_true",
                    help="use the bridge ALREADY running on this port, with whatever "
                         "notebook is attached to it, instead of starting one with a "
                         "local stand-in. This is how you test the real tunnel, the "
                         "real GPU and the real bandwidth -- everything the default "
                         "mode deliberately cannot tell you.")
    args = ap.parse_args()

    vids = (sorted(pathlib.Path().glob(args.frames)) if args.frames
            else [ROOT / f"data/footage_w027/Camera_000{i}.mp4" for i in range(4)])
    frames = {}
    for i, v in enumerate(vids):
        cap = cv2.VideoCapture(str(v))
        cap.set(cv2.CAP_PROP_POS_FRAMES, 300)
        ok, f = cap.read()
        cap.release()
        if not ok:
            sys.exit(f"could not read a frame from {v}")
        frames[str(i)] = f
    print(f"{len(frames)} cameras, {frames['0'].shape[1]}x{frames['0'].shape[0]}, "
          f"imgsz={args.imgsz}, max_width={args.max_width}, quality={args.quality}")

    from features.common.person_detector import get_model
    model = get_model(None)

    stop = threading.Event()
    if args.external_bridge:
        try:
            st = requests.get(f"http://127.0.0.1:{PORT}/status", timeout=3).json()
        except Exception as e:
            sys.exit(f"no bridge running on port {PORT} ({e}). Start it with:\n"
                     f"    python molab_bridge/bridge_server.py")
        if not st["connected"]:
            sys.exit(f"the bridge on port {PORT} has NO notebook attached. Open "
                     f"molab_bridge/molab_notebook.py in molab, paste the tunnel URL, "
                     f"and run all cells.")
        print(f"using the already-running bridge: {st}")
    else:
        bridge_server.TUNNEL = False   # localhost only; no ngrok for a local test
        server = uvicorn.Server(uvicorn.Config(bridge_server.app, host="127.0.0.1",
                                               port=PORT, log_level="error",
                                               ws_ping_interval=None, ws_ping_timeout=None))
        # the bridge's lifespan tries to open an ngrok tunnel; irrelevant here,
        # and it degrades to local-only on its own if ngrok is missing.
        threading.Thread(target=server.run, daemon=True).start()
        for _ in range(100):
            try:
                requests.get(f"http://127.0.0.1:{PORT}/status", timeout=0.5)
                break
            except Exception:
                time.sleep(0.1)

        loop = asyncio.new_event_loop()
        threading.Thread(target=lambda: loop.run_until_complete(
                            fake_notebook({"person": model}, stop)),
                         daemon=True).start()
        for _ in range(100):
            if requests.get(f"http://127.0.0.1:{PORT}/status", timeout=1).json()["connected"]:
                break
            time.sleep(0.1)
        else:
            sys.exit("the stand-in notebook never connected")

    def local(imgs, imgsz):
        out = {}
        results = model([imgs[c] for c in sorted(imgs)], imgsz=imgsz, conf=0.25,
                        verbose=False)
        for c, r in zip(sorted(imgs), results):
            out[c] = (r.boxes.xyxy.cpu().numpy() if len(r.boxes) else np.zeros((0, 4)))
        return out

    det = RemoteDetector(jpeg_quality=args.quality, max_width=args.max_width)
    print("\n-- through the bridge --")
    t0 = time.monotonic()
    got = det.detect(frames, imgsz=args.imgsz)
    print(f"   {time.monotonic() - t0:.2f}s total · {det.last}")

    # Two DIFFERENT questions, which a single comparison would conflate:
    #
    #   A. does the bridge transmit faithfully?   bridge  vs  local-on-transmitted
    #   B. what does transmission COST?           local-on-transmitted vs local-on-raw
    #
    # Only A is a pass/fail property of this code. B is a real, expected
    # loss -- JPEG is lossy and downscaling discards detail -- and it is
    # the number that decides which transmit settings are acceptable, so it
    # is measured and reported rather than asserted. Folding the two
    # together is how you end up "fixing" a bridge that was never broken.
    transmitted = {}
    for c, f in frames.items():
        im = f
        if args.max_width and f.shape[1] > args.max_width:
            s = args.max_width / f.shape[1]
            im = cv2.resize(f, (int(round(f.shape[1] * s)), int(round(f.shape[0] * s))),
                            interpolation=cv2.INTER_AREA)
        buf = cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, args.quality])[1]
        transmitted[c] = cv2.imdecode(buf, cv2.IMREAD_COLOR)

    print("\n-- A. bridge vs local detector on the SAME transmitted frames --")
    ref_tx = local(transmitted, det.last["sent_imgsz"])
    scale = (args.max_width / frames["0"].shape[1]) if args.max_width else 1.0
    print("  cam   bridge   local   median IoU")
    worst, counts_match = 1.0, True
    for c in sorted(frames):
        # ref_tx is in transmitted pixels; `got` was rescaled to original
        v = iou(got[c][:, :4] * scale, ref_tx[c])
        counts_match &= len(got[c]) == len(ref_tx[c])
        worst = min(worst, v if v == v else 1.0)
        shown = f"{v:.3f}" if v == v else "(both empty)"
        print(f"  {c:>3}   {len(got[c]):6d}  {len(ref_tx[c]):6d}   {shown}")
    ok = counts_match and worst > 0.99
    print(f"\n  {'PASS' if ok else 'FAIL'} -- box counts match: {counts_match}, "
          f"worst median IoU {worst:.3f} (bar: identical counts, IoU > 0.99)")

    print(f"\n-- B. what transmission costs (quality={args.quality}, "
          f"max_width={args.max_width}) --")
    ref_raw = local(frames, args.imgsz)
    n_tx, n_raw = sum(len(v) for v in ref_tx.values()), sum(len(v) for v in ref_raw.values())
    print("  cam   transmitted   raw   median IoU")
    for c in sorted(frames):
        v = iou(ref_tx[c] / scale, ref_raw[c])
        shown = f"{v:.3f}" if v == v else "(both empty)"
        print(f"  {c:>3}   {len(ref_tx[c]):11d}  {len(ref_raw[c]):4d}   {shown}")
    print(f"\n  {n_tx} detections transmitted vs {n_raw} raw "
          f"({n_tx - n_raw:+d}). NOT a pass/fail -- this is the accuracy price of\n"
          f"  these transmit settings, on ONE frame set. Before trusting any\n"
          f"  setting in production, measure it over a real sequence.")

    stop.set()
    print("\nbridge stats:", requests.get(f"http://127.0.0.1:{PORT}/status", timeout=2).json())
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
