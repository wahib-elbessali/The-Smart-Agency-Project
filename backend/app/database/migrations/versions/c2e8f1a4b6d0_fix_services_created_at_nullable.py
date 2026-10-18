"""align services.created_at with the ORM model

Revision ID: c2e8f1a4b6d0
Revises: b7f1c4d9e2a6
Create Date: 2026-08-30
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c2e8f1a4b6d0"
down_revision: Union[str, Sequence[str], None] = "b7f1c4d9e2a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("UPDATE services SET created_at = NOW() WHERE created_at IS NULL")
    op.alter_column(
        "services",
        "created_at",
        existing_type=sa.DateTime(timezone=True),
        nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "services",
        "created_at",
        existing_type=sa.DateTime(timezone=True),
        nullable=True,
    )
