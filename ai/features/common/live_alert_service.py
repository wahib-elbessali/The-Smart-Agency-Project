"""Reusable continuous background-detection + WebSocket alert broadcaster --
shared by features/weapon_detection/api.py and features/fire_detection/api.py
(NOT features/zoning/api.py, which has different per-zone/floor-position/
threshold semantics). Same "always watching, push on change" shape as
zoning's occupancy stream -- pulled out here since weapon and fire detection
are otherwise identical plumbing around two different engine.py detect
functions.

Change-detection is on the SET OF DETECTED CLASSES per camera (e.g. {"Gun"},
{"fire","smoke"}, or {} for nothing), NOT the raw detection list. This is a
deliberate difference from a naive "did the detections list change" check:
a detection's confidence score jitters slightly frame-to-frame even when the
same real thing is continuously present (each frame is independently
re-scored by the model), so comparing full detection dicts (bbox+confidence
included) would evaluate as "changed" almost every single cycle -- silently
defeating the entire point of push-on-change and spamming updates exactly
as often as a naive fixed-heartbeat design would. Comparing class sets is
stable the same way zoning's integer occupancy count is stable.

Usage (see features/weapon_detection/api.py for a full example):
    from ..common.live_alert_service import LiveAlertService
    service = LiveAlertService(detect_fn=detect_weapons, update_interval=2.0)
    # lifespan: await service.start() / await service.stop()
    # POST /sources route: service.set_sources({cam: url, ...})
    # WebSocket route: await service.handle_connection(ws)
"""
import asyncio

from ..common.cameras import quality as camera_quality
from ..common.video_source import read_frame


