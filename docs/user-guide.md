# SmartAgency user guide

This guide is for the people who use SmartAgency in a branch: administrators,
managers, agents, security staff and technicians. It explains what each screen
is for, how to set up a branch from scratch, and what to do day to day.

For installing, running and extending the system, see
[developer-guide.md](developer-guide.md).

---

## 1. What SmartAgency does

SmartAgency runs a bank-style branch from one dashboard:

- **Visitor queue**: visitors take a ticket at the kiosk, agents call them to a
  counter, the counter display shows the number.
- **Staff presence and doors**: employees badge in at the gate; badge rooms open
  with a badge, or with a badge and the badge holder's face.
- **Security**: cameras detect weapons, fire or smoke and people on the
  watchlist, and watch restricted zones for intruders. Alerts reach
  the dashboard and, for critical ones, your phone.
- **Building**: temperature, humidity and gas/CO readings, with automatic
  ventilation and emergency door unlocking.
- **Management**: live map of people on the floor, counter staffing, customer
  satisfaction, waiting times, monthly reports.

Everything runs on one machine inside the branch network. Nothing depends on a
cloud service.

---

## 2. Signing in and roles

Open the dashboard address your administrator gave you and sign in with your
email and password. After 5 wrong passwords in 10 minutes the account is
blocked for a while; wait and try again, or ask an administrator.

Your **role** decides which screens you see. A screen you cannot use is not
shown at all.

| Role | What they do | Main screens |
|---|---|---|
| **Administrator** | Owns the system: every branch, user accounts, AI tuning | Everything |
| **Manager** | Runs one branch: staff, services, counters, settings | Everything for their branch, except user accounts and AI tuning |
| **Agent** | Serves visitors at a counter | Visitor queue (their counter screen) |
| **Security** | Watches the branch | Alerts, Live map, Cameras, Manual controls, Employee presence, Insights |
| **Technician** | Looks after the hardware | IoT devices |

Administrators are created at installation time, not from the dashboard.
Everyone else gets an account from **User accounts** (administrators only).

A manager only ever sees and changes **their own branch**: its cameras, its
calibration, its watchlist entries, its faces. An administrator can open any
branch from **Agencies**.

---

## 3. The screens

The sidebar has three sections. **Help** and **Settings** are at the bottom.

### Operations

| Screen | What it is for |
|---|---|
| **Employee presence** | Who badged in today and when, who is late |
| **Visitor queue** | Managers: every counter, who covers it, how its line is doing. Agents: their own counter screen |
| **Manual controls** | Lock or unlock a door from the dashboard |
| **Announcements** | Messages for the staff of a branch, or for every branch |

### Monitoring

| Screen | What it is for |
|---|---|
| **Climate** | Temperature, humidity and air quality, live |
| **Occupancy** | How many people are in each zone |
| **Counter staffing** | Whether someone is actually standing at each counter |
| **Live map** | Every tracked person on the floor plan, named when known |
| **Alerts** | Everything that needs attention, live detections, critical notifications |
| **Insights** | Satisfaction, waiting times, counter and service performance, device uptime, failed badges |
| **Reports** | Period reports for one branch or all branches |

### Configuration

| Screen | What it is for |
|---|---|
| **Agencies** | Branches. Opening one gives the branch page (hours, counters, badge rooms, kiosk, setup checklist) |
| **Employees** | Staff records, badges, door permissions, face for badge + face doors |
| **Services** | What a visitor can take a ticket for |
| **Ticket layout** | How the printed ticket looks |
| **User accounts** | Logins, roles and branch access (administrators) |
| **Zones** | Draw the floor areas the cameras watch, and who may stand in them |
| **Calibration** | Teach each camera where the floor is |
| **Face enrollment** | Faces the system recognises as staff |
| **Watchlist** | People the cameras alert on, and how sure a match must be |
| **Cameras** | Register cameras and choose what each one detects |
| **IoT devices** | Sensors, readers, kiosk and display; their keys and thresholds |
| **AI tuning** | Detector settings, changed live (administrators) |

---

## 4. Setting up a branch

Do these in order. The branch page (**Agencies**, then open the branch) has a
**setup checklist** that ticks each step off as it is done and links to the
right screen.

### 4.1 The branch itself
1. **Agencies**: create the branch (administrator), then open it.
2. Set the **opening and closing time**. Closing time matters: at closing,
   tickets still waiting are closed as "no show" so they do not carry over to
   the next day.
3. Decide on **weapon lockdown** (on the branch page): when on, a confirmed
   weapon detection locks the doors.

### 4.2 Hardware
4. **IoT devices**: register each device (sensor board, gate reader, kiosk,
   queue display, door controller). Each one gets a **device key**, shown
   **once**: copy it into the device straight away. If it is lost, use the key
   button to make a new one; the old key stops working immediately and the
   device is offline until the new key is entered, so the screen asks first.
5. Set the **sensor thresholds** (thermometer button on a device): without
   them no temperature, humidity or gas reading ever raises an alert.

