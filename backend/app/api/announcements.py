from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, or_
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Agency, Announcement, RoleName, User
from app.schemas.announcement import AnnouncementCreate, AnnouncementResponse


router = APIRouter(prefix="/announcements", tags=["Announcements"])

# Reading is everyone - an announcement is FOR employees, restricting who can
# see one would defeat the point. Posting/deleting is ADMIN and MANAGER only,
# same "configuration vs monitoring" split the rest of this app draws.
WRITE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]


@router.get("", response_model=list[AnnouncementResponse])
def list_announcements(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Announcement]:
    """Every announcement the caller should see: site-wide ones (agency_id
    NULL) plus their own agency's. An ADMIN with no agency_id of their own
    sees every scoped announcement too, not just the site-wide ones - there
    is no branch for them to be limited to."""
    query = select(Announcement).order_by(Announcement.created_at.desc())
    if current_user.role.name != RoleName.ADMIN:
        query = query.where(
            or_(
                Announcement.agency_id.is_(None),
                Announcement.agency_id == current_user.agency_id,
            )
        )
    return list(db.scalars(query).all())


@router.post("", response_model=AnnouncementResponse, dependencies=WRITE_ROLES)
def create_announcement(
    payload: AnnouncementCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Announcement:
    if payload.agency_id is None:
        if current_user.role.name != RoleName.ADMIN:
            raise HTTPException(
                status_code=403,
                detail="Seul un administrateur peut diffuser a toutes les agences",
            )
    else:
        if db.get(Agency, payload.agency_id) is None:
            raise HTTPException(status_code=404, detail="Agence introuvable")
        if current_user.role.name != RoleName.ADMIN and current_user.agency_id != payload.agency_id:
            raise HTTPException(status_code=403, detail="Acces limite a votre agence")

    announcement = Announcement(
        agency_id=payload.agency_id,
        author_id=current_user.id,
        title=payload.title,
        message=payload.message,
    )
    db.add(announcement)
    db.commit()
    db.refresh(announcement)
    return announcement


@router.delete("/{announcement_id}", status_code=204, dependencies=WRITE_ROLES)
def delete_announcement(
    announcement_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    announcement = db.get(Announcement, announcement_id)
    if announcement is None:
        raise HTTPException(status_code=404, detail="Annonce introuvable")
    if current_user.role.name != RoleName.ADMIN and announcement.agency_id != current_user.agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")
    db.delete(announcement)
    db.commit()
