"""Business-level filtering for weapon detections.

The computer-vision service has its own model ``conf`` setting. This module
keeps the backend threshold that decides whether a received detection becomes
an alert. It is updated immediately by the REST API and is safe to read from
the AI consumer thread.
"""

from threading import Lock
from typing import Any


DEFAULT_WEAPON_THRESHOLD = 0.6
_lock = Lock()
_weapon_threshold = DEFAULT_WEAPON_THRESHOLD


def get_seuil_confiance_arme() -> float:
    with _lock:
        return _weapon_threshold


def definir_seuil_confiance_arme(confidence: float) -> float:
    if confidence <= 0 or confidence > 1:
        raise ValueError("Le seuil doit etre strictement superieur a 0 et inferieur ou egal a 1")
    global _weapon_threshold
    with _lock:
        _weapon_threshold = float(confidence)
        return _weapon_threshold


def filtrer_detections_armes(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only valid detections at or above the current business threshold."""
    threshold = get_seuil_confiance_arme()
    return [
        detection
        for detection in detections
        if isinstance(detection, dict)
        and isinstance(detection.get("confidence"), (int, float))
        and float(detection["confidence"]) >= threshold
    ]
