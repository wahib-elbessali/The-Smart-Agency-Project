"""add employee-specific zone access

Revision ID: b8e5f2a7c9d1
Revises: a4c9e2f7b1d6
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b8e5f2a7c9d1"
down_revision: Union[str, Sequence[str], None] = "a4c9e2f7b1d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "employee_zone_access",
        sa.Column("employee_id", sa.String(length=36), nullable=False),
        sa.Column("zone_id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["employee_id"], ["employees.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["zone_id"], ["zones.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("employee_id", "zone_id"),
    )


def downgrade() -> None:
    op.drop_table("employee_zone_access")
