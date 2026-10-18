# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "opencv-python-headless",
#     "numpy",
#     "ultralytics",
#     "websockets",
#     "huggingface-hub",
#     "insightface",
#     "onnxruntime-gpu",
# ]
# ///
"""The molab (cloud GPU) half of the bridge.

Open this in https://molab.marimo.io with a GPU attached, paste the tunnel
URL that bridge_server.py printed into TUNNEL_URL, and run all cells.

Loads EVERY model this project runs -- person, weapon, fire (all plain
YOLO fine-tunes) and InsightFace (face detection + embedding) -- and routes
each incoming bundle to the right one by its `model` field. One notebook,
one tunnel, one ngrok session (the free plan allows exactly one), whichever
feature is asking.

hsemotion (the emotion CLASSIFIER, ~16MB) is DELIBERATELY NOT here. It runs
on a face crop that local code already has in hand once InsightFace has
found the face, and it is small enough that a network round trip for it
buys nothing -- see features/emotion_detection/engine.py, which still calls
it locally, on whatever detect_faces() returned (remote or not). What
matters is offloading the two expensive stages (detection, embedding); the
inexpensive classification step on top of them isn't worth moving.

WHAT THIS DELIBERATELY DOES NOT DO
----------------------------------
It does not track, and it does not match faces against a gallery. It runs
models and returns raw results -- boxes, or embeddings -- nothing else.

That is the whole design, and it is not laziness. molab sessions are
ephemeral: they get reclaimed, the runtime restarts, the tunnel URL
changes. Every one of those events would, if the tracker lived here,
destroy the state that IS the feature -- the persistent identities
/people exists to maintain. A reconnect would silently renumber everyone.
The same reasoning is why face-gallery MATCHING never happens here either:
identify() compares an embedding against locally-stored, NAMED real
people, and that comparison -- like every other stateful, identity-bearing
step in this project -- stays on the machine that owns the data.

So the split is: this side is stateless and replaceable, the local side
holds all state and all identity. A dropped molab session costs a few
cycles of detection, not a roomful of identities or a leaked gallery.
"""

import marimo

__generated_with = "0.23.14"
app = marimo.App()


@app.cell
def _():
    import asyncio
    import json
    import struct
    import time

    import cv2
    import marimo as mo
    import numpy as np
    import websockets
    from huggingface_hub import hf_hub_download
    from ultralytics import YOLO

    return (YOLO, asyncio, cv2, hf_hub_download, json, mo, np, struct, time,
            websockets)


@app.cell
def _():
    # This account has a RESERVED ngrok domain, so the URL is stable across
    # restarts and this is already correct -- verified: bridge_server.py
    # printed exactly this. (An account without a reserved domain gets a
    # fresh random URL each run and would need pasting in every session.)
    # Confirm against what bridge_server.py prints before blaming anything
    # else for a connection failure.
    TUNNEL_URL = "https://fanning-algebra-magazine.ngrok-free.dev"
    return (TUNNEL_URL,)


@app.cell
def _(YOLO, hf_hub_download, mo):
    # Every YOLO-family checkpoint this project runs, loaded once. Same
    # files features/common/person_detector.py, features/weapon_detection/
    # engine.py and features/fire_detection/engine.py each load locally --
    # using anything else here would quietly give up a measured, fine-tuned
    # gain (person: Lab6p recall 8.4% -> 95.7%; weapon: real bodycam
    # footage, see project memory) while still producing plausible boxes,
    # which is the worst kind of wrong. Keep all of these in sync with
    # their local counterparts.
    _person_w = hf_hub_download("wahib-elbessali/smartagency-detector",
                                "checkpoints/yolo11m_multi/best.pt")
    _weapon_w = hf_hub_download("wahib-elbessali/smartagency-detector",
                                "checkpoints/weapon_sohas/best.pt")

    import urllib.request as _urlreq
    import tempfile as _tempfile
    import pathlib as _pathlib
    _fire_w = _pathlib.Path(_tempfile.gettempdir()) / "fire_yolov8n.pt"
    if not _fire_w.exists():
        _urlreq.urlretrieve(
            "https://raw.githubusercontent.com/luminous0219/"
            "fire-and-smoke-detection-yolov8/main/weights/best.pt", str(_fire_w))

    yolo_models = {
        "person": YOLO(_person_w),
        "weapon": YOLO(_weapon_w),
        "fire": YOLO(str(_fire_w)),
    }

    import torch as _torch
    mo.md(f"**cuda:** {_torch.cuda.is_available()} · "
          f"**device:** {yolo_models['person'].device}\n\n"
          + "\n".join(f"- `{k}`: `{v.ckpt_path if hasattr(v, 'ckpt_path') else ''}`"
                      for k, v in yolo_models.items()))
    return (yolo_models,)


