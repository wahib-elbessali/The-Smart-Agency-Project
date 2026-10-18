from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Systeme de Gestion des Agences & IoT"
    app_env: str = "development"
    debug: bool = True
    database_url: str = (
        "postgresql+psycopg2://postgres:mot_de_passe@localhost:5432/agence_iot"
    )
    secret_key: str = "change_me_in_local_env"  # see check_secret_key()
    access_token_expire_minutes: int = 30
    mqtt_host: str = "localhost"
    mqtt_port: int = 1883
    mqtt_username: str | None = None
    mqtt_password: str | None = None
    redis_url: str = "redis://localhost:6379/0"
    ai_service_url: str = "http://127.0.0.1:8001"
    ai_alerts_enabled: bool = True
    ai_reconnect_delay_seconds: float = 5.0
    ai_source_sync_interval_seconds: float = 15.0
    # Caps on concurrent AI WebSocket proxy connections (app/websocket/ai_proxy.py) -
    # a client holding many open sockets would otherwise have no limit at all.
    ai_ws_max_connections: int = Field(default=50, gt=0)
    ai_ws_max_connections_per_user: int = Field(default=5, gt=0)
    mq2_raw_to_ppm_enabled: bool = False
    mq2_raw_baseline: float = 0.0
    mq2_raw_ppm_scale: float = Field(default=1.0, gt=0)
    mq2_raw_ppm_offset: float = 0.0
    # How long a manual-controls command waits for the device's own MQTT ack
    # before the screen reads "unknown" rather than pending forever. Decided
    # with the user (2026-09-23): spinner while pending, unknown - not a
    # guessed success/failure - on timeout, no automatic retry.
    manual_control_ack_timeout_seconds: float = 10.0
    notifications_enabled: bool = True
    health_monitor_enabled: bool = True
    health_check_interval_seconds: float = Field(default=10.0, gt=0)
    health_down_grace_seconds: float = Field(default=45.0, ge=0)
    # How long a badge + face door watches its camera for the badge holder's
    # face. The door reader's own HTTP timeout must exceed this by a few
    # seconds (contracts/ingestion.md).
    door_face_timeout_seconds: float = Field(default=4.0, gt=0, le=15)
    # Live tracked positions older than this are dropped: a stream that went
    # quiet must not leave people "standing" where they were last seen.
    people_tracks_stale_seconds: float = Field(default=5.0, gt=0)
    # Manual commands per device type; default core/contracts/device-commands.json.
    device_commands_file: str | None = None
    # Restricted camera zones (app/services/zone_watch.py): how long someone
    # not allowed there may stand in one before the alert, and how close in
    # time and floor units (cm) a new track must appear to a vanished staff
    # track to inherit its identity.
    zone_intrusion_grace_seconds: float = Field(default=5.0, ge=0)
    zone_handoff_seconds: float = Field(default=2.0, ge=0)
    zone_handoff_distance: float = Field(default=100.0, ge=0)
    device_sample_interval_seconds: float = Field(default=300.0, gt=0)
    device_missed_heartbeats: int = Field(default=3, ge=1)
    device_sample_retention_days: int = Field(default=90, ge=1)
    vapid_public_key: str | None = None
    vapid_private_key: str | None = None
    vapid_subject: str = "mailto:admin@smartagency.local"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "alerts@smartagency.local"
    smtp_use_tls: bool = True

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()


DEFAULT_SECRET_KEY = "change_me_in_local_env"


def check_secret_key(current=None) -> None:
    """Tokens are signed with SECRET_KEY, so the shipped default lets anyone forge
    one. Refuse to start in production with it; warn loudly everywhere else."""
    current = current or settings
    if current.secret_key != DEFAULT_SECRET_KEY:
        return
    if current.app_env == "production":
        raise RuntimeError("SECRET_KEY is still the default; set a long random value in .env")
    import logging

    logging.getLogger(__name__).warning(
        "SECRET_KEY is the shipped default: anyone can forge login tokens. Set it in .env."
    )
