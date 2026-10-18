"""add employee and device badge tracking link

Revision ID: 53c89995810d
Revises: 1a38f3ce9dbc
Create Date: 2026-10-01 14:38:51.828041

Scenario-planning backlog (docs/scenario-planning-backlog.md), Phase F:
devices.badge_zone_name (which AI-service zone a reader's badge scans
correlate against) and employees.tracking_id (the live-map identity label,
overwritten on every successful scan - see entities.py's comment on why
that's deliberate, unlike every earlier phase's one-shot link).

The ix_users_counter_id partial-unique-index diff autogenerate offers here
is the same spurious one seen in every prior migration this backlog added -
excluded again, same reason (never mirrored onto the User.counter_id column
in entities.py).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '53c89995810d'
down_revision: Union[str, Sequence[str], None] = '1a38f3ce9dbc'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('devices', sa.Column('badge_zone_name', sa.String(length=150), nullable=True))
    op.add_column('employees', sa.Column('tracking_id', sa.String(length=50), nullable=True))


def downgrade() -> None:
    op.drop_column('employees', 'tracking_id')
    op.drop_column('devices', 'badge_zone_name')