@app.cell
def _(mo):
    # InsightFace's detector+recognizer pack, on GPU if this session has
    # one -- onnxruntime picks CUDAExecutionProvider first when it's
    # available and falls back to CPU on its own otherwise, so this is
    # correct whether or not the attached runtime has a GPU.
    #
    # "buffalo_l" here, NOT "buffalo_s" (which is what the LOCAL app uses
    # by default -- see features/config.py's face.pack). buffalo_s is a
    # CPU/Raspberry-Pi tradeoff: the reported symptom was real faces
    # missed even up close and head-on, a genuine detector-capability gap,
    # not a resolution problem -- and that CPU tradeoff simply doesn't
    # apply on a GPU that's sitting mostly idle between bundles. Measured
    # on the same real frame: buffalo_s det_score [0.638, 0.511] ->
    # buffalo_l [0.78, 0.575], ~2.6x slower on CPU (1.02s vs 0.39s for 2
    # frames) -- irrelevant here since inference is 9-30ms on a real GPU.
    #
    # CROSS-PACK GALLERIES DO NOT MATCH RELIABLY (different embedding
    # spaces, same 512-d shape) -- see face_recognition/engine.py's
    # docstring. Enroll and scan through the SAME running app
    # (features.main XOR features.cloud.main), not a mix of both.
    #
    # Cached per det_size (like the YOLO exports' per-imgsz cache in
    # features/common/accelerated_detector.py): FaceAnalysis bakes its
    # detector's input size in at prepare() time, so a caller asking for a
    # different det_size than the last one needs its own prepared instance,
    # not a per-call parameter.
    from insightface.app import FaceAnalysis

    _face_apps = {}

    def get_face_app(det_size):
        det_size = tuple(det_size)
        if det_size not in _face_apps:
            app_ = FaceAnalysis(name="buffalo_l")
            app_.prepare(ctx_id=0, det_size=det_size)
            _face_apps[det_size] = app_
        return _face_apps[det_size]

    import onnxruntime as _ort
    mo.md(f"**onnxruntime providers:** {_ort.get_available_providers()}")
    return (get_face_app,)


@app.cell
def _(struct):
    # Mirrors molab_bridge/protocol.py on the local side. Kept as a literal
    # copy rather than an import because this file runs on a machine that
    # has no access to the repo -- if you change the wire format, change it
    # in BOTH places.
    _LEN = struct.Struct("!I")

    def unpack_bundle(message, json_mod):
        (n,) = _LEN.unpack_from(message)
        header = json_mod.loads(message[_LEN.size:_LEN.size + n].decode("utf-8"))
        jpegs, off = {}, _LEN.size + n
        for cam in header["cams"]:
            jpegs[cam["id"]] = message[off:off + cam["bytes"]]
            off += cam["bytes"]
        return header, jpegs

    return (unpack_bundle,)


