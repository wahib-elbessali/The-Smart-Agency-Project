"""add camera name uniqueness and AI weapon threshold

Revision ID: b7f1c4d9e2a6
Revises: e3a9c7d1b204
Create Date: 2026-08-30
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7f1c4d9e2a6"
down_revision: Union[str, Sequence[str], None] = "e3a9c7d1b204"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The AI service uses camera names as its global source identifiers. A
    # global unique constraint prevents an alert from being attached to the
    # wrong agency when two agencies use the same label.
    op.create_unique_constraint("uq_camera_name", "cameras", ["name"])

    op.create_table(
        "ai_alert_thresholds",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("alert_type", sa.String(length=50), nullable=False),
        sa.Column("confidence", sa.Float(), server_default="0.6", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("alert_type"),
    )

    thresholds = sa.table(
        "ai_alert_thresholds",
        sa.column("id", sa.String(length=36)),
        sa.column("alert_type", sa.String(length=50)),
        sa.column("confidence", sa.Float()),
    )
    op.bulk_insert(
        thresholds,
        [
            {
                "id": "00000000-0000-4000-8000-000000000001",
                "alert_type": "weapon",
                "confidence": 0.6,
            }
        ],
    )


def downgrade() -> None:
    op.drop_table("ai_alert_thresholds")
    op.drop_constraint("uq_camera_name", "cameras", type_="unique")
