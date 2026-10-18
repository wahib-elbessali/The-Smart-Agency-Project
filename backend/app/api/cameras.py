import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import forward, raise_for_ai_status
from app.ai_alerts.consumer import weapon_alert_consumer
from app.ai_alerts.fire_consumer import fire_alert_consumer
from app.ai_alerts.wanted_consumer import wanted_alert_consumer
from app.ai_alerts.emotion_consumer import emotion_consumer
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Agency, Camera, Counter, EmotionSample, RoleName, User
from app.schemas.camera import CameraCreate, CameraResponse, CameraUpdate


logger = logging.getLogger(__name__)

router = APIRouter(tags=["Cameras"])
CAMERA_ROLES = [
    Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))
]


def ensure_agency_scope(agency_id: str, current_user: User) -> None:
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")


def get_agency_or_404(agency_id: str, db: Session) -> Agency:
    agency = db.get(Agency, agency_id)
    if agency is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")
    return agency


def get_camera_or_404(camera_id: str, db: Session) -> Camera:
    camera = db.get(Camera, camera_id)
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera introuvable")
    return camera


def ensure_unique_name(name: str, db: Session, camera_id: str | None = None) -> None:
    query = select(Camera).where(Camera.name == name)
    if camera_id is not None:
        query = query.where(Camera.id != camera_id)
    if db.scalar(query) is not None:
        raise HTTPException(
            status_code=409,
            detail="Le nom de la camera doit etre unique et correspondre au nom de la source IA",
        )


def ensure_unique_stream_url(stream_url: str, db: Session, camera_id: str | None = None) -> None:
    query = select(Camera).where(Camera.stream_url == stream_url)
    if camera_id is not None:
        query = query.where(Camera.id != camera_id)
    if db.scalar(query) is not None:
        raise HTTPException(
            status_code=409,
            detail="Le flux de la camera est deja utilise par une autre camera",
        )


def camera_integrity_error_detail(exc: IntegrityError) -> str:
    constraint_name = getattr(getattr(getattr(exc, "orig", None), "diag", None), "constraint_name", None)
    if constraint_name == "uq_camera_stream_url":
        return "Le flux de la camera est deja utilise par une autre camera"
    return "Le nom de la camera est deja utilise"


def ai_setup_using(name: str) -> list[str]:
    """What the AI service has stored under this camera's name, so a rename
    cannot silently orphan it. Empty when the AI service cannot be asked: the
    rename then goes ahead, which is how cameras worked before this check."""
    used = []
    try:
        calibration = forward("GET", "/calibration")
        if calibration.status_code == 200 and name in calibration.json():
            used.append("calibration")
        zones = forward("GET", "/zoning/zones")
        if zones.status_code == 200:
            for zone in zones.json().values():
                source = zone.get("camera") or (zone.get("converted_from") or {}).get("camera")
                if source == name:
                    used.append("zones")
                    break
    except HTTPException:
        logger.warning("AI service unreachable, camera %s rename not checked against it", name)
    return used


def forget_in_ai(name: str) -> None:
    """Stop the AI service processing a camera that no longer exists under this
    name. Best effort: the camera row is the truth and the AI service may be down."""
    try:
        forward("DELETE", f"/cameras/{quote(name, safe='')}")
    except HTTPException:
        logger.warning("AI service unreachable, camera %s not removed from it", name)


@router.get(
    "/agencies/{agency_id}/cameras",
    response_model=list[CameraResponse],
    dependencies=CAMERA_ROLES,
)
def list_cameras(
    agency_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CameraResponse]:
    get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    return list(
        db.scalars(select(Camera).where(Camera.agency_id == agency_id).order_by(Camera.name)).all()
    )


