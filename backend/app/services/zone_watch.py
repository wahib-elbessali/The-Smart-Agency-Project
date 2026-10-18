"""Restricted camera zones: an alert when someone stands where they may not.

A zone's rule (ZoneRule) is "staff" (only people the tracker has linked to
an employee of the branch) or "nobody". Once a second, this compares every
live track (people_tracking's snapshot) against each restricted zone's
floor polygon. Anyone not allowed who stays longer than the grace period
opens one CRITICAL "intrusion" alert for that person - sticky like weapon
alerts: a person closes it, or the "It's staff" action links the track and
closes it as a false alarm.

Only world zones (polygon_m, the tracker's own floor frame) can be watched;
a pixel zone has no floor position to compare tracks with.

THE HAND-OFF. The tracker sometimes loses someone and picks them up again
under a new track id, which would turn an employee into a stranger. When a
staff track vanishes and a new, unlinked track appears close to where it
was, soon after, the new track inherits the employee. What this misses, a
person fixes by hand (app/services/track_links.py).

BLIND. With tracking stopped or its stream silent there are no positions,
so no intrusion can ever be seen - which looks exactly like a quiet branch.
A branch with restricted zones then gets one CRITICAL "zone_watch_down"
alert after the same grace as the AI-down alert, resolved on recovery.
"""

import logging
import math
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import camera_id_by_name, forward, raise_for_ai_status
from app.core.config import settings
from app.database.connection import SessionLocal
from app.models.entities import Alert, AlertSeverity, AlertStatus, Employee, EmployeeStatus, ZoneRule
from app.services.notification_service import notify_critical_alerts
from app.services.people_tracking import people_track_tracker, point_in_polygon, resolve_kiosk_camera_name
from app.websocket.alert_state import alert_state_manager, alert_state_payload


logger = logging.getLogger(__name__)

RESTRICTIONS = ("staff", "nobody")
INTRUSION = "intrusion"
WATCH_DOWN = "zone_watch_down"
# Only current staff count as staff (an offboarded employee is a stranger).
ACTIVE_STAFF = (Employee.is_active.is_(True), Employee.status == EmployeeStatus.ACTIVE)
ACTIVE = (AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)
_ZONES_REFRESH_SECONDS = 10.0


def floor_polygon(zone: dict[str, Any]) -> list[list[float]] | None:
    """A world zone's polygon in the tracks' floor units (polygon_m is
    exported as units / 100), None for anything else."""
    polygon = zone.get("polygon_m")
    if not isinstance(polygon, list) or len(polygon) < 3:
        return None
    try:
        return [[float(x) * 100.0, float(y) * 100.0] for x, y in polygon]
    except (TypeError, ValueError):
        return None


def intrusion_title(zone_name: str) -> str:
    return f"Intrusion: {zone_name}"


