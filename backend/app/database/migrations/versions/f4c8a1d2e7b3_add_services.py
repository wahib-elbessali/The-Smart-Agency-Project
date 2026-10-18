"""add agency services

Revision ID: f4c8a1d2e7b3
Revises: deba57c577c1
Create Date: 2026-08-25
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f4c8a1d2e7b3"
down_revision: Union[str, Sequence[str], None] = "deba57c577c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "services",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("agency_id", sa.String(length=36), nullable=False),
        sa.Column("code", sa.String(length=50), nullable=False),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("point_type", sa.String(length=20), server_default="COUNTER", nullable=False),
        sa.Column("min_points", sa.Integer(), server_default="1", nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["agency_id"], ["agencies.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("agency_id", "code", name="uq_service_agency_code"),
    )
    op.create_index(op.f("ix_services_agency_id"), "services", ["agency_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_services_agency_id"), table_name="services")
    op.drop_table("services")
