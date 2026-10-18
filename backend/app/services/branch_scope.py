"""Keeping one branch's manager out of another branch's AI configuration.

The AI service is one per site: calibration, people-tracking sources, the
watchlist and the face gallery are single site-wide stores. On a site with
several branches that let a MANAGER recalibrate another branch's cameras or
drop someone from the watchlist, with no record of who did it (2026-10-18
comparison with master, which scopes these per branch).

- Camera-shaped settings: a MANAGER only acts on their own branch's cameras.
- Gallery entries (watchlist, faces): each name records the branch that added
  it (GalleryEntry). Entries from before this have no owner; a MANAGER sees
  them only while the site has a single branch, where they can only be theirs.
- Truly site-wide knobs (the watchlist match threshold): a MANAGER may change
  them only on a single-branch site.
Every gallery change is written to the audit log.
"""

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.entities import Agency, AuditLog, Camera, GalleryEntry, RoleName, User

OUTSIDE = "Acces limite a votre agence"


def is_admin(user: User) -> bool:
    return user.role.name == RoleName.ADMIN


def single_branch_site(db: Session) -> bool:
    return (db.scalar(select(func.count()).select_from(Agency).where(Agency.is_active.is_(True))) or 0) <= 1


def ensure_site_wide_change(db: Session, user: User) -> None:
    """A setting shared by every branch: ADMIN, or a MANAGER of the only branch."""
    if not is_admin(user) and not single_branch_site(db):
        raise HTTPException(status_code=403, detail="Reglage commun a toutes les agences: reserve a l'administrateur")


def camera_in_scope(db: Session, camera: Camera | None, user: User) -> Camera:
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera introuvable")
    if not is_admin(user) and camera.agency_id != user.agency_id:
        raise HTTPException(status_code=403, detail=OUTSIDE)
    return camera


def ensure_camera_id(db: Session, camera_id: str, user: User) -> Camera:
    return camera_in_scope(db, db.get(Camera, camera_id), user)


def own_camera_names(db: Session, user: User) -> set[str] | None:
    """The AI camera names this user may see; None = all (ADMIN)."""
    if is_admin(user):
        return None
    return set(db.scalars(select(Camera.name).where(Camera.agency_id == user.agency_id)).all())


# --- gallery entries (watchlist, faces) --------------------------------------

def gallery_owner(db: Session, kind: str, name: str) -> GalleryEntry | None:
    return db.scalar(select(GalleryEntry).where(GalleryEntry.kind == kind, GalleryEntry.name == name))


def visible_names(db: Session, user: User, kind: str, names: list[str]) -> set[str]:
    if is_admin(user):
        return set(names)
    owners = {
        e.name: e.agency_id
        for e in db.scalars(select(GalleryEntry).where(GalleryEntry.kind == kind)).all()
    }
    single = single_branch_site(db)
    # owners.get(n) is None for an entry with no recorded owner, or no row at all
    return {n for n in names if owners.get(n) == user.agency_id or (owners.get(n) is None and single)}


def ensure_may_change(
    db: Session, user: User, kind: str, name: str, exists: bool = True
) -> GalleryEntry | None:
    """403 when the entry belongs to another branch (or, for an unowned one,
    when the site has several branches and the caller is not ADMIN). A name
    the gallery does not hold yet (`exists` False) is free to take."""
    entry = gallery_owner(db, kind, name)
    if is_admin(user) or (entry is None and not exists):
        return entry
    owner = entry.agency_id if entry else None
    if owner == user.agency_id or (owner is None and single_branch_site(db)):
        return entry
    raise HTTPException(status_code=403, detail=OUTSIDE)


def claim(db: Session, user: User, kind: str, name: str, agency_id: str | None) -> None:
    """Record who owns a new (or re-enrolled) entry."""
    entry = gallery_owner(db, kind, name)
    if entry is None:
        db.add(GalleryEntry(kind=kind, name=name, agency_id=agency_id, created_by=user.id))


def release(db: Session, kind: str, name: str) -> None:
    entry = gallery_owner(db, kind, name)
    if entry is not None:
        db.delete(entry)


def audit(db: Session, user: User, action: str, agency_id: str | None, details: dict) -> None:
    db.add(
        AuditLog(
            user_id=user.id,
            agency_id=agency_id,
            action=action,
            entity_type="ai_gallery",
            entity_id=None,
            details=details,
        )
    )
