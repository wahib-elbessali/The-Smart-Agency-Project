"""gallery entries: which branch owns each watchlist / face gallery name

Revision ID: f9c1e3a5b7d9
Revises: e7b9d1f3a5c6
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f9c1e3a5b7d9"
down_revision: Union[str, Sequence[str], None] = "e7b9d1f3a5c6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "gallery_entries",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "agency_id",
            sa.String(length=36),
            sa.ForeignKey("agencies.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_by",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("kind", "name", name="uq_gallery_entry_kind_name"),
    )
    op.create_index("ix_gallery_entries_agency_id", "gallery_entries", ["agency_id"])


def downgrade() -> None:
    op.drop_index("ix_gallery_entries_agency_id", table_name="gallery_entries")
    op.drop_table("gallery_entries")
