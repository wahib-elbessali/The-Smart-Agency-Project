"""add ticket correlation to alerts

Revision ID: 93703d1c9718
Revises: 2d44705abdec
Create Date: 2026-10-01 12:53:50.265539

Scenario-planning backlog (docs/scenario-planning-backlog.md), Phase C:
alerts.ticket_id, set only for a wanted-type alert that fires on the kiosk
camera close to when a specific ticket was issued.

The ix_users_counter_id partial-unique-index diff autogenerate offers here
is the same spurious one seen in b06980395ae7/2d44705abdec - excluded again,
same reason (never mirrored onto the User.counter_id column in entities.py).

Postgres has no deterministic unnamed-constraint convention configured in
this project's SQLAlchemy metadata, so autogenerate's raw drop_constraint(None, ...)
in downgrade() would fail outright - named explicitly below using Postgres's
own default FK-naming convention (<table>_<column>_fkey) instead.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '93703d1c9718'
down_revision: Union[str, Sequence[str], None] = '2d44705abdec'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('alerts', sa.Column('ticket_id', sa.String(length=36), nullable=True))
    op.create_foreign_key(
        'alerts_ticket_id_fkey', 'alerts', 'tickets', ['ticket_id'], ['id']
    )


def downgrade() -> None:
    op.drop_constraint('alerts_ticket_id_fkey', 'alerts', type_='foreignkey')
    op.drop_column('alerts', 'ticket_id')
