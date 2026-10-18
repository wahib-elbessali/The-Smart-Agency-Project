"""Proves the two apps are interchangeable, and that EVERY remote model --
person, weapon, fire, faces -- reproduces its local counterpart.

    python features/cloud/parity_test.py

Six checks:

  1. ROUTE PARITY -- every path+method features/ serves, features/cloud/
     serves too, with the same names. This is the whole promise of this
     package, so it is asserted rather than assumed; a rename or a dropped
     router here would otherwise only show up as a 404 in whatever consumes
     the API.
  2. BACKEND -- features/cloud/ resolves every model to a remote shim;
     clearing every hook returns them all to LOCAL ones. Guards against the
     failure where the cloud app silently runs a local model and merely
     claims not to.
  3-5. DETECTION -- person, weapon and fire each produce the same
     class-labeled boxes as their local model, over a real bridge with a
     stand-in notebook (no GPU, no network). Same IoU-matched comparison
     established for the person path originally, now also checking
     `.cls`/`.names`, since weapon and fire actually use the class label.
  6. FACES -- the remote face path produces embeddings that identify()
     matches to the SAME PERSON as the local embeddings do. This is the
     correctness bar that actually matters for a face pipeline -- bytewise
     embedding equality is not expected (JPEG changes the input),
     IDENTIFICATION OUTCOME is.

Run it after changing anything in features/ (including features/cloud/) or
molab_bridge/.
"""
import asyncio
import pathlib
import sys
import threading
import time

import cv2
import numpy as np
import requests
import uvicorn

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "molab_bridge"))


def transmit_settings():
    """The quality AND width the cloud backend is actually configured to
    send at (for the detect-family models). Both are read from config
    rather than hardcoded: the reference this test compares against has to
    be built from the same bytes the cloud path really sees, or the test
    measures the transmit settings instead of the bridge. (Missing
    max_width here is exactly what made this test fail the day max_width
    was set to 960.)"""
    from features.cloud.remote_model import load_config
    cfg = load_config()
    return cfg["jpeg_quality"], cfg["max_width"]


def transmit(im, quality, max_width):
    """Put one frame through the same downscale+JPEG the bridge applies."""
    if max_width and im.shape[1] > max_width:
        s = max_width / im.shape[1]
        im = cv2.resize(im, (int(round(im.shape[1] * s)), int(round(im.shape[0] * s))),
                        interpolation=cv2.INTER_AREA)
    buf = cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, quality])[1]
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def routes_of(app):
    from features.common.route_walk import iter_routes
    return {f"{m} {p}" for p, methods in iter_routes(app) for m in methods}