class ZoneWatcher:
    def __init__(self) -> None:
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        # track id -> last floor position, from the previous tick
        self._previous: dict[str, tuple[float, float]] = {}
        # employee id -> (x, y, when) of a staff track that just vanished
        self._lost: dict[str, tuple[float, float, datetime]] = {}
        # (agency id, zone name, track id) -> since when they are there
        self._inside: dict[tuple[str, str, str], datetime] = {}
        self._zones: dict[str, dict[str, Any]] = {}
        self._zones_at = 0.0
        self._blind_since: datetime | None = None

    def start(self) -> None:
        if not settings.ai_alerts_enabled or (self._thread is not None and self._thread.is_alive()):
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="zone-watch", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.tick()
            except Exception:
                logger.exception("zone-watch: tick failed")
            self._stop_event.wait(1.0)

    def refresh_zones(self) -> None:
        """Read the zones again on the next tick (they were just redrawn)."""
        self._zones_at = 0.0

    def _load_zones(self) -> dict[str, dict[str, Any]]:
        if time.monotonic() - self._zones_at >= _ZONES_REFRESH_SECONDS:
            try:
                response = forward("GET", "/zoning/zones")
                raise_for_ai_status(response)
                body = response.json()
                self._zones = body if isinstance(body, dict) else {}
                self._zones_at = time.monotonic()
            except Exception:
                # Keep the last known zones: an AI hiccup must not blind the watch.
                logger.warning("zone-watch: could not fetch zones")
        return self._zones

    def tick(
        self,
        now: datetime | None = None,
        tracks: dict[str, dict[str, Any]] | None = None,
        zones: dict[str, dict[str, Any]] | None = None,
        live: bool | None = None,
    ) -> None:
        """One pass. Arguments are for tests; by default it reads the live
        tracks and the AI service's zones."""
        now = now or datetime.now(timezone.utc)
        if live is None:
            live = people_track_tracker.is_live() if tracks is None else True
        tracks = people_track_tracker.tracks_snapshot() if tracks is None else tracks
        events: list[dict] = []
        opened: list[str] = []
        db = SessionLocal()
        try:
            self._hand_off(db, tracks, now)
            rules = db.scalars(select(ZoneRule)).all()
            self._watch_health(db, rules, live, now, events, opened)
            if rules:
                zones = self._load_zones() if zones is None else zones
                self._watch(db, rules, zones, tracks, now, events, opened)
            else:
                self._inside.clear()
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
        self._previous = {tid: (t["x"], t["y"]) for tid, t in tracks.items()}
        for event in events:
            alert_state_manager.broadcast_from_thread(event)
        notify_critical_alerts(opened)

    def _watch_health(
        self,
        db: Session,
        rules: list[ZoneRule],
        live: bool,
        now: datetime,
        events: list[dict],
        opened: list[str],
    ) -> None:
        active = select(Alert).where(Alert.alert_type == WATCH_DOWN, Alert.status.in_(ACTIVE))
        if live or not rules:
            self._blind_since = None
            for alert in db.scalars(active).all():
                alert.status, alert.resolved_at = AlertStatus.RESOLVED, now
                events.append(alert_state_payload(alert, "", "resolved"))
            return
        self._blind_since = self._blind_since or now
        if now - self._blind_since < timedelta(seconds=settings.health_down_grace_seconds):
            return
        for agency_id in sorted({rule.agency_id for rule in rules}):
            if db.scalar(active.where(Alert.agency_id == agency_id)) is not None:
                continue
            names = ", ".join(sorted(r.zone_name for r in rules if r.agency_id == agency_id))
            alert = Alert(
                agency_id=agency_id,
                alert_type=WATCH_DOWN,
                title="Surveillance des zones restreintes interrompue",
                message=f"Le suivi des personnes ne fonctionne plus: aucune intrusion ne peut etre "
                f"detectee dans {names}.",
                severity=AlertSeverity.CRITICAL,
                status=AlertStatus.OPEN,
            )
            db.add(alert)
            db.flush()
            opened.append(alert.id)
            events.append(alert_state_payload(alert, "", "created"))
            logger.warning("zone-watch: blind for agency %s", agency_id)

    def _hand_off(self, db: Session, tracks: dict[str, dict[str, Any]], now: datetime) -> None:
        staff = {
            e.tracking_id: e
            for e in db.scalars(select(Employee).where(Employee.tracking_id.is_not(None), *ACTIVE_STAFF)).all()
        }
        for tid, (x, y) in self._previous.items():
            if tid not in tracks and tid in staff:
                self._lost[staff[tid].id] = (x, y, now)
        window = timedelta(seconds=settings.zone_handoff_seconds)
        self._lost = {k: v for k, v in self._lost.items() if now - v[2] <= window}
        if not self._lost:
            return

        for tid, track in tracks.items():
            if tid in self._previous or tid in staff:
                continue
            best, best_d = None, settings.zone_handoff_distance
            for employee_id, (x, y, _when) in self._lost.items():
                d = math.hypot(track["x"] - x, track["y"] - y)
                if d <= best_d:
                    best, best_d = employee_id, d
            if best is None:
                continue
            employee = db.get(Employee, best)
            del self._lost[best]
            # Re-badged meanwhile onto a live track: that link is fresher.
            if employee is None or (employee.tracking_id in tracks and employee.tracking_id != tid):
                continue
            logger.info("zone-watch: track %s continues employee %s", tid, employee.id)
            employee.tracking_id = tid
            staff[tid] = employee

    def _watch(
        self,
        db: Session,
        rules: list[ZoneRule],
        zones: dict[str, dict[str, Any]],
        tracks: dict[str, dict[str, Any]],
        now: datetime,
        events: list[dict],
        opened: list[str],
    ) -> None:
        staff_by_agency: dict[str, set[str]] = {}
        for e in db.scalars(select(Employee).where(Employee.tracking_id.is_not(None), *ACTIVE_STAFF)).all():
            staff_by_agency.setdefault(e.agency_id, set()).add(e.tracking_id)

        grace = timedelta(seconds=settings.zone_intrusion_grace_seconds)
        still_inside: dict[tuple[str, str, str], datetime] = {}
        for rule in rules:
            zone = zones.get(rule.zone_name)
            polygon = floor_polygon(zone) if isinstance(zone, dict) else None
            if polygon is None:
                continue
            allowed = staff_by_agency.get(rule.agency_id, set()) if rule.restriction == "staff" else set()
            for tid, track in tracks.items():
                if tid in allowed or not point_in_polygon(track["x"], track["y"], polygon):
                    continue
                key = (rule.agency_id, rule.zone_name, tid)
                since = self._inside.get(key, now)
                still_inside[key] = since
                if now - since >= grace:
                    self._raise(db, rule, zone, tid, since, events, opened)
        self._inside = still_inside

    def _raise(
        self,
        db: Session,
        rule: ZoneRule,
        zone: dict[str, Any],
        tracking_id: str,
        since: datetime,
        events: list[dict],
        opened: list[str],
    ) -> None:
        existing = db.scalar(
            select(Alert).where(
                Alert.agency_id == rule.agency_id,
                Alert.alert_type == INTRUSION,
                Alert.tracking_id == tracking_id,
                Alert.status.in_(ACTIVE),
            )
        )
        if existing is not None:
            return
        # A person closed this one while they were still here: dealt with
        # (escorted, known). Silent until they leave the zone; coming back
        # later is a new stay, and a new alert.
        closed = db.scalar(
            select(Alert.resolved_at)
            .where(
                Alert.agency_id == rule.agency_id,
                Alert.alert_type == INTRUSION,
                Alert.tracking_id == tracking_id,
                Alert.title == intrusion_title(rule.zone_name),
                Alert.status == AlertStatus.RESOLVED,
            )
            .order_by(Alert.resolved_at.desc())
        )
        if closed is not None:
            if closed.tzinfo is None:
                closed = closed.replace(tzinfo=timezone.utc)
            if closed >= since:
                return
        camera_name = resolve_kiosk_camera_name(zone)
        who = "reservee au personnel" if rule.restriction == "staff" else "interdite a tous"
        alert = Alert(
            agency_id=rule.agency_id,
            camera_id=camera_id_by_name(db, camera_name) if camera_name else None,
            tracking_id=tracking_id,
            alert_type=INTRUSION,
            title=intrusion_title(rule.zone_name),
            message=f"Personne non autorisee dans {rule.zone_name} (zone {who}), personne suivie {tracking_id}",
            severity=AlertSeverity.CRITICAL,
            status=AlertStatus.OPEN,
        )
        db.add(alert)
        db.flush()
        opened.append(alert.id)
        events.append(alert_state_payload(alert, camera_name or "", "created"))
        logger.warning("zone-watch: %s in %s", tracking_id, rule.zone_name)


zone_watcher = ZoneWatcher()
