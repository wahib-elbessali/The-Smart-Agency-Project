"""add agent counter assignment

Revision ID: c9f4a1b7e2d3
Revises: b8e5f2a7c9d1
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c9f4a1b7e2d3"
down_revision: Union[str, Sequence[str], None] = "b8e5f2a7c9d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("counter_id", sa.String(length=36), nullable=True))
    op.create_index("ix_users_counter_id", "users", ["counter_id"])
    op.create_foreign_key(
        "fk_users_counter_id_counters",
        "users",
        "counters",
        ["counter_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_users_counter_id_counters", "users", type_="foreignkey")
    op.drop_index("ix_users_counter_id", table_name="users")
    op.drop_column("users", "counter_id")
