"""link services to tickets and agency points

Revision ID: a91e6c4b7d20
Revises: f4c8a1d2e7b3
Create Date: 2026-08-25
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a91e6c4b7d20"
down_revision: Union[str, Sequence[str], None] = "f4c8a1d2e7b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("counters", sa.Column("service_id", sa.String(length=36), nullable=True))
    op.add_column(
        "counters",
        sa.Column("point_type", sa.String(length=20), server_default="COUNTER", nullable=False),
    )
    op.create_foreign_key(
        "fk_counters_service_id_services",
        "counters",
        "services",
        ["service_id"],
        ["id"],
    )
    op.create_index(op.f("ix_counters_service_id"), "counters", ["service_id"], unique=False)

    op.add_column("tickets", sa.Column("service_id", sa.String(length=36), nullable=True))
    op.create_foreign_key(
        "fk_tickets_service_id_services",
        "tickets",
        "services",
        ["service_id"],
        ["id"],
    )
    op.create_index(op.f("ix_tickets_service_id"), "tickets", ["service_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_tickets_service_id"), table_name="tickets")
    op.drop_constraint("fk_tickets_service_id_services", "tickets", type_="foreignkey")
    op.drop_column("tickets", "service_id")

    op.drop_index(op.f("ix_counters_service_id"), table_name="counters")
    op.drop_constraint("fk_counters_service_id_services", "counters", type_="foreignkey")
    op.drop_column("counters", "point_type")
    op.drop_column("counters", "service_id")
