from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import forward, raise_for_ai_status
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import RoleName, User
from app.services import branch_scope as scope


router = APIRouter(prefix="/face", tags=["Face enrollment"])

# ADMIN/MANAGER. One site-wide AI gallery; each name records the branch that
# enrolled it, and a MANAGER only sees and changes their branch's
# (app/services/branch_scope.py); every change is audit-logged. Enrollment
# only: /face/scan and /face/capture are deliberately not proxied here at
# all - they're backend-triggered against a real hardware event (a gate
# camera, a kiosk), the same way door access is RFID-triggered and
# synchronous, not something an operator fires from a dashboard button.
# Nothing on this backend orchestrates that yet either.
FACE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]
KIND = "face"

# Badge + face door faces live in the same AI gallery under "emp-<employee
# id>" (app/services/door_face.py) and are managed from the employee form
# (api/employee_faces.py). Kept off this screen: shown here they are raw ids,
# and deleting one silently locks that employee out of their doors.
DOOR_FACE_PREFIX = "emp-"


def _is_door_face(name: str) -> bool:
    return name.startswith(DOOR_FACE_PREFIX)


@router.get("/faces", dependencies=FACE_ROLES)
def list_faces(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[dict]:
    response = forward("GET", "/face/faces")
    raise_for_ai_status(response)
    entries = [e for e in response.json() if not _is_door_face(e["name"])]
    visible = scope.visible_names(db, current_user, KIND, [e["name"] for e in entries])
    # The AI service's own response includes the full embedding vectors
    # ("for the backend to mirror this gallery into its own database" -
    # its own docstring's words) - dropped here, this app has no use for
    # raw 512-float vectors and no reason to ship them to a browser.
    return [
        {"name": entry["name"], "embeddings_count": len(entry.get("embeddings", []))}
        for entry in entries
        if entry["name"] in visible
    ]


@router.post("/enroll", dependencies=FACE_ROLES)
async def enroll_face(
    name: str = Form(...),
    image: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    name = name.strip()
    if _is_door_face(name):
        raise HTTPException(status_code=422, detail="Nom reserve aux visages des portes")
    listed = forward("GET", "/face/faces")
    raise_for_ai_status(listed)
    exists = any(e.get("name") == name for e in listed.json())
    scope.ensure_may_change(db, current_user, KIND, name, exists=exists)
    owner = None if scope.is_admin(current_user) else current_user.agency_id
    content = await image.read()
    response = forward(
        "POST",
        "/face/enroll",
        data={"name": name},
        files={"image": (image.filename, content, image.content_type)},
    )
    raise_for_ai_status(response)
    scope.claim(db, current_user, KIND, name, owner)
    scope.audit(db, current_user, "face_enrolled", owner, {"name": name})
    db.commit()
    return response.json()


@router.delete("/faces/{name}", dependencies=FACE_ROLES, status_code=204)
def delete_face(
    name: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> None:
    if _is_door_face(name):
        raise HTTPException(
            status_code=422,
            detail="Visage de porte: a gerer depuis la fiche de l'employe",
        )
    entry = scope.ensure_may_change(db, current_user, KIND, name)
    response = forward("DELETE", f"/face/faces/{name}")
    raise_for_ai_status(response)
    scope.release(db, KIND, name)
    scope.audit(db, current_user, "face_removed", entry.agency_id if entry else None, {"name": name})
    db.commit()