@app.cell
async def _(TUNNEL_URL, asyncio, cv2, get_face_app, json, mo, np, time,
            unpack_bundle, websockets, yolo_models):
    ws_url = TUNNEL_URL.rstrip("/").replace("https://", "wss://") + "/ws"
    counters = {"n": 0, "t0": time.monotonic(), "ema": None}

    def infer_detect(model_key, header, frames, cams):
        """person/weapon/fire: one batched YOLO call, boxes back with a
        class_id column -- see protocol.py's docstring for the shape."""
        model = yolo_models[model_key]
        results = model(frames, imgsz=header["imgsz"], conf=header["conf"],
                        classes=header.get("classes"),
                        agnostic_nms=header.get("agnostic_nms", False),
                        verbose=False)
        boxes = {}
        for cam, r in zip(cams, results):
            b = r.boxes
            if b is None or not len(b):
                boxes[cam] = []
                continue
            xyxy = b.xyxy.cpu().numpy()
            score = b.conf.cpu().numpy().reshape(-1, 1)
            cls = b.cls.cpu().numpy().reshape(-1, 1)
            # 2 decimals is ~0.01 px -- far below the detector's own
            # localisation error, and it roughly halves the JSON coming back.
            boxes[cam] = np.round(np.hstack([xyxy, score, cls]), 2).tolist()
        return {"boxes": boxes}

    def infer_faces(header, frames, cams):
        """InsightFace: detection + embedding, no classification, no
        matching -- see this file's module docstring for why both of those
        stay local."""
        app_ = get_face_app(header.get("det_size", (640, 640)))
        faces = {}
        for cam, frame in zip(cams, frames):
            out = []
            for f in app_.get(frame):
                out.append({"bbox": [round(float(v), 2) for v in f.bbox],
                           "det_score": round(float(f.det_score), 4),
                           "embedding": [round(float(v), 5)
                                        for v in f.normed_embedding]})
            out.sort(key=lambda d: -d["det_score"])
            faces[cam] = out
        return {"faces": faces}

    def infer(message):
        """One bundle -> results for every camera in it. `model` in the
        header picks which of the above two shapes runs."""
        header, jpegs = unpack_bundle(message, json)
        cams = [c["id"] for c in header["cams"]]
        frames = [cv2.imdecode(np.frombuffer(jpegs[c], np.uint8), cv2.IMREAD_COLOR)
                  for c in cams]

        t0 = time.monotonic()
        model_key = header.get("model", "person")
        if model_key == "faces":
            payload = infer_faces(header, frames, cams)
        elif model_key in yolo_models:
            payload = infer_detect(model_key, header, frames, cams)
        else:
            raise ValueError(f"unknown model {model_key!r}")
        infer_ms = (time.monotonic() - t0) * 1000

        return {"seq": header["seq"], "t": header["t"],
                "infer_ms": round(infer_ms, 1), **payload}

    async def session():
        # ping disabled to match the local side -- the library's keepalive
        # races with frequent application writes and can kill the
        # connection under load.
        async with websockets.connect(ws_url, max_size=None, ping_interval=None,
                                      ping_timeout=None) as ws:
            mo.output.replace(mo.md("**status:** connected, waiting for frames..."))
            async for message in ws:
                if not isinstance(message, bytes):
                    continue
                # to_thread so the socket keeps draining while the GPU works
                result = await asyncio.to_thread(infer, message)
                await ws.send(json.dumps(result))

                counters["n"] += 1
                dt = (time.monotonic() - counters["t0"])
                n_results = sum(len(v) for v in
                                (result.get("boxes") or result.get("faces") or {}).values())
                counters["ema"] = (result["infer_ms"] if counters["ema"] is None
                                   else 0.2 * result["infer_ms"] + 0.8 * counters["ema"])
                shape = "boxes" if "boxes" in result else "faces"
                mo.output.replace(mo.md(
                    f"**bundle {counters['n']}** ({shape}) · "
                    f"{len(result.get(shape, {}))} cameras · "
                    f"{n_results} result(s) · infer {counters['ema']:.0f} ms · "
                    f"{counters['n'] / dt:.2f} bundles/s"))

    while True:
        try:
            await session()
        except Exception as e:
            mo.output.replace(mo.md(f"**status:** disconnected "
                                    f"({type(e).__name__}: {e}), retrying in 2s..."))
            await asyncio.sleep(2)
    return


if __name__ == "__main__":
    app.run()
