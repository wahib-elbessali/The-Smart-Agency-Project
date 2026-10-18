ATTENDANCE_TOPIC = "agency/{agency_id}/device/{device_id}/attendance"
TICKET_CALLED_TOPIC = "agency/{agency_id}/device/{device_id}/ticket-called"

# Manual controls: dashboard -> backend -> MQTT -> ESP32/Arduino, and back.
# Distinct from every other command topic here in one way - this is the
# only one whose delivery a human is actively waiting on and watching a
# spinner for, which is the whole reason it needs a correlation id and an
# ack topic at all (every other command here is fire-and-forget).
CONTROL_COMMAND_TOPIC = "agency/{agency_id}/device/{device_id}/control"
CONTROL_ACK_TOPIC = "agency/{agency_id}/device/{device_id}/control-ack"
CONTROL_ACK_SUBSCRIPTION = "agency/+/device/+/control-ack"
