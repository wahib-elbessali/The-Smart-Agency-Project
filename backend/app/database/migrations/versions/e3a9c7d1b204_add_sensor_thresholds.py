"""add per-device sensor thresholds

Revision ID: e3a9c7d1b204
Revises: c7e2b4a91f06
Create Date: 2026-08-25
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e3a9c7d1b204"
down_revision: Union[str, Sequence[str], None] = "c7e2b4a91f06"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sensor_thresholds",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("device_id", sa.String(length=36), nullable=False),
        sa.Column("sensor_type", sa.String(length=80), nullable=False),
        sa.Column("unit", sa.String(length=20), nullable=True),
        sa.Column("warning_max", sa.Float(), nullable=True),
        sa.Column("critical_max", sa.Float(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_id", "sensor_type", name="uq_threshold_device_sensor"),
    )
    op.create_index(op.f("ix_sensor_thresholds_device_id"), "sensor_thresholds", ["device_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_sensor_thresholds_device_id"), table_name="sensor_thresholds")
    op.drop_table("sensor_thresholds")
