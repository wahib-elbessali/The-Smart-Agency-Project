"""Shared plumbing for every backend route that proxies the AI service
(calibration, zones-world, people, face, watchlist) - the browser never
reaches the AI service directly (project rule, 2026-08-11: the AI
service has no authentication of its own, and several of these routes
carry biometric data), so every one of these calls goes browser -> this
backend (real auth + role check) -> AI service (server-side, no auth
needed since it's not exposed) -> back.

Camera translation is the other half every proxy needs: the browser
speaks our camera UUIDs, the AI service speaks the globally-unique
Camera.name (see Camera.__table_args__'s uq_camera_name) - the exact
mapping app/ai_alerts/consumer.py already uses for the alert streams.
"""

from typing import Any

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.entities import Camera


def ai_base_url() -> str:
    return settings.ai_service_url.rstrip("/")


def camera_name_or_404(db: Session, camera_id: str) -> str:
    camera = db.get(Camera, camera_id)
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera introuvable")
    return camera.name


def camera_ids_to_names(db: Session, camera_ids: list[str]) -> dict[str, str]:
    """{our uuid: AI-service name}, 404 on the first one that doesn't exist -
    every proxy needs every named camera to be real before it forwards
    anything, same as a bad camera_id anywhere else in this app."""
    names: dict[str, str] = {}
    for camera_id in camera_ids:
        names[camera_id] = camera_name_or_404(db, camera_id)
    return names


def camera_id_by_name(db: Session, name: str) -> str | None:
    """The reverse direction, for translating an AI-service response back -
    None (not a 404) when the AI service mentions a camera name this
    backend doesn't recognise, since that's the AI service's own data, not
    a caller error. Mirrors Alert.camera_id's own null-when-unmatched
    convention."""
    camera_id = db.scalar(select(Camera.id).where(Camera.name == name))
    return camera_id


def forward(
    method: str,
    path: str,
    *,
    json: Any = None,
    files: Any = None,
    data: Any = None,
    params: dict[str, Any] | None = None,
    timeout: float = 10.0,
) -> httpx.Response:
    """One request to the AI service, with the one error translation every
    proxy needs: the AI service being unreachable is a 503 from THIS
    backend's point of view (it's a real, distinct failure from "the
    request itself was bad"), never a bare 500 that reads like a bug here."""
    try:
        with httpx.Client(timeout=timeout) as client:
            return client.request(
                method, f"{ai_base_url()}{path}", json=json, files=files, data=data, params=params
            )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503, detail=f"Service IA indisponible: {exc}"
        ) from exc


def raise_for_ai_status(response: httpx.Response) -> None:
    """Passes the AI service's own refusal through rather than flattening
    it to a generic 500 - a 422 there (e.g. calibration's collinear-points
    refusal) is real, useful information for whoever is clicking points."""
    if response.status_code >= 400:
        try:
            detail = response.json().get("detail", response.text)
        except ValueError:
            detail = response.text
        raise HTTPException(status_code=response.status_code, detail=detail)
