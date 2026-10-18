"""add counter emotion camera link

Revision ID: 1a38f3ce9dbc
Revises: 962b8ea82ff9
Create Date: 2026-10-01 14:10:00.000000

counters.emotion_camera_id - an optional, manager-configured link so an
emotion sample only counts toward a service-satisfaction reading if it
lands within a ticket's in_service_at-completed_at window on this specific
camera.

The ix_users_counter_id partial-unique-index diff autogenerate offers here
is the same spurious one seen in every prior migration this backlog added -
excluded again, same reason (never mirrored onto the User.counter_id column
in entities.py).

Named the FK explicitly using Postgres's own default naming convention
(<table>_<column>_fkey), same fix as 93703d1c9718 - autogenerate's raw
drop_constraint(None, ...) in downgrade() would otherwise fail outright,
since this project's SQLAlchemy metadata has no naming convention configured.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '1a38f3ce9dbc'
down_revision: Union[str, Sequence[str], None] = '962b8ea82ff9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('counters', sa.Column('emotion_camera_id', sa.String(length=36), nullable=True))
    op.create_foreign_key(
        'counters_emotion_camera_id_fkey', 'counters', 'cameras', ['emotion_camera_id'], ['id']
    )


def downgrade() -> None:
    op.drop_constraint('counters_emotion_camera_id_fkey', 'counters', type_='foreignkey')
    op.drop_column('counters', 'emotion_camera_id')
