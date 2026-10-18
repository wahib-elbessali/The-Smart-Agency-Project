from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import forward, raise_for_ai_status
from app.ai_alerts.thresholds import store_after_ai_accepted
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Agency, RoleName, User
from app.services import branch_scope as scope


router = APIRouter(prefix="/watchlist", tags=["Watchlist"])

# ai/features/wanted_detection is mounted at /wanted on the real service
# (verified live, 2026-09-23 - its own router decorators read like bare
# /watchlist and /threshold, which is only true relative to that mount).
# Separate gallery from /face on purpose (own route names, own storage
# file) - see FaceEntry/WatchlistEntry's doc comments on the frontend for
# why. ADMIN/MANAGER. The AI gallery is site-wide; each name records the
# branch that added it, and a MANAGER only sees and changes their branch's
# (app/services/branch_scope.py). A match still alerts on every camera: a
# wanted person is wanted everywhere. Every change is audit-logged.
WATCHLIST_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]
KIND = "watchlist"


@router.get("", dependencies=WATCHLIST_ROLES)
def list_watchlist(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[dict]:
    # include_embeddings intentionally omitted (defaults to false on the AI
    # service) - this app has no use for the raw vectors.
    response = forward("GET", "/wanted/watchlist")
    raise_for_ai_status(response)
    entries = response.json()
    visible = scope.visible_names(db, current_user, KIND, [e["name"] for e in entries])
    return [e for e in entries if e["name"] in visible]


@router.post("", dependencies=WATCHLIST_ROLES)
async def add_to_watchlist(
    name: str = Form(...),
    image: UploadFile = File(...),
    agency_id: str | None = Form(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """A MANAGER adds for their own branch; an ADMIN for the branch given
    (or site-wide when none is). Re-enrolling an existing name adds a photo
    and needs the right to change that entry."""
    name = name.strip()
    listed = forward("GET", "/wanted/watchlist")
    raise_for_ai_status(listed)
    exists = any(e.get("name") == name for e in listed.json())
    scope.ensure_may_change(db, current_user, KIND, name, exists=exists)
    owner = agency_id if scope.is_admin(current_user) else current_user.agency_id
    if owner is not None and db.get(Agency, owner) is None:
        raise HTTPException(status_code=404, detail="Agence introuvable")
    content = await image.read()
    response = forward(
        "POST",
        "/wanted/watchlist",
        data={"name": name},
        files={"image": (image.filename, content, image.content_type)},
    )
    raise_for_ai_status(response)
    scope.claim(db, current_user, KIND, name, owner)
    scope.audit(db, current_user, "watchlist_added", owner, {"name": name})
    db.commit()
    return response.json()


@router.delete("/{name}", dependencies=WATCHLIST_ROLES, status_code=204)
def remove_from_watchlist(
    name: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> None:
    entry = scope.ensure_may_change(db, current_user, KIND, name)
    response = forward("DELETE", f"/wanted/watchlist/{name}")
    raise_for_ai_status(response)
    scope.release(db, KIND, name)
    scope.audit(
        db, current_user, "watchlist_removed", entry.agency_id if entry else None, {"name": name}
    )
    db.commit()


@router.get("/threshold", dependencies=WATCHLIST_ROLES)
def get_threshold(current_user: User = Depends(get_current_user)) -> dict:
    response = forward("GET", "/wanted/threshold")
    raise_for_ai_status(response)
    return response.json()


@router.put("/threshold", dependencies=WATCHLIST_ROLES)
def set_threshold(
    payload: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    # One match threshold for every branch's cameras.
    scope.ensure_site_wide_change(db, current_user)
    response = forward("PUT", "/wanted/threshold", json=payload)
    raise_for_ai_status(response)
    # The AI service forgets this on restart; keep the value so the consumer
    # can put it back (ai_alerts/thresholds.py).
    if "threshold" in payload:
        store_after_ai_accepted(db, "wanted", payload["threshold"])
        scope.audit(
            db, current_user, "watchlist_threshold_changed", None, {"threshold": payload["threshold"]}
        )
        db.commit()
    # PUT's own response is shaped differently from GET's (found live: it
    # returns `previous`, not startup_default/floor/watchlist_size/
    # embeddings_total) - re-fetching GET after a successful PUT keeps this
    # endpoint's response shape consistent with GET's, which is what the
    # frontend's WantedThreshold type is built against.
    followup = forward("GET", "/wanted/threshold")
    raise_for_ai_status(followup)
    return followup.json()