### 4.3 Cameras and the floor
6. **Cameras**: add each camera with its stream address, and tick what it should
   detect (weapon, fire, watchlist, and emotion for customer satisfaction). A door camera used only for badge
   + face doors should have **nothing** ticked.
7. **Calibration**: for each camera, click the four corners of a real rectangle
   on the floor, in order. **Important:** the system assumes the rectangle's
   short side is 1 metre. Use a rectangle whose short side really is 1 m, or
   every distance the cameras report will be off by that factor.
8. **Calibration**, align: click the same floor points on two cameras so they
   share one floor plan. When at least two cameras are aligned, people tracking
   starts and the **Live map** fills in.
9. **Zones**: draw the areas you care about (waiting area, kiosk, each counter's
   desk, the gate). Use **World** mode (drawn on one camera, fused with another)
   for anything used by tracking: the kiosk zone, the gate zone and restricted
   zones all need world zones. Counter desk zones for staffing can be either.

### 4.4 People
10. **Employees**: add staff with their **RFID badge** number. Tick the badge
    rooms each person may open.
11. **User accounts**: give agents, managers and security staff a login.
12. **Face enrollment**: optional, for face recognition of staff.

### 4.5 Queue
13. **Services**: what visitors can come for (each with a code, e.g. VIR).
14. Branch page, **Counters**: add the counters and the service each one serves.
    A counter can also name its **workstation** (for staffing checks) and its
    **satisfaction camera**.
15. **Visitor queue**: put an agent on each counter.
16. **Ticket layout**: optional, otherwise the generic ticket prints.

### 4.6 Linking cameras to the queue and the doors
17. Branch page, **Kiosk camera zone**: choose the zone in front of the kiosk,
    and the **face camera** that sees visitors' faces there. This links each
    ticket to the person on the live map and recognises returning visitors.
18. **IoT devices**, gate reader: set its **badge zone** to the gate zone. This
    links each badge tap to the person the cameras see at the gate: names on the
    live map, and who counts as staff in restricted zones.
19. **Counter staffing**: add a workstation for each counter's desk zone.
20. Branch page, **Badge rooms**: create the rooms, and choose how each opens
    (see section 7).

### 4.7 Alerts on your phone
21. **Alerts**, **Critical alert notifications**: turn on, on every device that
    should be woken by a critical alert. It needs the dashboard opened over
    https or on the machine itself; on an iPhone, install the dashboard to the
    home screen first.

---

## 5. Day to day, by role

### 5.1 Agent

Your **Visitor queue** screen shows only your counter: who you are serving and
who is next. Your manager assigns your counter and service; if nobody has, the
screen says so.

1. Press **Next** to call the first waiting ticket. The number appears on the
   counter display.
2. When the visitor reaches you, press **Start service**. This measures real
   waiting and service times.
3. If nobody comes, **Skip (no-show)** becomes available after a short
   countdown.
