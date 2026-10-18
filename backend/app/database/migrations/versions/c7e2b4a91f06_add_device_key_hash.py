"""add per-device ingestion key hash

Revision ID: c7e2b4a91f06
Revises: a91e6c4b7d20
Create Date: 2026-08-25
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7e2b4a91f06"
down_revision: Union[str, Sequence[str], None] = "a91e6c4b7d20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("device_key_hash", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "device_key_hash")
