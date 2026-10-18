# Drop camera footage here

Put an `.mp4` in this folder and fixture mode stops showing a grey placard:
every camera frame in the app becomes a real frame from your video, advancing
as it plays.

**The video files themselves are gitignored.** Only this README is committed —
nothing anyone drops here ends up in the repository.

## Naming

```
cam-lobby.mp4      named after the camera, exactly as the Cameras screen shows it
cam-counter.mp4
cam-store.mp4
default.mp4        used by any camera that has no file of its own
```

One `default.mp4` is enough to make every screen look real. Separate files per
camera are better, and for one screen they are necessary — see below.

## What each screen does with it

| Screen                      | With footage                                            |
| --------------------------- | ------------------------------------------------------- |
| `/cameras/{id}` (live view) | A real picture that advances every two seconds          |
| `/zones`                    | Draw the polygon over the actual floor you want counted |
| `/calibration` step 1       | Click the corners of a real floor tile                  |
| `/calibration` step 2       | **Needs two different videos** — see below              |

**Alignment is the one that needs real variety.** It works by clicking the same
physical spot in two cameras, so it only means anything if the two cameras show
the _same room from different angles_. With a single `default.mp4` every camera
shows an identical picture, and the exercise is pretend — the screens will run,
the numbers will come back, and none of it describes anything. Two clips of one
room from two corners is the setup that makes it real.

## Details worth knowing

- Every frame is served at **1920×1080** regardless of the video's own size:
  the clip is centred and letterboxed, aspect preserved. The scripted weapon
  detections in `src/mocks/aiStreams.ts` are in fixed pixel coordinates chosen
  for that size, so a differently-sized video would scatter the overlay boxes
  across the wrong part of the picture.
- A camera with footage serves frames **even when its status is not ONLINE**.
  In fixture mode a file on disk is better evidence than a status field. Delete
  a camera's file to get the "stream unavailable" 404 back and check how the
  screens handle a dead camera.
- The video plays muted and on a loop, in a detached element. Nothing is
  uploaded anywhere; it is decoded in your browser and drawn to a canvas.
- The test suite never touches any of this — `MODE === 'test'` short-circuits
  it, so suites stay deterministic whether or not you have files here.

## Where to get a clip

Anything overhead-ish with a visible floor works. A phone video of a room, a
corridor, a shop — filmed from two corners if you want to try alignment. The
detectors are not run in fixture mode, so nothing needs to be a real branch
office and nobody needs to be in shot.
