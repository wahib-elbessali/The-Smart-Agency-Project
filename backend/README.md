# SmartAgency Backend

Backend FastAPI du système de gestion des agences et IoT.

## Installation locale

```powershell
cd C:\Users\Lenovo\Desktop\IOT\IOT\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Configurer ensuite `DATABASE_URL` dans `.env` :

```env
DATABASE_URL=postgresql+psycopg2://postgres:MOT_DE_PASSE@localhost:5432/agence_iot
```

Créer la base PostgreSQL `agence_iot`, puis appliquer les migrations :

```powershell
alembic upgrade head
uvicorn app.main:app --reload
```

## Jeu de données de développement

Après les migrations, créer les comptes et les données de démonstration :

```powershell
python seed_dev.py
```

Le script est relançable sans doublons. Il crée une agence de développement,
les cinq rôles, des comptes de test, des employés avec leurs zones RFID, les
services et guichets, des visiteurs et tickets, les deux caméras ainsi que
l'appareil IoT `access-sensors-1` et ses seuils DHT11/MQ2.

Compte ADMIN de développement :

```text
Email    : admin@smartagency.local
Mot de passe : Admin12345
```

Les autres comptes utilisent le même mot de passe :
`manager@smartagency.local`, `agent@smartagency.local`,
`security@smartagency.local` et `technician@smartagency.local`.

Pour modifier le mot de passe utilisé lors de la création :

```powershell
$env:SEED_PASSWORD="VotreMotDePasseDev123"
python seed_dev.py
```

Le mot de passe d'un compte déjà existant n'est pas remplacé par défaut.
Utiliser `SEED_RESET_PASSWORD=true` uniquement en développement pour le
réinitialiser. La clé de test du device `access-sensors-1` est
`access-sensors-1-dev-key` ; elle est réservée au développement local.

API et documentation :

```text
http://127.0.0.1:8000/docs
```

Ne jamais versionner `.env`, les mots de passe, les tokens JWT ou le dossier `.venv`.

## Authentification

Inscription publique — crée un compte `AGENT` sans agence (envoyer un
`agency_id` renvoie `403`) ; un administrateur affecte ensuite l'agence avec
`PATCH /api/users/{user_id}/agency` :

```text
POST /api/auth/register
```

Connexion :

```text
POST /api/auth/login
```

Après connexion, copier `access_token` et cliquer sur **Authorize** dans Swagger.
Selon l'interface Swagger, coller le token seul ou sous la forme `Bearer <token>`.

Profil connecté :

```text
GET /api/auth/me
```

Protections :

- Après 5 échecs pour un même email, ou 30 depuis une même adresse, en
  10 minutes, la connexion renvoie `429` (avec `Retry-After`) même avec le bon
  mot de passe. Les compteurs sont en mémoire : un redémarrage les remet à zéro.
- Les jetons sont signés avec `SECRET_KEY`. Avec la valeur par défaut, n'importe
  qui peut forger un jeton : définir une valeur longue et aléatoire dans `.env`
  (par exemple `python -c "import secrets; print(secrets.token_urlsafe(48))"`).
  Le backend refuse de démarrer avec la valeur par défaut si `APP_ENV=production`
  et affiche un avertissement sinon.
- Le rôle est relu en base à chaque requête : un compte désactivé ou rétrogradé
  perd son accès tout de suite, jeton non expiré compris.

## Agences

```text
GET    /api/agencies
POST   /api/agencies
GET    /api/agencies/{agency_id}
PUT    /api/agencies/{agency_id}
DELETE /api/agencies/{agency_id}

GET    /api/agencies/{agency_id}/services
POST   /api/agencies/{agency_id}/services
GET    /api/services/{service_id}
PUT    /api/services/{service_id}
DELETE /api/services/{service_id}
GET    /api/services/{service_id}/points
PATCH  /api/counters/{counter_id}/service