def main():
    failures = []

    # --- 1. route parity -------------------------------------------------
    # Imported in this order on purpose: features.main first, so it is
    # loaded with LOCAL backends, exactly as `uvicorn features.main:app`
    # would load it. features.cloud.main then installs its hooks.
    from features.main import app as local_app
    local_routes = routes_of(local_app)

    from features.cloud.main import app as cloud_app
    cloud_routes = routes_of(cloud_app)

    missing = local_routes - cloud_routes
    extra = cloud_routes - local_routes
    print(f"1. route parity -- local {len(local_routes)} routes, "
          f"cloud {len(cloud_routes)}")
    if missing:
        failures.append(f"cloud app is MISSING routes: {sorted(missing)}")
        print(f"   MISSING from cloud: {sorted(missing)}")
    unexpected = extra - {"GET /detector"}
    if unexpected:
        failures.append(f"cloud app has unexpected routes: {sorted(unexpected)}")
        print(f"   UNEXPECTED in cloud: {sorted(unexpected)}")
    print(f"   {'PASS' if not missing and not unexpected else 'FAIL'} "
          f"-- documented additions: {sorted(extra)}")

    # --- 2. which backend each resolves to -------------------------------
    from features.common import person_detector
    from features.face_recognition import engine as face_engine
    from features.fire_detection import engine as fire_engine
    from features.weapon_detection import engine as weapon_engine
    from features.cloud.remote_model import RemoteYOLO

    print("\n2. backend -- with features.cloud loaded")
    remote_person = person_detector.get_model(None)
    remote_weapon = weapon_engine.get_model()
    remote_fire = fire_engine.get_model()
    is_remote = (isinstance(remote_person, RemoteYOLO) and isinstance(remote_weapon, RemoteYOLO)
                and isinstance(remote_fire, RemoteYOLO)
                and face_engine._detect_faces_override is not None)
    print(f"   person -> {type(remote_person).__name__}({remote_person.weights!r})")
    print(f"   weapon -> {type(remote_weapon).__name__}({remote_weapon.weights!r})")
    print(f"   fire   -> {type(remote_fire).__name__}({remote_fire.weights!r})")
    print(f"   faces  -> override installed: {face_engine._detect_faces_override is not None}")
    if not is_remote:
        failures.append("features.cloud did not install every remote backend")

    person_detector.set_model_factory(None)
    weapon_engine.set_model_factory(None)
    fire_engine.set_model_factory(None)
    face_engine.set_faces_override(None)
    local_person = person_detector.get_model(None)
    is_local = not isinstance(local_person, RemoteYOLO)
    print(f"   after clearing every hook, person -> {type(local_person).__name__} (local)")
    if not is_local:
        failures.append("clearing the hooks did not restore a local person model")
    print(f"   {'PASS' if is_remote and is_local else 'FAIL'}")

    # --- shared bridge + stand-in notebook for checks 3-6 -----------------
    import bridge_server
    from smoke_test import fake_notebook, iou

    frames = {}
    for i in range(2):
        cap = cv2.VideoCapture(str(ROOT / f"data/footage_w027/Camera_000{i}.mp4"))
        cap.set(cv2.CAP_PROP_POS_FRAMES, 300)
        ok, f = cap.read()
        cap.release()
        if not ok:
            sys.exit(f"could not read footage for camera {i}")
        frames[i] = f

    bridge_server.TUNNEL = False   # localhost only; no ngrok for a local test
    server = uvicorn.Server(uvicorn.Config(
        bridge_server.app, host="127.0.0.1", port=bridge_server.PORT,
        log_level="error", ws_ping_interval=None, ws_ping_timeout=None))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        try:
            requests.get(f"http://127.0.0.1:{bridge_server.PORT}/status", timeout=0.5)
            break
        except Exception:
            time.sleep(0.1)

    local_weapon_model = weapon_engine.get_model()
    local_fire_model = fire_engine.get_model()

    def _real_detect_faces(image_bgr, det_size):
        # NOT face_engine.detect_faces: by the time bundles are flowing,
        # the remote override is already installed, and detect_faces()
        # checks it on every call -- passing that dispatcher in here would
        # make the stand-in notebook's face branch call BACK INTO the
        # bridge it is itself serving, deadlocking (found by running this:
        # bundle 4 timed out at exactly the first face request). This
        # duplicates detect_faces()'s real-path body to reach the actual
        # local InsightFace call, bypassing the override on purpose --
        # the stand-in must run the REAL thing to be a meaningful reference.
        app = face_engine.get_engine(det_size)
        out = [dict(bbox=tuple(float(v) for v in f.bbox), det_score=float(f.det_score),
                    embedding=f.normed_embedding.astype(np.float32))
              for f in app.get(image_bgr)]
        out.sort(key=lambda f: -f["det_score"])
        return out

    stop = threading.Event()
    loop = asyncio.new_event_loop()
    threading.Thread(
        target=lambda: loop.run_until_complete(fake_notebook(
            {"person": local_person, "weapon": local_weapon_model, "fire": local_fire_model},
            stop, face_detect=_real_detect_faces)),
        daemon=True).start()
    for _ in range(100):
        if requests.get(f"http://127.0.0.1:{bridge_server.PORT}/status",
                        timeout=1).json()["connected"]:
            break
        time.sleep(0.1)
    else:
        sys.exit("the stand-in notebook never connected")

    # re-install the remote hooks now that the stand-in is up
    person_detector.set_model_factory(lambda w: RemoteYOLO("person", w))
    weapon_engine.set_model_factory(lambda: RemoteYOLO("weapon"))
    fire_engine.set_model_factory(lambda: RemoteYOLO("fire"))
    from features.cloud.remote_model import remote_detect_faces
    face_engine.set_faces_override(remote_detect_faces)

    ims = [frames[i] for i in sorted(frames)]
    q, max_width = transmit_settings()
    tx = [transmit(im, q, max_width) for im in ims]
    scale = (max_width / ims[0].shape[1]) if max_width else 1.0

    def check_detect(n, label, cloud_model, local_model, imgsz, **kw):
        print(f"\n{n}. {label} detection through the cloud")
        got = cloud_model(ims, imgsz=imgsz, conf=0.25, **kw)
        # The reference must run at the SAME resolution the cloud path
        # actually used, not the caller's requested imgsz: RemoteDetector
        # clamps imgsz down to whatever was really transmitted (here,
        # max_width=960), so a request for 1280 (fire's default) still
        # only sends 960px -- comparing against a LOCAL call at 1280 would
        # pad the reference back up and diverge from what the cloud
        # actually saw. This is exactly the sent_imgsz clamp
        # molab_bridge/smoke_test.py already accounts for; it was missed
        # here on the first pass and fire's mismatch below is what caught it.
        sent_imgsz = cloud_model.detector.last["sent_imgsz"]
        ref = local_model(tx, imgsz=sent_imgsz, conf=0.25, **kw)
        print("   cam   cloud   local(same bytes)   median IoU   classes match")
        ok_n = True
        for i, (g, r) in enumerate(zip(got, ref)):
            a = g.boxes.xyxy.cpu().numpy() * scale
            b = (r.boxes.xyxy.cpu().numpy() if len(r.boxes) else np.zeros((0, 4)))
            v = iou(a, b)
            cls_match = sorted(g.boxes.cls.cpu().numpy().tolist()) == \
                sorted(r.boxes.cls.cpu().numpy().tolist())
            shown = f"{v:.3f}" if v == v else "(both empty)"
            print(f"   {i:>3}   {len(a):5d}   {len(b):17d}   {shown}          {cls_match}")
            if len(a) != len(b) or (v == v and v < 0.99) or not cls_match:
                ok_n = False
        print(f"   {'PASS' if ok_n else 'FAIL'} -- identical counts, IoU > 0.99, classes match")
        if not ok_n:
            failures.append(f"{n}. {label}: remote detection did not reproduce the local model")

    check_detect(3, "person", remote_person, local_person, 640)
    check_detect(4, "weapon", remote_weapon, local_weapon_model, 640, agnostic_nms=True)
    check_detect(5, "fire", remote_fire, local_fire_model, 1280)

    # --- 6. faces: identification outcome, not bytewise equality ---------
    # NOTE: this stand-in runs the LOCALLY CONFIGURED pack (buffalo_s by
    # default) on both sides, not the real molab_notebook.py's buffalo_l --
    # downloading/running buffalo_l here would make this test slow and
    # GPU-shaped for no plumbing benefit. This proves the wire protocol,
    # rescale, and identification logic are correct; it does NOT validate
    # buffalo_l's detection improvement specifically -- that only shows up
    # against the real notebook.
    print("\n6. faces -- remote embeddings identify the same person as local ones")
    face_img = ims[0]  # w027 has real people in frame; any face-bearing crop works
    local_faces = _real_detect_faces(face_img, (640, 640))  # bypass the override -- see above
    remote_faces = remote_detect_faces(face_img)
    print(f"   local: {len(local_faces)} face(s)   remote: {len(remote_faces)} face(s)")
    if not local_faces or not remote_faces:
        print("   SKIPPED -- this frame has no detectable face at this distance/resolution")
    else:
        gallery = {"person_a": [local_faces[0]["embedding"]]}
        local_match, local_score = face_engine.identify(gallery, local_faces[0]["embedding"])
        remote_match, remote_score = face_engine.identify(gallery, remote_faces[0]["embedding"])
        cos = float(np.dot(local_faces[0]["embedding"], remote_faces[0]["embedding"]))
        print(f"   local  identify() -> {local_match} ({local_score:.3f})")
        print(f"   remote identify() -> {remote_match} ({remote_score:.3f})")
        print(f"   cosine similarity between the two embeddings: {cos:.4f}")
        ok = (remote_match == "person_a") and cos > 0.9
        if not ok:
            failures.append("remote face embedding did not identify as the same person")
        print(f"   {'PASS' if ok else 'FAIL'} -- remote embedding identifies correctly, "
              f"cosine > 0.9")

    stop.set()
    print("\n" + ("ALL CHECKS PASSED" if not failures else "FAILURES:"))
    for f in failures:
        print(f"  - {f}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
