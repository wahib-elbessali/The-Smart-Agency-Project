"""Proves the camera table works and that quality cannot break calibration.

    python features/cameras/registry_test.py

The second half is the one that matters. A homography maps PIXELS to the
floor, so halving a frame halves every pixel coordinate and the same
homography puts people at half their real floor position -- confidently,
with nothing raised. It presents as a calibration fault, and this project
has already lost time chasing "calibration problems" that were not.

So this asserts the actual invariant: the SAME physical point, measured on
frames of different sizes, must land on the SAME world coordinate.

Runs against a temporary table so it never touches features/data.
"""
import json
import pathlib
import shutil
import sys
import tempfile

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))


def main():
    from features.common import cameras as registry
    from features.calibration.engine import (calibrated_res, fit_homography_rect,
                                             image_to_world, scale_Hinv)
    from features.common.video_source import read_frame

    failures = []
    tmp = pathlib.Path(tempfile.mkdtemp())
    original = registry.CAMERAS_FILE
    registry.CAMERAS_FILE = tmp / "cameras.json"
    try:
        # --- 1. the table -------------------------------------------------
        print("1. camera table")
        registry.upsert("0", url="rtsp://cam0", name="Entrance", quality=1.0,
                        features=["people", "zoning"])
        registry.upsert("1", url="rtsp://cam1", name="Desk", quality=0.5,
                        features=["people", "emotion"])
        registry.upsert("2", url="rtsp://cam2", name="Store", features=["weapon"])

        people = registry.for_feature("people")
        emotion = registry.for_feature("emotion")
        print(f"   people  -> {sorted(people)}")
        print(f"   emotion -> {sorted(emotion)}")
        print(f"   quality -> 0:{registry.quality('0')}  1:{registry.quality('1')}")
        if sorted(people) != ["0", "1"] or sorted(emotion) != ["1"]:
            failures.append("for_feature() returned the wrong cameras")
        if registry.quality("1") != 0.5:
            failures.append("per-camera quality not stored")

        # a camera with no url is a half-filled row, not a source
        registry.upsert("9", features=["people"])
        if "9" in registry.for_feature("people"):
            failures.append("a camera with no url was handed to a feature")

        # partial updates must not wipe other fields
        registry.upsert("0", quality=0.75)
        if registry.get("0")["features"] != ["people", "zoning"]:
            failures.append("changing quality cleared the feature assignments")
        print(f"   {'PASS' if not failures else 'FAIL'} -- survives reload: "
              f"{sorted(json.load(open(registry.CAMERAS_FILE))['cameras'])}")

        # --- 2. rejects nonsense ------------------------------------------
        print("\n2. validation")
        for bad, why in [(dict(quality=3.0), "quality > 1"),
                         (dict(quality=0.0), "quality 0"),
                         (dict(features=["nope"]), "unknown feature")]:
            try:
                registry.upsert("0", **bad)
                failures.append(f"accepted {why}")
                print(f"   FAIL -- accepted {why}")
            except ValueError:
                print(f"   rejected {why}")

        # --- 3. quality vs calibration ------------------------------------
        print("\n3. quality must not move the world")
        vid = ROOT / "data/footage_w027/Camera_0000.mp4"
        if not vid.exists():
            print("   SKIPPED -- no w027 footage")
        else:
            full = read_frame(str(vid), index=300, quality=1.0)
            half = read_frame(str(vid), index=300, quality=0.5)
            print(f"   frame at quality 1.0 -> {full.shape[1]}x{full.shape[0]}")
            print(f"   frame at quality 0.5 -> {half.shape[1]}x{half.shape[0]}")
            if half.shape[1] != full.shape[1] // 2:
                failures.append("quality did not halve the frame")

            # calibrate on the FULL frame
            h, w = full.shape[:2]
            pts = [(w * 0.20, h * 0.60), (w * 0.75, h * 0.62),
                   (w * 0.85, h * 0.92), (w * 0.10, h * 0.90)]
            Hinv, diag = fit_homography_rect(pts, w, h)
            if Hinv is None:
                failures.append("calibration fit failed on the test points")
            else:
                res = diag.get("calib_res")
                print(f"   calibration recorded calib_res={res}")
                if not res:
                    failures.append("calibration did not record its resolution")

                # the SAME physical point, seen on each frame
                probe_full = (w * 0.5, h * 0.8)
                probe_half = (probe_full[0] / 2, probe_full[1] / 2)
                world_full = image_to_world(Hinv, probe_full)
                cal_entry = {"diag": diag}
                Hs = scale_Hinv(Hinv, calibrated_res(cal_entry), half.shape)
                world_half = image_to_world(Hs, probe_half)
                naive = image_to_world(Hinv, probe_half)   # what we'd get unscaled

                print(f"   world from full frame      : "
                      f"({world_full[0]:.4f}, {world_full[1]:.4f})")
                print(f"   world from half frame (fixed): "
                      f"({world_half[0]:.4f}, {world_half[1]:.4f})")
                print(f"   world from half frame (naive): "
                      f"({naive[0]:.4f}, {naive[1]:.4f})   <- the bug this prevents")
                if not np.allclose(world_full, world_half, atol=1e-9):
                    failures.append("scaled homography did not reproduce the world point")
                if np.allclose(world_full, naive, atol=1e-6):
                    failures.append("the naive path did NOT break -- this test proves nothing")
                print(f"   {'PASS' if not failures else 'FAIL'} -- same physical point, "
                      f"same world coordinate, either resolution")
    finally:
        registry.CAMERAS_FILE = original
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + ("ALL CHECKS PASSED" if not failures else "FAILURES:"))
    for f in failures:
        print(f"  - {f}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