GET    /api/devices
POST   /api/devices/agencies/{agency_id}
GET    /api/devices/{device_id}
PUT    /api/devices/{device_id}
POST   /api/devices/{device_id}/rotate-key
DELETE /api/devices/{device_id}
```

Un ADMIN peut gérer toutes les agences. Un MANAGER peut gérer uniquement son agence.
Une agence contient des zones, des guichets, des employés, des appareils et des caméras.

## Caméras et alertes IA d'armes

Routes de gestion des caméras :

```text
GET    /api/agencies/{agency_id}/cameras
POST   /api/agencies/{agency_id}/cameras
PUT    /api/cameras/{camera_id}
DELETE /api/cameras/{camera_id}
```

Créer chaque caméra avec un nom unique qui correspond exactement au nom de la
source déclarée dans le service IA :

```json
{
  "name": "cam1",
  "stream_url": "rtsp://192.168.1.16:8554/stream"
}
```

Le backend synchronise automatiquement les caméras avec
`POST /weapon/sources` du service IA et consomme
`WS /weapon/alerts/stream`. Une détection reçue au-dessus du seuil est
enregistrée dans `alerts` avec `camera_id`, `agency_id`, le niveau `CRITICAL`
et le statut `OPEN`. Une mise à jour sans détection clôture l'alerte ouverte.

Le service IA doit être lancé sur un port différent de l'API backend, par
exemple :

```powershell
uvicorn ai.main:app --host 127.0.0.1 --port 8001
```

Configuration backend correspondante dans `.env` :

```env
AI_SERVICE_URL=http://127.0.0.1:8001
AI_ALERTS_ENABLED=true
```

Seuil métier global pour les armes :

```text
GET /api/ai-alerts/thresholds/weapon
PUT /api/ai-alerts/thresholds/weapon
```

Exemple :

```json
{
  "confidence": 0.60
}
```

Le seuil accepte une valeur strictement supérieure à `0` et inférieure ou
égale à `1`. Il est conservé dans PostgreSQL et appliqué immédiatement. Il
est distinct du `conf` interne du modèle IA.

## Réglage du service IA

Les réglages du service IA (confiance minimale, taille d'image, intervalle de
détection, etc.) se changent sans le redémarrer. Le backend relaie l'API
`/config` du service IA, réservée à l'`ADMIN` :

```text
GET   /api/ai/config           valeurs en cours, mode d'application de chaque clé
PATCH /api/ai/config           {"changes": {"weapon": {"conf": 0.4}}, "persist": false}
POST  /api/ai/config/reload    relit le fichier de config du service IA
```

Un changement est tout ou rien : une valeur invalide renvoie `422` avec la liste
de tous les problèmes et rien n'est appliqué. Chaque changement est écrit dans
le journal d'audit (`ai_config_changed`, `ai_config_reloaded`). L'écran
« AI tuning » du frontend (`/ai-settings`) s'appuie sur ces routes.

Trois clés sont aussi des seuils d'alerte : `weapon.conf`, `wanted.threshold` et
`fire.conf`. Le backend les enregistre dans `ai_alert_thresholds` et les
renvoie au service IA à chaque (re)connexion de ses consommateurs, donc un
redémarrage du service IA ne les perd pas, quel que soit l'écran qui les a
modifiées. Les autres clés reviennent à la valeur du fichier au redémarrage,
sauf avec `persist: true`.

## Employés

```text
GET    /api/employees
POST   /api/employees
GET    /api/employees/{employee_id}
PUT    /api/employees/{employee_id}
DELETE /api/employees/{employee_id}
```

Exemple :

```json
{
  "first_name": "Hamza",
  "last_name": "Benali",
  "email": "hamza.benali@agence.com",
  "phone": "0612345678",
  "position": "Agent d'accueil",
  "agency_id": "ID_AGENCE",
  "rfid_uid": "RFID-001",
  "status": "ACTIVE",
  "hire_date": "2026-08-01"
}
```

## Utilisateurs, rôles et permissions

La gestion des utilisateurs est réservée à `ADMIN` :

```text
GET    /api/users
POST   /api/users
GET    /api/users/{user_id}
PUT    /api/users/{user_id}
PATCH  /api/users/{user_id}/role
PATCH  /api/users/{user_id}/agency
PATCH  /api/users/{user_id}/access
DELETE /api/users/{user_id}

