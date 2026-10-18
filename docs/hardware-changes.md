# Hardware changes required by this version

What the firmware has to change to work with this version of the backend. The
full, authoritative definitions are in `contracts/ingestion.md` (sections
referenced below) and `contracts/device-commands.json`. Anything not listed
here works exactly as before.

---

## Summary

| Device | Change | Required? |
|---|---|---|
| Door controller (`access-sensors-1`, or any `DOOR` / `ACCESS_SENSORS` device) | Receive `lock` / `unlock` commands over MQTT and reply | **Yes** |
| Door controller | Answer `unknown_action` to any command it does not implement | **Yes** |
| Door reader in a badge + face room | Wait up to 10 s for the access answer, show a "look at the camera" prompt, show the refusal message | **Yes**, for rooms set to Badge + face |
| Every device | Handle a refused device key without retrying in a loop | Recommended |
| Every device | Report regularly so the dashboard can show uptime | Recommended |
| Gate reader, ticket kiosk, queue display, sensor payloads | Nothing | No change |

---

## 1. Door commands (ingestion.md section 6b)

### Subscribe

```text
agency/{agency_id}/device/{device_id}/control
```

### Command received

```json
{ "correlation_id": "a1b2c3d4e5f6...", "action": "unlock", "target": null }
```

### Actions to implement

The list for each device type is `contracts/device-commands.json`. Today:

| Action | What the door must do |
|---|---|
| `unlock` | Open the SG90 and keep it open until told otherwise |
| `lock` | Close it and keep refusing to open it on a badge until `unlock` |

While locked by command, a valid badge must **not** open the door.

### When they arrive
- **Automatically**: `unlock` on a CRITICAL gas/CO alert or a fire/smoke
  detection (people must be able to get out); `lock` on a confirmed weapon
  detection when the branch has weapon lockdown on.
- **Manually**: an operator presses **Lock** or **Unlock** in the dashboard.

### Reply, on every command

Publish to `agency/{agency_id}/device/{device_id}/control-ack`, echoing the
`correlation_id`:

```json
{ "correlation_id": "a1b2c3d4e5f6...", "status": "ok", "detail": "door unlocked" }
```

| `status` | When |
|---|---|
| `ok` | The action was carried out |
| `unknown_action` | The firmware does not implement this action |
| `error` (or anything else) | The action was not carried out; say why in `detail` |

The dashboard waits **10 seconds** for this reply. No reply shows the operator
"Unknown"; `unknown_action` shows "the firmware does not know this command",
so never ignore a command silently.

---

## 2. Badge + face rooms (ingestion.md, door access)

A badge room can now be set to **Badge + face** in the dashboard. For those
rooms, `POST /internal/access/door-access` checks once that the face in front of
the room's door camera is the badge holder's, which takes up to about 5 seconds.

The door reader must:

1. Use an HTTP timeout of **10 seconds** for this request (instead of a short
   one).
2. Show a prompt such as "Regardez la camera" while waiting.
3. Show the `message` of the answer when `authorized` is `false`. The face
   refusals are:
   - `Visage non detecte, regardez la camera`
   - `Visage non reconnu`
   - `Le visage ne correspond pas au badge`
   - `Camera de porte indisponible`
   - `Camera de porte non configuree`
   - `Verification du visage indisponible`
   - `Verification en cours, reessayez`
4. Not retry automatically: a new badge tap starts a new check.

The request and the answer keep exactly the same shape as before. Rooms set to
**Badge** answer immediately, as today.

---

## 3. Recommended

### Refused device key
A device's key can be replaced from the dashboard (the operator is warned
first). From then on, every HTTP request with the old key is answered `401`
with `Clé appareil invalide`. Show that state on the device (LED, display) and
back off, instead of retrying in a tight loop, until the new key is entered.

### Regular reporting
A device can be given a heartbeat interval in the dashboard. It counts as online
while the backend has heard from it within 3 of those intervals; sensor
publishes, badge requests and kiosk polls all count. A device that only speaks
when something happens should send its regular readings or polls anyway.

---

## 4. Testing without the dashboard

```bash
# watch what the backend sends to the door
mosquitto_sub -p 1883 -t "agency/<agency_id>/device/access-sensors-1/control" -v

# reply as the door would
mosquitto_pub -p 1883 -t "agency/<agency_id>/device/access-sensors-1/control-ack" \
  -m '{"correlation_id":"<from the command>","status":"ok","detail":"door unlocked"}'
```

From the dashboard, **Manual controls** shows **Lock** / **Unlock** on the door
device and displays **Confirmed**, **Failed** or **Unknown** from your reply.

---

## Checklist

- [ ] Subscribe to `.../control` on the door controller
- [ ] `unlock` opens and holds; `lock` closes and refuses badges until `unlock`
- [ ] Reply on `.../control-ack` with the same `correlation_id`, every time
- [ ] Unknown actions answered with `unknown_action`
- [ ] Door reader: 10-second timeout, "look at the camera" prompt, refusal
      message shown, no automatic retry
- [ ] Refused key shown on the device, no retry loop
- [ ] Regular readings / polls even when nothing happens
