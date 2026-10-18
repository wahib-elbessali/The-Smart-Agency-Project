"""add agency ticket templates

Revision ID: f7a2c9d4e6b1
Revises: c2e8f1a4b6d0
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f7a2c9d4e6b1"
down_revision: Union[str, Sequence[str], None] = "c2e8f1a4b6d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("agencies", sa.Column("ticket_template", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("agencies", "ticket_template")