GET    /api/agents/me/assignment
GET    /api/agencies/{agency_id}/agents
PATCH  /api/agents/{user_id}/assignment
```

Rôles disponibles :

```text
ADMIN       Accès complet et gestion des utilisateurs
MANAGER     Gestion de son agence et de ses employés
AGENT       Gestion des visiteurs et des tickets
SECURITY    Présences, caméras, alertes et incidents
TECHNICIAN  Appareils IoT, capteurs, MQTT et maintenance
```

Un compte peut être relié à un employé avec `employee_id` :

```json
{
  "full_name": "Sara Security",
  "email": "sara@agence.com",
  "password": "Security12345",
  "role": "SECURITY",
  "agency_id": "ID_AGENCE",
  "employee_id": "ID_EMPLOYE"
}
```

La relation est optionnelle et unique : un employé ne peut être lié qu'à un seul compte.

Pour changer simultanément le rôle et l'agence, utiliser la route atomique :

```text
PATCH /api/users/{user_id}/access
```

```json
{
  "role": "SECURITY",
  "agency_id": "AGENCY_UUID"
}
```

Le serveur valide l'état final du couple rôle/agence dans une seule transaction.

Un `MANAGER` peut affecter les comptes `AGENT` de son agence à un guichet ou
un bureau déjà relié à un service :

```json
{
  "counter_id": "COUNTER_UUID"
}
```

Pour retirer l'affectation, envoyer `{"counter_id": null}`. Un agent consulte
sa propre affectation avec `GET /api/agents/me/assignment`. Une affectation est
supprimée automatiquement lorsque l'agent change d'agence ou de rôle.

## Visiteurs et tickets

### Appareils IoT

Un appareil doit être enregistré par un `ADMIN`, `MANAGER` ou `TECHNICIAN` avant
d'envoyer des données. La clé `device_key` est affichée une seule fois lors de
l'enregistrement et doit être conservée dans l'ESP32.

```http
POST /api/devices/agencies/{agency_id}
```

```json
{
  "name": "Borne tickets accueil",
  "device_type": "TICKET_KIOSK",
  "mqtt_client_id": "ticket-kiosk-01",
  "mqtt_topic": "agency/AGENCY_UUID/device/ticket-kiosk-01/sensor"
}
```

La réponse contient `device_key`. Cette clé ne doit jamais être committée dans
Git ni envoyée dans Discord. Pour la remplacer, utiliser
`POST /api/devices/{device_id}/rotate-key`.

### Endpoints internes hardware

Les deux endpoints internes exigent l'en-tête :

```http
X-Device-Key: DEVICE_KEY
```

Le `device_id` du contrat hardware correspond au `mqtt_client_id` enregistré
dans `devices`, et non à l'UUID interne de la table.

```http
POST /internal/tickets/walk-in
```

```json
{
  "agency_id": "AGENCY_UUID",
  "device_id": "ticket-kiosk-01",
  "service_id": "SERVICE_UUID",
  "visitor": {
    "full_name": "Visiteur borne",
    "phone": null,
    "identity_reference": null
  },
  "timestamp": "2026-08-25T14:32:00Z"
}
```

Réponse :

```json
{
  "ticket_id": "TICKET_UUID",
  "ticket_number": "20260825-OPERATIONS-001",
  "service_id": "SERVICE_UUID",
  "service_type": "Opérations courantes",
  "status": "WAITING"
}
```

Pour compatibilité temporaire, `service_type` peut remplacer `service_id` si
sa valeur correspond exactement au `code` ou au nom du service. Le matériel
doit privilégier `service_id`.

```http
POST /internal/attendance/check-rfid
```

```json
{
  "agency_id": "AGENCY_UUID",
  "device_id": "access-sensors-1",
  "employee_rfid": "A1B2C3D4",
  "timestamp": "2026-08-25T09:15:00Z"
}
```

Le lecteur RFID n'envoie pas `event`. Le backend décide automatiquement :
une carte sans présence ouverte déclenche `check_in`, puis la prochaine lecture
de cette carte déclenche `check_out`. La réponse indique la décision dans le
champ `event`. L'ESP32 doit éviter d'envoyer plusieurs fois la même lecture.

Réponse valide :

```json
{
  "valid": true,
  "employee_name": "Hamza Benali",
  "event": "check_in",
  "message": null
}
```

Réponse pour carte inconnue ou opération impossible :

```json
{
  "valid": false,
  "employee_name": null,
  "event": null,
  "message": "Carte RFID ou employe introuvable"
}
```

Visiteurs :

```text
POST /api/visitors
GET  /api/visitors
GET  /api/visitors/{visitor_id}
```

Tickets :

```text
POST /api/tickets
GET  /api/tickets/queue
POST /api/tickets/{ticket_id}/call
POST /api/tickets/{ticket_id}/complete
POST /api/tickets/{ticket_id}/cancel
```

La création d'un ticket nécessite désormais le service de l'agence :

```json
{
  "visitor_id": "VISITOR_UUID",
  "service_id": "SERVICE_UUID"
}
```

La file peut être filtrée par service avec `GET /api/tickets/queue?service_id=SERVICE_UUID`.
Un ticket ne peut être appelé que par un guichet ou un bureau affecté au même service.

Affectation d'un guichet ou d'un bureau :

```text
PATCH /api/counters/{counter_id}/service
```

```json
{
  "service_id": "SERVICE_UUID"
}
```

Le type du point (`COUNTER` ou `OFFICE`) est automatiquement aligné sur le service.

États possibles : `WAITING`, `CALLED`, `IN_SERVICE`, `COMPLETED`, `CANCELLED`.
Un ticket est créé pour un visiteur, reçoit un numéro quotidien, puis est appelé
par un guichet de la même agence.

## MQTT DHT11 et MQ2

Le backend écoute le sujet :

```text
agency/{agency_id}/device/{device_id}/sensor
```

Message DHT11 :

```json
{
  "readings": [
    { "sensor_type": "temperature", "value": 24.5, "unit": "C" },
    { "sensor_type": "humidity", "value": 61.2, "unit": "%" }
  ],
  "timestamp": "2026-08-25T10:00:00Z"
}
```

Message MQ2 :

```json
{
  "readings": [
    { "sensor_type": "gas_co", "value": 12.4, "unit": "ppm" }
  ],
  "timestamp": "2026-08-25T10:00:05Z"
}
```

Chaque mesure est enregistrée dans `sensor_readings`. L'appareil doit déjà
être présent dans `devices` avec le même `mqtt_client_id` que celui du sujet.

### Configuration des seuils

```text
GET /api/devices/{device_id}/thresholds
PUT /api/devices/{device_id}/thresholds/{sensor_type}
DELETE /api/devices/{device_id}/thresholds/{sensor_type}
```

Exemple pour la température :

```json
{
  "unit": "C",
  "warning_max": 30,
  "critical_max": 40,
  "is_active": true
}
```

Une valeur supérieure ou égale à `warning_max` crée une alerte `HIGH`. Une
valeur supérieure ou égale à `critical_max` crée une alerte `CRITICAL`.

### Commandes backend vers hardware

Lorsqu'un seuil est dépassé, le backend publie :

```text
agency/{agency_id}/device/{device_id}/alert
```

```json
{
  "alert_type": "gas_co",
  "active": true,
  "severity": "CRITICAL"
}
```

Quand la valeur revient à la normale, `active` devient `false`.

Pour le capteur `temperature`, le backend publie également l'état du
climatiseur/stepper :

```text
agency/{agency_id}/device/{device_id}/climate
```

```json
{
  "active": true
}
```

La commande `climate` suit le seuil `warning_max` de la température et est
réémise à chaque mesure afin de restaurer l'état après un redémarrage.

## Présence RFID

```text
POST /api/attendance/check-in
POST /api/attendance/check-out
GET  /api/attendance/today
GET  /api/attendance/employee/{employee_id}
```

Message MQTT attendu :

```text
agency/{agency_id}/device/{device_id}/attendance
```

```json
{
  "employee_rfid": "RFID-001",
  "timestamp": "2026-08-01T12:00:00Z"
}
```

Les mises à jour sont diffusées par :

```text
ws://127.0.0.1:8000/ws/attendance?token=ACCESS_TOKEN
```

## Structure principale

```text
app/
├── api/             Routes REST
├── core/            Configuration et sécurité
├── database/        Connexion et migrations Alembic
├── models/          Modèles SQLAlchemy
├── mqtt/            Consommateurs MQTT
├── schemas/         Schémas Pydantic
├── services/        Logique métier
└── websocket/       Notifications temps réel
```

Pour les détails du matériel, du câblage ESP32/RC522, des scénarios IoT et des règles
fonctionnelles, consulter la documentation disponible dans Discord.

## Tests

`PYTHONPATH=. pytest` runs the unit tests against in-memory SQLite (no Docker needed): weapon lockdown gate, notification routing, offboarding, health monitor, device uptime, report windows and zone-unit matching, the AI config proxy and threshold sync, camera and counter edge cases, the setup checklist, email delivery over a real SMTP conversation, login throttling and token handling, the attendance WebSocket, and an access-control sweep that checks every registered route (401 without a token, 403 for each disallowed role, 403 across branches) and holds each route's roles to `contracts/api.md`.

The AI service has its own tests: `cd ../ai && python -m pytest tests` (needs the AI dependencies, e.g. OpenCV, in the interpreter).

`scripts/e2e_check.py` is a live pass over the whole pipeline (kiosk ticket, tracking links, weapon/fire/gas doors over real MQTT, notifications, offboarding, insights and reports) against the dev Postgres and broker; see its docstring.
