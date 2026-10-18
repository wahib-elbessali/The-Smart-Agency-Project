"""Badge + face doors.

A badge room can require the face of the badge holder as well as the badge
(Zone.access_mode = "rfid_face"). After the badge check passes, the door's
own camera is asked once - POST /face/scan, the AI service's on-demand
access-control call, nothing runs between badge taps - who is standing in
front of it. The door opens only if the face is the badge holder's.

Employee faces are enrolled under a key tied to the employee
(`emp-<employee id>`, app/api/employee_faces.py), so "the face matches the
badge holder" is an exact comparison, not name guessing.

Fails closed: no door camera, the AI or camera down, nobody in view, an
unknown face or someone else's face all keep the door shut, each with its
own reason so the failed-badge log says which. Fire and gas emergency unlock
(door_control_service) does not go through here and still opens doors.
"""

import logging
from dataclasses import dataclass

import httpx
from fastapi import HTTPException

from app.ai_alerts.ai_service import forward
from app.core.config import settings
from app.models.entities import Camera

logger = logging.getLogger(__name__)


def face_key(employee_id: str) -> str:
    """The AI face-gallery name an employee's face is enrolled under."""
    return f"emp-{employee_id}"


@dataclass(frozen=True)
class FaceCheck:
    ok: bool
    # Machine reason for the failed-badge log; None when ok.
    reason: str | None
    # What the door reader shows, French like every other door message.
    message: str


def verify_face(camera: Camera | None, employee_id: str) -> FaceCheck:
    if camera is None or not camera.stream_url:
        return FaceCheck(False, "face_no_camera", "Camera de porte non configuree")
    timeout = settings.door_face_timeout_seconds
    try:
        response = forward(
            "POST",
            "/face/scan",
            json={"source": camera.stream_url, "timeout_seconds": timeout},
            timeout=timeout + 5,
        )
    except (HTTPException, httpx.HTTPError):
        logger.warning("door face check: AI service unreachable for camera %s", camera.name)
        return FaceCheck(False, "face_unavailable", "Verification du visage indisponible")
    if response.status_code == 409:
        return FaceCheck(False, "face_busy", "Verification en cours, reessayez")
    if response.status_code != 200:
        return FaceCheck(False, "face_unavailable", "Verification du visage indisponible")
    result = response.json()
    if result.get("error"):
        return FaceCheck(False, "face_camera_error", "Camera de porte indisponible")
    if result.get("timed_out"):
        return FaceCheck(False, "face_not_seen", "Visage non detecte, regardez la camera")
    if result.get("name") == face_key(employee_id):
        return FaceCheck(True, None, "Acces autorise")
    if result.get("name") is None:
        return FaceCheck(False, "face_unknown", "Visage non reconnu")
    return FaceCheck(False, "face_mismatch", "Le visage ne correspond pas au badge")