4. Write a **note** if useful (it stays with the visitor's history), then press
   **Next**: it completes the current ticket and calls the next one.

If the visitor has been here before, a **returning visitor** card shows their
previous visits and notes.

### 5.2 Manager

- **Visitor queue**: every counter, who covers it, the waiting line per service
  and warnings when a line grows. You can cover a counter yourself.
- **Counter staffing**: whether each counter is actually manned.
- **Employee presence**: who is in, who is late.
- **Alerts**: see section 6.
- **Announcements**: post messages to your branch's staff.
- **Insights** and **Reports**: satisfaction, waiting times, busiest moments,
  counter and service performance, device uptime, failed badges.

### 5.3 Security

- **Alerts** is your main screen. Keep it open; turn on notifications.
- **Live map**: every person on the floor. Red rings mark someone carrying a
  weapon, on the watchlist, or an intruder. Click a person to see who they are.
- **Manual controls**: **Lock** or **Unlock** a door. The result says
  **Confirmed** (the door did it), **Failed** (the door refused, with the
  reason) or **Unknown** (no answer within 10 seconds: check the door).
- **Cameras**: register the cameras you watch, adjust the weapon threshold.

### 5.4 Technician

**IoT devices**: register devices, rotate keys, set thresholds, set a reader's
badge zone. Device uptime history is in **Insights**, which a manager or
administrator can show you.

### 5.5 Administrator

Everything above for every branch, plus **User accounts** and **AI tuning**
(detector settings that apply to the whole site, changed without a restart).

---

## 6. Alerts

### 6.1 Where they show
- **Needs attention** (top of **Alerts**) lists every active alert of every
  kind. It refreshes every few seconds.
- The **bell** in the top bar counts alerts nobody has acknowledged.
- **Critical** alerts also send a notification to every device that turned
  notifications on, with email as a fallback when configured.

### 6.2 The kinds of alert

| Alert | Raised when | Closes |
|---|---|---|
| **Weapon** | A camera sees a weapon | Only when a person resolves it |
| **Watchlist match** | A camera sees someone on the watchlist | Only when a person resolves it |
| **Intruder in a restricted zone** | Someone not allowed stays in a restricted zone more than 5 s | Only when a person resolves it, or marks them as staff |
| **Fire or smoke** | A camera sees fire or smoke | By itself when it is gone |
| **Temperature / Humidity / Gas-CO** | A reading passes its threshold | By itself when the reading is back to normal |
| **AI service down / Sensor network down** | The camera AI or the sensor network stops answering for 45 s | By itself on recovery |
| **Restricted zones not watched** | People tracking stops while a branch has restricted zones | By itself on recovery |

Emotion readings (the "Distress" feed on the Alerts screen) are shown live but
never become stored alerts: they feed the satisfaction figures in **Insights**.

Weapon, watchlist and intrusion alerts **stay open** even when the person walks
out of view: the message then says since when they are out of view. One person
seen by two cameras is **one** alert.

### 6.3 What to do with an alert
- **Acknowledge**: "I have seen it, I am on it". It stops counting on the bell.
- **Resolve**: closes a weapon, watchlist or intrusion alert. Resolving an
  intrusion while the person is still in the zone keeps them quiet there until
  they leave.
- **It's staff**: on an intrusion alert, pick the employee it really is. This
  links them on the live map and closes the alert as a false alarm.

### 6.4 What the building does by itself
- **Critical gas/CO reading, or fire/smoke on a camera**: every door
  **unlocks** so people can get out.
- **Weapon**, with weapon lockdown on: the doors **lock**.
- **Temperature**: the fan turns on above the warning threshold.

---

## 7. Doors and badges

### 7.1 The gate
Staff badge in at the gate reader. That records their attendance, and, if the
gate reader has a badge zone (section 4.6), tells the cameras who that person is.

### 7.2 Badge rooms
On the branch page, **Badge rooms**. Each room has:
- **Opens with**: **Badge**, or **Badge + face**.
- **Door camera**, for Badge + face: a camera at face height by the door.
- Who may enter: tick the room on each employee's record.

With **Badge + face**, the door camera checks **once**, when the badge is
tapped, that the face in front of it is the badge holder's. Nothing is scanned
in between taps. Add the employee's photo on their record, under **Face for
badge + face doors**: the photo uploads as soon as you pick it. Several photos
(angles, lighting) make it more reliable.

What the door reader may answer:

| Message | Meaning |
|---|---|
| Acces autorise | The door opens |
| Visage non detecte, regardez la camera | Nobody looked at the camera in time |
| Visage non reconnu | A face, but not an enrolled one |
| Le visage ne correspond pas au badge | Someone else's badge |
| Camera de porte indisponible / non configuree | The door camera is down or not set |
| Verification du visage indisponible | The face service is down |

Badge + face doors **fail closed**: if the check cannot be done, the door stays
shut. Every refusal is logged, and **Insights**, failed badges, shows them per
door. The fire/gas emergency unlock still opens every door.

---

## 8. Restricted zones

On **Zones**, each world zone has **Who may be here**:

- **Anyone**: no watch (default).
- **Staff only**: anyone the cameras have not linked to an employee raises an
  intrusion alert after 5 seconds.
- **Nobody**: anyone at all raises an alert.

How the system knows who is staff: when an employee badges at the gate, the
person the cameras see there is linked to them, and stays linked while the
cameras follow them. If the cameras lose someone for a moment and pick them up
nearby, the link is kept automatically.

When the cameras get it wrong:
- **Live map**: click the person, then in **Who is this?** pick the employee
  and press **Link**, or press **Not staff** to remove a wrong link.
- **Alerts**: on the intrusion alert, **It's staff**.

Every manual link is recorded in the audit log with who made it. Offboarded
employees never count as staff.

---

## 9. Tickets and visitors

1. The visitor presses a service button on the kiosk; a ticket prints (e.g.
   VIR-012).
2. An agent calls it: the counter display shows the number.
3. The agent starts service when the visitor arrives, then completes it with
   an optional note, or skips it as a no-show.
4. At closing time, tickets still waiting become **no show**.

If the kiosk has a face camera, the system recognises returning visitors (by
face, without storing who they are) and shows the agent their previous visits.

---

## 10. Troubleshooting

| Problem | What to check |
|---|---|
| A device shows offline / its requests are refused | Was its key rotated? Enter the new key in the device |
| Nobody shows as staff; every staff member in a Staff only zone raises an alert | The gate reader has no badge zone (IoT devices) |
| A person's name is missing on the live map | They have not badged at the gate yet, or the cameras lost them: use **Who is this?** |
| A Badge + face door refuses an employee | Is a face photo enrolled on their record? Is the door camera set and online? |
| The live map is empty | At least two cameras must be calibrated and aligned |
| Zone counts look wrong after recalibrating | World zones are redrawn automatically after each calibration; check the zone still covers the right floor area |
| Distances look wrong | The calibration rectangle's short side must really be 1 m |
| "Restricted zones not watched" alert | People tracking stopped: check the cameras and the AI service |
| A notification never arrives | Turn notifications on from **Alerts** on that device; it needs https or the machine itself |
| A manual control says Unknown | The door did not answer in 10 s: check it is powered and connected |
| A manual control says the firmware does not know the command | The door's firmware is older than the dashboard: tell the hardware team |
| Ticket numbers from yesterday are still waiting | The branch has no closing time set |
