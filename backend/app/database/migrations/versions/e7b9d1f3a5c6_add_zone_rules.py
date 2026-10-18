"""restricted camera zones: zone rules, intrusion alert's tracked person

Revision ID: e7b9d1f3a5c6
Revises: d5a7c9e1f3b4
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e7b9d1f3a5c6"
down_revision: Union[str, Sequence[str], None] = "d5a7c9e1f3b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "zone_rules",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "agency_id",
            sa.String(length=36),
            sa.ForeignKey("agencies.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("zone_name", sa.String(length=120), nullable=False),
        sa.Column("restriction", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("agency_id", "zone_name", name="uq_zone_rule_agency_zone"),
    )
    op.create_index("ix_zone_rules_agency_id", "zone_rules", ["agency_id"])
    with op.batch_alter_table("alerts") as batch:
        batch.add_column(sa.Column("tracking_id", sa.String(length=50), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("alerts") as batch:
        batch.drop_column("tracking_id")
    op.drop_index("ix_zone_rules_agency_id", table_name="zone_rules")
    op.drop_table("zone_rules")
