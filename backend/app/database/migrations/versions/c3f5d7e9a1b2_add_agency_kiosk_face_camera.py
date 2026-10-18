"""add the camera that sees kiosk visitors' faces

Revision ID: c3f5d7e9a1b2
Revises: b2e4c6a8d0f1
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c3f5d7e9a1b2"
down_revision: Union[str, Sequence[str], None] = "b2e4c6a8d0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("agencies") as batch:
        batch.add_column(sa.Column("kiosk_face_camera_id", sa.String(length=36), nullable=True))
        batch.create_foreign_key(
            "fk_agencies_kiosk_face_camera", "cameras", ["kiosk_face_camera_id"], ["id"], ondelete="SET NULL"
        )


def downgrade() -> None:
    with op.batch_alter_table("agencies") as batch:
        batch.drop_constraint("fk_agencies_kiosk_face_camera", type_="foreignkey")
        batch.drop_column("kiosk_face_camera_id")
