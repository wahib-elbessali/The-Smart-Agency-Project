"""add agency weapon lockdown toggle

Revision ID: 28ba67feb54b
Revises: db0f3e6fb7af
Create Date: 2026-10-01 23:29:45.271054

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



revision: str = '28ba67feb54b'
down_revision: Union[str, Sequence[str], None] = 'db0f3e6fb7af'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:

    op.add_column('agencies', sa.Column('weapon_lockdown_enabled', sa.Boolean(), server_default='false', nullable=False))



def downgrade() -> None:

    op.drop_column('agencies', 'weapon_lockdown_enabled')