class LiveAlertService:
    def __init__(self, detect_fn, update_interval=2.0, confirm_cycles=1,
                 hold_cycles=0, feature_key=None):
        """detect_fn(frame) -> list of {"class", "confidence", "bbox"} dicts.
        Called via asyncio.to_thread from the background loop so a slow/
        CPU-bound model never blocks the event loop or the WebSocket's own
        traffic.

        confirm_cycles / hold_cycles add optional HYSTERESIS -- see
        _apply_hysteresis. The defaults (1 and 0) are a no-op that reproduces
        this class's original behavior exactly, so weapon/fire/emotion detection
        are unaffected; only a caller that opts in sees any difference."""
        self.detect_fn = detect_fn
        self.update_interval = update_interval
        self.confirm_cycles = confirm_cycles
        self.hold_cycles = hold_cycles
        self.feature_key = feature_key   # this feature's name in the camera table
        self._sources = {}           # fallback only, when feature_key is None
        self._last_classes = {}      # {camera_id: frozenset(class_name, ...)} -- for change detection
        self._last_detections = {}   # {camera_id: [detections]} -- last state PUSHED, for snapshots
        self._hits = {}              # {camera_id: {class: leaky sighting count}}
        self._misses = {}            # {camera_id: {class: consecutive misses}}
        self._held = {}              # {camera_id: {class: [last-known detections]}}
        self._ws_clients = set()
        self._task = None

    def _table_sources(self):
        """This service's cameras, from the site table. `feature_key` is the
        table's name for this feature; a service without one keeps using its
        own dict (nothing does today, but the fallback keeps this class
        usable standalone)."""
        if not getattr(self, "feature_key", None):
            return self._table_sources()
        from .cameras import for_feature
        return for_feature(self.feature_key)

    def set_sources(self, sources):
        """Merges (doesn't replace) -- same convention as zoning's POST
        /zones `sources` field: cameras accumulate as they're mentioned."""
        if self.feature_key:
            from .cameras import assign, upsert
            for cam, url in sources.items():
                upsert(cam, url=url)
                assign(cam, self.feature_key, True)
            return
        self._sources.update(sources)

    def remove_source(self, camera_id):
        if self.feature_key:
            from .cameras import assign
            assign(camera_id, self.feature_key, False)
            return
        self._sources.pop(camera_id, None)
        self._last_classes.pop(camera_id, None)
        self._last_detections.pop(camera_id, None)
        self._hits.pop(camera_id, None)
        self._misses.pop(camera_id, None)
        self._held.pop(camera_id, None)

    def sources(self):
        return self._table_sources()

    def snapshot(self):
        return dict(self._last_detections)

    async def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def stop(self):
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def _broadcast(self, msg):
        dead = []
        for ws in list(self._ws_clients):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._ws_clients.discard(ws)

    def _run_cycle(self, sources):
        """Synchronous, CPU-bound -- one live frame per camera -> {camera_id:
        [detections]}. Run inside asyncio.to_thread by _loop."""
        out = {}
        for cam, source in sources.items():
            frame = read_frame(source, quality=camera_quality(cam))
            if frame is not None:
                out[cam] = self.detect_fn(frame)
        return out

    def _apply_hysteresis(self, cam, dets):
        """-> (class set to report, detections to report).

        Detection is INTERMITTENT for some models in a way a presence check
        shouldn't be: a face turns away for one cycle, or a pistol scores as a
        smartphone for one frame (a real, documented case -- see
        docs/live_alerts.md), and raw class-set comparison then reports the thing
        as GONE and back again. For a wanted-person alert that's not merely
        chatty: an empty set tells the backend the person has left, potentially
        cancelling a response.

        Two counters:

        - confirm_cycles: how many sightings before a class is reported at all.
          Sightings ACCUMULATE and are never decremented; what expires is the
          whole tracking entry, after hold_cycles consecutive misses. That makes
          it an M-of-N window rather than "M in a row", which matters: an
          intermittently-visible face may never be caught twice consecutively,
          and an earlier draft that decremented on each miss could never confirm
          someone seen every other cycle -- i.e. it failed on precisely the
          footage this exists for. (Caught by the differential test, not by
          reading the code.)
        - hold_cycles: how many consecutive misses before a class is dropped.
          Reset to 0 by any sighting, because one confirmed sighting is
          conclusive evidence of presence.

        Note what this does NOT do: confirm_cycles suppresses TRANSIENT
        one-cycle flukes only. A systematic false match (a lookalike who scores
        above threshold every single cycle) is confirmed just as readily as a
        real one -- that failure belongs to the threshold, not here, and the two
        must not be confused for each other.

        Held-over detections are re-emitted with "held": True; live ones carry no
        "held" key at all, so a caller using the defaults sees byte-identical
        payloads. A held bbox is stale by up to hold_cycles * update_interval
        seconds -- the flag exists so a UI can render it differently rather than
        drawing a confident box around empty floor."""
        hits = self._hits.setdefault(cam, {})
        misses = self._misses.setdefault(cam, {})
        held = self._held.setdefault(cam, {})

        seen = {}
        for d in dets:
            seen.setdefault(d["class"], []).append(d)

        for cls in seen:
            hits[cls] = hits.get(cls, 0) + 1
            misses[cls] = 0
        for cls in set(hits) - set(seen):
            misses[cls] = misses.get(cls, 0) + 1

        # At the defaults (confirm_cycles=1, hold_cycles=0) this reduces to
        # exactly "every class seen this cycle": a seen class has hits >= 1 and
        # misses == 0, and any unseen class has misses >= 1 > 0.
        reported = {c for c in hits
                    if hits[c] >= self.confirm_cycles and misses[c] <= self.hold_cycles}

        # Order-preserving FILTER of the original list, never a dict keyed by
        # class: every engine returns detections sorted by confidence descending,
        # and duplicate classes in one frame are legal (two faces matching one
        # name, two happy people). Rebuilding via {d["class"]: d} would silently
        # dedupe and reorder -- a real regression for the existing consumers.
        out = [d for d in dets if d["class"] in reported]
        for cls in reported - set(seen):
            out.extend(held.get(cls, []))

        if self.hold_cycles > 0:                       # skip pointless copying at the default
            for cls, ds in seen.items():
                held[cls] = [dict(d, held=True) for d in ds]
        # Expiry is the same rule for confirmed and still-confirming classes, so
        # hold_cycles doubles as the "forget an unconfirmed sighting" window. At
        # the default 0 an unseen class is dropped immediately, so the three
        # existing consumers accumulate no per-camera state at all.
        for cls in [c for c in hits if misses[c] > self.hold_cycles]:
            hits.pop(cls, None)
            misses.pop(cls, None)
            held.pop(cls, None)
        return frozenset(reported), out

    async def _loop(self):
        while True:
            sources_snapshot = self._table_sources()
            if sources_snapshot:
                try:
                    results = await asyncio.to_thread(self._run_cycle, sources_snapshot)
                    # NOTE: iterating results (not self._sources) is what makes a
                    # camera OUTAGE different from absence -- _run_cycle omits
                    # cameras whose read_frame returned None, so an offline
                    # camera's miss counters never advance and a wanted person
                    # doesn't decay out of existence because their stream dropped.
                    for cam, dets in results.items():
                        new_classes, dets = self._apply_hysteresis(cam, dets)
                        old_classes = self._last_classes.get(cam, frozenset())
                        if new_classes != old_classes:
                            self._last_classes[cam] = new_classes
                            self._last_detections[cam] = dets
                            await self._broadcast({"type": "update", "camera": cam, "detections": dets})
                except Exception as e:
                    print(f"[live_alert_service] detection cycle failed: {e}")
            await asyncio.sleep(self.update_interval)

    async def handle_connection(self, ws):
        await ws.accept()
        self._ws_clients.add(ws)
        try:
            await ws.send_json({"type": "snapshot", "cameras": self.snapshot()})
            while True:
                # bare receive() returns a dict and does NOT raise on
                # disconnect -- only receive_text()/receive_json() do that.
                # Must check the type and break manually (see
                # features/zoning/api.py's identical fix for why).
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
        finally:
            self._ws_clients.discard(ws)
