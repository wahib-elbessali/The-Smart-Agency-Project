"""badge + face doors: a room's access mode and door camera

Revision ID: d5a7c9e1f3b4
Revises: c3f5d7e9a1b2
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d5a7c9e1f3b4"
down_revision: Union[str, Sequence[str], None] = "c3f5d7e9a1b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("zones") as batch:
        batch.add_column(
            sa.Column("access_mode", sa.String(length=20), nullable=False, server_default="rfid")
        )
        batch.add_column(sa.Column("door_camera_id", sa.String(length=36), nullable=True))
        batch.create_foreign_key(
            "fk_zones_door_camera", "cameras", ["door_camera_id"], ["id"], ondelete="SET NULL"
        )


def downgrade() -> None:
    with op.batch_alter_table("zones") as batch:
        batch.drop_constraint("fk_zones_door_camera", type_="foreignkey")
        batch.drop_column("door_camera_id")
        batch.drop_column("access_mode")
