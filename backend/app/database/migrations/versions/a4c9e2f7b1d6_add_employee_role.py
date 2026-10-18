"""add employee access role

Revision ID: a4c9e2f7b1d6
Revises: f7a2c9d4e6b1
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "a4c9e2f7b1d6"
down_revision: Union[str, Sequence[str], None] = "f7a2c9d4e6b1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # rolename is created by the initial roles migration and is reused here.
    role_enum = postgresql.ENUM(
        "ADMIN",
        "MANAGER",
        "AGENT",
        "SECURITY",
        "TECHNICIAN",
        name="rolename",
        create_type=False,
    )
    op.add_column("employees", sa.Column("role", role_enum, nullable=True))
    op.execute(
        sa.text(
            """
            UPDATE employees AS e
            SET role = r.name
            FROM users AS u
            JOIN roles AS r ON r.id = u.role_id
            WHERE e.user_id = u.id
            """
        )
    )
    op.execute(sa.text("UPDATE employees SET role = 'AGENT' WHERE role IS NULL"))
    op.alter_column(
        "employees",
        "role",
        existing_type=role_enum,
        nullable=False,
        server_default=sa.text("'AGENT'"),
    )


def downgrade() -> None:
    op.drop_column("employees", "role")