@router.post(
    "/agencies/{agency_id}/cameras",
    response_model=CameraResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=CAMERA_ROLES,
)
def create_camera(
    agency_id: str,
    payload: CameraCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CameraResponse:
    agency = get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency.id, current_user)
    name = payload.name.strip()
    stream_url = payload.stream_url.strip()
    if not name or not stream_url:
        raise HTTPException(status_code=422, detail="Le nom et le flux de la camera sont obligatoires")
    ensure_unique_name(name, db)
    ensure_unique_stream_url(stream_url, db)

    camera = Camera(
        agency_id=agency.id, name=name, stream_url=stream_url, ai_features=payload.ai_features
    )
    db.add(camera)
    try:
        db.commit()
        db.refresh(camera)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=camera_integrity_error_detail(exc)) from exc
    weapon_alert_consumer.request_sync()
    fire_alert_consumer.request_sync()
    wanted_alert_consumer.request_sync()
    emotion_consumer.request_sync()
    return camera


@router.put(
    "/cameras/{camera_id}",
    response_model=CameraResponse,
    dependencies=CAMERA_ROLES,
)
def update_camera(
    camera_id: str,
    payload: CameraUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CameraResponse:
    camera = get_camera_or_404(camera_id, db)
    ensure_agency_scope(camera.agency_id, current_user)
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes:
        changes["name"] = changes["name"].strip()
        if not changes["name"]:
            raise HTTPException(status_code=422, detail="Le nom de la camera est obligatoire")
        ensure_unique_name(changes["name"], db, camera.id)
        if changes["name"] != camera.name:
            used = ai_setup_using(camera.name)
            if used:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Cette camera a une "
                        + " et des ".join(used)
                        + " cote IA enregistres sous son nom actuel. Supprimez-les avant de la renommer"
                    ),
                )
    if "stream_url" in changes:
        changes["stream_url"] = changes["stream_url"].strip()
        if not changes["stream_url"]:
            raise HTTPException(status_code=422, detail="Le flux de la camera est obligatoire")
        ensure_unique_stream_url(changes["stream_url"], db, camera.id)
    old_name = camera.name
    for field, value in changes.items():
        setattr(camera, field, value)

    try:
        db.commit()
        db.refresh(camera)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=camera_integrity_error_detail(exc)) from exc
    if camera.name != old_name:
        forget_in_ai(old_name)
    weapon_alert_consumer.request_sync()
    fire_alert_consumer.request_sync()
    wanted_alert_consumer.request_sync()
    emotion_consumer.request_sync()
    return camera


@router.delete(
    "/cameras/{camera_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def delete_camera(
    camera_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    camera = get_camera_or_404(camera_id, db)
    ensure_agency_scope(camera.agency_id, current_user)
    # Records that pointed at the camera outlive it, without the reference.
    for alert in camera.alerts:
        alert.camera_id = None
    db.execute(
        update(EmotionSample).where(EmotionSample.camera_id == camera.id).values(camera_id=None)
    )
    db.execute(update(Counter).where(Counter.emotion_camera_id == camera.id).values(emotion_camera_id=None))
    name = camera.name
    db.delete(camera)
    db.commit()
    forget_in_ai(name)
    weapon_alert_consumer.request_sync()
    fire_alert_consumer.request_sync()
    wanted_alert_consumer.request_sync()
    emotion_consumer.request_sync()


@router.get("/cameras/{camera_id}/frame", dependencies=CAMERA_ROLES)
def get_camera_frame(
    camera_id: str,
    native: bool = False,
    format: str = "jpeg",
    quality: int = 75,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """contracts/ai-service.md's `GET /frame`, proxied so the browser never
    reaches the AI service directly (project rule, 2026-08-11) - see
    api/endpoints/cameras.ts's own doc comment on the frontend for the two
    callers this serves. `native=true` skips format/quality entirely so the
    AI service returns the frame at its own native resolution, required for
    calibration's 4-point click (see fetchNativeFrame's doc comment); the
    detector-scaled frame otherwise, so alert boxes from the AI stream land
    in the right place on top of it."""
    camera = get_camera_or_404(camera_id, db)
    ensure_agency_scope(camera.agency_id, current_user)

    params: dict = {"camera": camera.name}
    if not native:
        params["format"] = format
        params["quality"] = quality

    response = forward("GET", "/frame", params=params)
    raise_for_ai_status(response)
    return Response(
        content=response.content,
        media_type=response.headers.get("content-type", "image/jpeg"),
    )
