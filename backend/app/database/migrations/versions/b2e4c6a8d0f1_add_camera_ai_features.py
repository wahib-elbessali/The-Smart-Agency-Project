"""add the AI detections each camera runs

Revision ID: b2e4c6a8d0f1
Revises: a1d3f5b7c9e2
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b2e4c6a8d0f1"
down_revision: Union[str, Sequence[str], None] = "a1d3f5b7c9e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # NULL means "every detection", so existing cameras keep today's behaviour.
    op.add_column("cameras", sa.Column("ai_features", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("cameras", "ai_features")
