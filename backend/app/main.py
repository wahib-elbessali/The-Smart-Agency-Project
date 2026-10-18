from fastapi import FastAPI

from app.api.auth import router as auth_router
from app.core.config import check_secret_key
from app.api.agencies import router as agencies_router
from app.api.employees import router as employees_router
from app.api.users import router as users_router
from app.api.attendance import router as attendance_router
from app.api.visitors import router as visitors_router
from app.api.tickets import router as tickets_router
from app.api.services import router as services_router
from app.api.devices import router as devices_router
from app.api.cameras import router as cameras_router
from app.api.push import router as push_router
from app.api.reports import router as reports_router
from app.api.setup_status import router as setup_status_router
from app.api.ai_alerts import router as ai_alerts_router
from app.api.alerts import actions_router as alert_actions_router
from app.api.alerts import router as alerts_router
from app.api.assignments import router as assignments_router
from app.api.internal import router as internal_router
from app.api.ticket_templates import router as ticket_templates_router
from app.api.thresholds import router as thresholds_router
from app.api.announcements import router as announcements_router
from app.api.climate import router as climate_router
from app.api.insights import branches_router as insights_branches_router
from app.api.insights import router as insights_router
from app.api.calibration import router as calibration_router
from app.api.zones import router as zones_router
from app.api.people import router as people_router
from app.api.face import router as face_router
from app.api.watchlist import router as watchlist_router
from app.api.controls import router as controls_router
from app.api.workstations import router as workstations_router
from app.api.access_zones import router as access_zones_router
from app.api.employee_faces import router as employee_faces_router
from app.api.counters import router as counters_router
from app.api.ai_config import router as ai_config_router
from app.mqtt.manual_control import manual_control_service
from app.mqtt.attendance_consumer import attendance_consumer
from app.mqtt.sensor_consumer import sensor_consumer
from app.ai_alerts.consumer import weapon_alert_consumer
from app.ai_alerts.fire_consumer import fire_alert_consumer
from app.ai_alerts.wanted_consumer import wanted_alert_consumer
from app.ai_alerts.emotion_consumer import emotion_consumer
from app.services.people_tracking import people_track_tracker
from app.services.zone_watch import zone_watcher
from app.services.health_monitor import health_monitor
from app.websocket.attendance import router as attendance_websocket_router
from app.websocket.ai_proxy import router as ai_websocket_router


app = FastAPI(
    title="Systeme de Gestion des Agences & IoT",
    version="0.1.0",
    description="API backend pour la gestion des agences, des visiteurs et des appareils IoT.",
)

app.include_router(auth_router, prefix="/api")
app.include_router(agencies_router, prefix="/api")
app.include_router(employees_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(attendance_router, prefix="/api")
app.include_router(visitors_router, prefix="/api")
app.include_router(tickets_router, prefix="/api")
app.include_router(services_router, prefix="/api")
app.include_router(devices_router, prefix="/api")
app.include_router(cameras_router, prefix="/api")
app.include_router(ai_alerts_router, prefix="/api")
app.include_router(alerts_router, prefix="/api")
app.include_router(alert_actions_router, prefix="/api")
app.include_router(assignments_router, prefix="/api")
app.include_router(internal_router)
app.include_router(ticket_templates_router, prefix="/api")
app.include_router(thresholds_router, prefix="/api")
app.include_router(announcements_router, prefix="/api")
app.include_router(climate_router, prefix="/api")
app.include_router(insights_router, prefix="/api")
app.include_router(insights_branches_router, prefix="/api")
app.include_router(calibration_router, prefix="/api")
app.include_router(zones_router, prefix="/api")
app.include_router(people_router, prefix="/api")
app.include_router(face_router, prefix="/api")
app.include_router(watchlist_router, prefix="/api")
app.include_router(controls_router, prefix="/api")
app.include_router(workstations_router, prefix="/api")
app.include_router(counters_router, prefix="/api")
app.include_router(access_zones_router, prefix="/api")
app.include_router(employee_faces_router, prefix="/api")
app.include_router(ai_config_router, prefix="/api")
app.include_router(push_router, prefix="/api")
app.include_router(reports_router, prefix="/api")
app.include_router(setup_status_router, prefix="/api")
app.include_router(attendance_websocket_router)
app.include_router(ai_websocket_router)


@app.on_event("startup")
def start_mqtt_consumer() -> None:
    check_secret_key()
    attendance_consumer.start()
    sensor_consumer.start()
    weapon_alert_consumer.start()
    fire_alert_consumer.start()
    wanted_alert_consumer.start()
    emotion_consumer.start()
    manual_control_service.start()
    people_track_tracker.start()
    zone_watcher.start()
    health_monitor.start()


@app.on_event("shutdown")
def stop_mqtt_consumer() -> None:
    attendance_consumer.stop()
    sensor_consumer.stop()
    weapon_alert_consumer.stop()
    fire_alert_consumer.stop()
    wanted_alert_consumer.stop()
    emotion_consumer.stop()
    manual_control_service.stop()
    people_track_tracker.stop()
    zone_watcher.stop()
    health_monitor.stop()


@app.get("/health", tags=["System"])
def health_check() -> dict[str, str]:
    """Retourne l'etat de fonctionnement de l'API."""
    return {"status": "ok"}
