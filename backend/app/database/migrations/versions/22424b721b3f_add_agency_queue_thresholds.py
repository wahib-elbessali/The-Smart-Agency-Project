"""add agency queue thresholds

Revision ID: 22424b721b3f
Revises: 79294978088e
Create Date: 2026-10-02 00:52:37.857059

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



revision: str = '22424b721b3f'
down_revision: Union[str, Sequence[str], None] = '79294978088e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:

    op.add_column('agencies', sa.Column('queue_depth_warning', sa.Integer(), server_default='5', nullable=True))
    op.add_column('agencies', sa.Column('queue_depth_critical', sa.Integer(), server_default='10', nullable=True))
    op.add_column('agencies', sa.Column('oldest_wait_warning_seconds', sa.Integer(), server_default='600', nullable=True))
    op.add_column('agencies', sa.Column('oldest_wait_critical_seconds', sa.Integer(), server_default='1200', nullable=True))



def downgrade() -> None:

    op.drop_column('agencies', 'oldest_wait_critical_seconds')
    op.drop_column('agencies', 'oldest_wait_warning_seconds')
    op.drop_column('agencies', 'queue_depth_critical')
    op.drop_column('agencies', 'queue_depth_warning')

