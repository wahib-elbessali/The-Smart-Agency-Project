from dataclasses import asdict

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.agencies import get_accessible_agency
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import RoleName, User
from app.schemas.setup_status import SetupItem, SetupStatus
from app.services.setup_status import compute_setup_status


router = APIRouter(prefix="/agencies", tags=["Setup status"])


@router.get(
    "/{agency_id}/setup-status",
    response_model=SetupStatus,
    dependencies=[Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))],
)
def get_setup_status(
    agency_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SetupStatus:
    """A live, derived checklist of what a branch still needs. Informational
    only - it blocks nothing and stores nothing."""
    agency = get_accessible_agency(agency_id, current_user, db)
    items = [SetupItem(**asdict(item)) for item in compute_setup_status(db, agency)]
    done = sum(1 for item in items if item.status == "done")
    return SetupStatus(items=items, done=done, total=len(items), complete=done == len(items))
