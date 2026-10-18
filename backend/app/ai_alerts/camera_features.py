"""Which AI detections each camera runs.

Every consumer used to register every camera with a stream URL, so all four
models ran on all cameras - a face model on an overhead camera that never
sees a face clearly, at the cost of GPU and of poor matches. A camera now
lists the detections it runs (Camera.ai_features); NULL keeps the old "all
of them" behaviour so existing cameras are unaffected.

Person tracking and zones are not here: those cameras are chosen on the Live
map and Zones screens.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.entities import Alert, AlertStatus, Camera

logger = logging.getLogger(__name__)

CAMERA_AI_FEATURES = ("weapon", "fire", "wanted", "emotion")


def runs_feature(camera: Camera, feature: str) -> bool:
    return camera.ai_features is None or feature in camera.ai_features


def sources_for(db: Session, feature: str) -> dict[str, str]:
    """{camera name: stream url} for every camera that runs `feature`."""
    cameras = db.scalars(
        select(Camera).where(Camera.stream_url.is_not(None)).order_by(Camera.name)
    ).all()
    return {
        camera.name: camera.stream_url
        for camera in cameras
        if camera.stream_url and runs_feature(camera, feature)
    }


def close_alerts_off_feature(alert_type: str, running: set[str]) -> int:
    """Resolve every active `alert_type` alert whose camera no longer runs it.

    The AI service sends no "all clear" when a camera is removed from a
    feature - it just stops watching - so without this an alert open at that
    moment stayed open forever. Run on every sources sync, so it also clears
    what a restart left behind. Never raises. Returns how many it closed.
    """
    db = SessionLocal()
    try:
        alerts = db.scalars(
            select(Alert)
            .join(Camera, Camera.id == Alert.camera_id)
            .where(
                Alert.alert_type == alert_type,
                Alert.status.in_((AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)),
                Camera.name.not_in(running) if running else Camera.name.is_not(None),
            )
        ).all()
        now = datetime.now(timezone.utc)
        for alert in alerts:
            alert.status = AlertStatus.RESOLVED
            alert.resolved_at = now
        db.commit()
        if alerts:
            logger.info("%s: closed %d alert(s) on cameras no longer running it", alert_type, len(alerts))
        return len(alerts)
    except Exception:
        db.rollback()
        logger.exception("%s: could not close alerts of cameras that stopped running it", alert_type)
        return 0
    finally:
        db.close()
