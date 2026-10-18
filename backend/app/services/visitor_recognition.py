"""Returning-visitor recognition by face alone - no name, phone, or ID ever
required (scenario-planning backlog, docs/scenario-planning-backlog.md,
Phase D).

/face/capture (contracts/ai-service.md) is deliberately stateless and
identity-free: it watches a camera source until a face appears, and returns
a photo + a 512-float embedding with no gallery matching, no name in, no
name out - "deciding new vs. returning visitor is entirely the caller's
job." This module is that job, split the same way every other correlation
in this backlog is:

  - CAPTURE is eager, at kiosk ticket time, as a background task (this is a
    slow, blocking AI call - up to several seconds waiting for a face -
    never allowed on the request path that prints a ticket).
  - MATCHING is lazy, computed at Insights query time (app/api/insights.py),
    not precomputed here. This keeps the background task to one job -
    capture and store one embedding - and keeps the "who does this
    resemble" logic in one place instead of split across write and read.
"""

import logging
import math

from sqlalchemy import select

from app.ai_alerts.ai_service import forward
from app.database.connection import SessionLocal
from app.models.entities import Camera, Ticket, Visitor
from app.services.people_tracking import _fetch_zone, resolve_kiosk_camera_name


logger = logging.getLogger(__name__)

# Same default the AI service's own wanted-list match uses
# (contracts/ai-service.md, GET /wanted/threshold's startup_default). Not
# manager-configurable in this phase - same scope boundary every other
# threshold in this backlog has shipped without a settings UI.
FACE_MATCH_THRESHOLD = 0.5


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def capture_face_embedding(stream_url: str, timeout_seconds: float = 10.0) -> list[float] | None:
    """One best-effort attempt - a timeout (nobody in frame), the shared
    409 double-scan guard (another capture already in flight on this same
    source), or any other failure all just mean "no embedding this time,"
    never raised. The extra 5s on the HTTP timeout is slack beyond the
    AI-side wait itself, not a second wait layered on top of it."""
    try:
        response = forward(
            "POST",
            "/face/capture",
            json={"source": stream_url, "timeout_seconds": timeout_seconds},
            timeout=timeout_seconds + 5,
        )
        if response.status_code != 200:
            return None
        body = response.json()
        if body.get("timed_out") or body.get("error"):
            return None
        embedding = body.get("embedding")
        if not isinstance(embedding, list) or not embedding:
            return None
        return [float(v) for v in embedding]
    except Exception:
        logger.warning("visitor-recognition: face capture failed for %r", stream_url)
        return None


def link_visitor_face(ticket_id: str, agency_id: str) -> None:
    """Runs as a FastAPI background task, after the kiosk already has its
    ticket number - the AI call this makes can take several real seconds,
    which must never delay printing a ticket. Opens its own session, same
    reason as link_ticket_tracking: the request's session is already closed
    by the time a background task runs."""
    db = SessionLocal()
    try:
        ticket = db.get(Ticket, ticket_id)
        if ticket is None:
            return
        visitor = db.get(Visitor, ticket.visitor_id)
        if visitor is None:
            return

        agency = visitor.agency
        if agency is None:
            return
        # The kiosk's face camera (set on the agency) sees faces up close; an
        # overhead camera barely does. Without one, fall back to the camera
        # the kiosk zone was drawn on, as before.
        camera = db.get(Camera, agency.kiosk_face_camera_id) if agency.kiosk_face_camera_id else None
        if camera is None:
            if not agency.kiosk_zone_name:
                return
            zone = _fetch_zone(agency.kiosk_zone_name)
            if zone is None:
                return
            camera_name = resolve_kiosk_camera_name(zone)
            if camera_name is None:
                return
            camera = db.scalar(select(Camera).where(Camera.name == camera_name))
        stream_url = camera.stream_url if camera else None
        if not stream_url:
            return

        embedding = capture_face_embedding(stream_url)
        if embedding is None:
            return

        visitor.face_embedding = embedding
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("visitor-recognition: could not capture face for ticket %s", ticket_id)
    finally:
        db.close()
