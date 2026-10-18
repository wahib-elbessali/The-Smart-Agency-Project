"""Presence/absence state machine for one workstation -- turns a stream of
zone-occupancy counts (already computed by features/zoning) into a
"present" / "away" status, debounced against brief absences.

Deliberately NOT activity/idleness classification (is the person moving,
using a tool, etc): that was researched and found unreliable everywhere it's
been tried -- see docs/employee_activity_research (a construction-site pose
classifier managed 32% false negatives on real footage; CLIP zero-shot
activity recognition landed at 53% accuracy, barely above chance). This
module answers a cheaper, well-supported question instead: "is anyone
standing at this workstation", sampled over time.

One sighting is conclusive evidence of presence -- the same rule
features/common/live_alert_service.py's hysteresis uses for a confirmed
detection -- so status flips to "present" immediately on any count > 0,
resetting the absence timer. Status flips to "away" only after the zone has
been CONTINUOUSLY empty for >= absence_seconds, not on the first empty
reading -- that asymmetry is the whole point: a bathroom break or stepping
out for a delivery must not read as "not working", but there's no
symmetric risk to being fast about "present" (a real sighting cannot be a
false positive the way "still absent" can be a false negative).
"""
import time


def new_state():
    """A workstation that has never been classified yet. "unknown" is
    distinct from "away" on purpose -- a workstation reads as "away" only
    once absence has actually been observed for the full window, never as a
    default/startup guess."""
    return {"status": "unknown", "since": time.time(), "empty_since": None}


def update(state, count, absence_seconds, now=None):
    """state: this workstation's state dict, mutated in place (also
    returned). count: this poll's zone occupancy (0 or more, from
    features/zoning's get_zone_count()). -> (state, changed), where changed
    is True only on the poll where `status` itself actually flips."""
    now = time.time() if now is None else now
    changed = False
    if count > 0:
        state["empty_since"] = None
        if state["status"] != "present":
            state["status"] = "present"
            state["since"] = now
            changed = True
    else:
        if state["empty_since"] is None:
            state["empty_since"] = now
        elif state["status"] != "away" and now - state["empty_since"] >= absence_seconds:
            state["status"] = "away"
            # Backdated to when the absence actually started, not when this
            # poll happened to confirm it -- so "since" reports a real
            # departure time, not a detection-latency-shifted one.
            state["since"] = state["empty_since"]
            changed = True
    return state, changed
