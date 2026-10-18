from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import forward, raise_for_ai_status
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import Employee, RoleName, User
from app.services.door_face import face_key

router = APIRouter(prefix="/employees", tags=["Employee faces"])
FACE_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]

# An employee's face, enrolled in the AI face gallery under a key tied to the
# employee (door_face.face_key), so a badge + face door can check "this face
# is the badge holder's" exactly. The free-name roster (app/api/face.py) is
# kept for anyone who is not an employee.


def get_scoped_employee(employee_id: str, current_user: User, db: Session) -> Employee:
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=404, detail="Employe introuvable")
    if current_user.role.name != RoleName.ADMIN and current_user.agency_id != employee.agency_id:
        raise HTTPException(status_code=403, detail="Acces limite a votre agence")
    return employee


@router.get("/{employee_id}/face", dependencies=FACE_ROLES)
def get_employee_face(
    employee_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    employee = get_scoped_employee(employee_id, current_user, db)
    response = forward("GET", "/face/faces")
    raise_for_ai_status(response)
    entry = next((e for e in response.json() if e.get("name") == face_key(employee.id)), None)
    return {"enrolled": entry is not None, "photos": len(entry.get("embeddings", [])) if entry else 0}


@router.post("/{employee_id}/face", dependencies=FACE_ROLES)
async def enroll_employee_face(
    employee_id: str,
    image: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Adds one photo; several photos (different angles, lighting) make the
    door check more reliable. 422 from the AI service when the photo does not
    hold exactly one face."""
    employee = get_scoped_employee(employee_id, current_user, db)
    content = await image.read()
    response = forward(
        "POST",
        "/face/enroll",
        data={"name": face_key(employee.id)},
        files={"image": (image.filename, content, image.content_type)},
    )
    raise_for_ai_status(response)
    return {"enrolled": True, "photos": response.json().get("embeddings_count", 1)}


@router.delete("/{employee_id}/face", dependencies=FACE_ROLES, status_code=204)
def delete_employee_face(
    employee_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    employee = get_scoped_employee(employee_id, current_user, db)
    response = forward("DELETE", f"/face/faces/{face_key(employee.id)}")
    if response.status_code != 404:
        raise_for_ai_status(response)
