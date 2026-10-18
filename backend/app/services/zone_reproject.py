"""World zones follow a recalibration.

A world zone is stored as a floor outline (polygon_m), converted once from
the pixels it was drawn on through that camera's calibration of the time.
Recalibrating or re-aligning moves the floor frame, and the old outline then
lies somewhere else on the floor (2026-10-18 day test: after the 1 m
recalibration the kiosk zone no longer covered the kiosk). The AI service
keeps what the zone was drawn from (converted_from: camera + pixels), so
re-saving it from there converts it again with the current calibration.
"""

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import forward
from app.models.entities import Camera

logger = logging.getLogger(__name__)


def redraw_world_zones(db: Session) -> dict[str, list[str]]:
    """Re-save every world zone from its original pixels. A zone whose
    camera is not calibrated and aligned (yet) keeps its old outline and is
    reported in `not_redrawn`. Never raises."""
    redrawn: list[str] = []
    not_redrawn: list[str] = []
    try:
        response = forward("GET", "/zoning/zones")
        zones = response.json() if response.status_code == 200 else {}
    except Exception:
        logger.warning("zone-reproject: could not read zones")
        return {"redrawn": redrawn, "not_redrawn": not_redrawn}

    for name, zone in (zones or {}).items():
        source = zone.get("converted_from") if isinstance(zone, dict) else None
        if zone.get("mode") != "world" or not isinstance(source, dict):
            continue
        camera = db.scalar(select(Camera).where(Camera.name == source.get("camera")))
        if camera is None or not camera.stream_url or not source.get("polygon_px"):
            not_redrawn.append(name)
            continue
        # A world zone is saved with 2+ sources; the outline is converted
        # through `camera` alone, so any other camera of the branch will do.
        other = db.scalar(
            select(Camera).where(
                Camera.agency_id == camera.agency_id,
                Camera.id != camera.id,
                Camera.stream_url.is_not(None),
            )
        )
        if other is None:
            not_redrawn.append(name)
            continue
        try:
            saved = forward(
                "POST",
                "/zoning/zones",
                json={
                    "name": name,
                    "camera": camera.name,
                    "polygon": source["polygon_px"],
                    "sources": {camera.name: camera.stream_url, other.name: other.stream_url},
                },
            )
            (redrawn if saved.status_code == 200 else not_redrawn).append(name)
        except Exception:
            not_redrawn.append(name)

    if redrawn:
        # Restricted zones are read from the AI service on a timer; read now.
        from app.services.zone_watch import zone_watcher

        zone_watcher.refresh_zones()
    logger.info("zone-reproject: redrawn %s, kept %s", redrawn, not_redrawn)
    return {"redrawn": redrawn, "not_redrawn": not_redrawn}
