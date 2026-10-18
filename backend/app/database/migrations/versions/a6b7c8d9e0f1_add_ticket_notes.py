"""add ticket completion notes

Revision ID: a6b7c8d9e0f1
Revises: c9f4a1b7e2d3
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a6b7c8d9e0f1"
down_revision: Union[str, Sequence[str], None] = "c9f4a1b7e2d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tickets", sa.Column("notes", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("tickets", "notes")
