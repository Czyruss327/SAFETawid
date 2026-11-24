# SAFETawid Project Knowledge Map

This document is an agent-oriented map of the repository: what runs where, how the parts communicate, where state lives, and which files to read before changing a behavior. It describes the current source, with operational details cross-checked against the implementation. The README and `DESKTOP.md` remain the operator-facing setup guides.

## 1. Project at a glance

SAFETawid is a local-first school-zone pedestrian monitor. The browser (or Electron's Chromium window) owns camera access and preview. It samples frames and POSTs JPEG images to a local FastAPI service. FastAPI runs Ultralytics YOLO person inference, applies optional normalized rectangular zones, records events and frame telemetry in SQLite, and returns boxes/metrics. The browser draws boxes over its own video and plays audio. If configured, the API exposes an alert latch polled by an ESP32-S3 that drives traffic signal LEDs and a buzzer.

```text
Camera -> browser video -> sampled JPEG -> FastAPI -> YOLO person inference
              |                                |          |
              +-- local preview + box overlay  |          +-> SQLite + CSV exports
                                               +-> alert latch -> ESP32-S3 -> lamps/buzzer
Browser audio <----- beep files / alert state --+

Electron (optional) starts the API, serves/proxies the built frontend, and owns local paths/config.
```

The system does not send camera frames to a cloud service in its local desktop/browser configuration. Frames are processed in memory; persistent records are detections, aggregate/per-frame metrics, settings, and exports. This is not authentication: API access is open to clients that can reach its bound interface. LAN access is off by default in the desktop configuration.

## 2. Repository map

```text
/
  readme.md                    Main user guide: browser, desktop, deployment, telemetry
  DESKTOP.md                   Windows desktop setup, local data, config, packaging
  PROJECT_MAP.md               This architecture / onboarding guide
  package.json                 Electron scripts, packaging, bundled resources
  build/installer.nsh          NSIS model-choice/install customization
  desktop/
    main.cjs                   Electron lifecycle, Python setup, proxy, permissions
    desktop-config.example.json
  frontend/
    package.json               Vite + React scripts/dependencies
    vite.config.js             Dev server and /api proxy
    index.html                 Browser document shell
    public/                    PWA manifest, service worker, icons
    src/
      main.jsx                 React bootstrap and browser service-worker setup
      App.jsx                  Root view; mounts ConnectionGate
      api.js                   API origin selection/helper
      components/Cam.jsx       Dashboard state, sampling, API orchestration, alerts
      components/*.jsx         Dashboard panels, camera feed, settings, status
      hooks/useCameraStream.js getUserMedia lifecycle and device selection
      *.css                    Global and dashboard styling
  backend/
    main.py                    FastAPI routes, model, persistence, alert/hardware state
    alert_logic.py             Pure dwell/cooldown/playback state machine
    test_alert_logic.py        Unit tests for that state machine
    setup_backend.ps1          AppData Python environment + CUDA/CPU PyTorch setup
    requirements.txt           Python dependencies
    yolo11_camera.py           Separate direct-camera inference utility
    decrypt.py                 Example telemetry decryption script
    source/beep*.mp3           API-served audio assets
  hardware/
    platformio.ini             USB and OTA build targets
    src/main.cpp               ESP32 Wi-Fi/config/discovery/alert/LED state machine
    README.md                  Wiring and operation guide
```

There are two package managers: root `package.json` for Electron/build packaging and `frontend/package.json` for the React app. A `frontend/frontend/package-lock.json` is present in the tree but is not referenced by the Vite configuration or scripts; investigate its history before treating that nested folder as a separate app. YOLO weight files are ignored by Git (`backend/*.pt`); the installer configuration expects four weight names to exist at packaging time.

## 3. Runtime ownership and state boundaries

| Concern | Owner | Lifetime / storage |
| --- | --- | --- |
| Camera permission, media stream, live preview | Browser/Electron renderer | In-memory; tracks explicitly stopped on unmount/stop |
| Detection area(s), theme, sound, scheduled time, manual UI mode | Frontend | Browser `localStorage`; up to two normalized rectangles |
| YOLO model/device and per-frame detection result | FastAPI | Model loaded lazily on first `/api/detect`; process memory |
| Dwell timer, cooldown and playback lock | `PedestrianAlertController` in FastAPI | Process memory; resets on process restart |
| Hardware alert latch and ESP32 heartbeat | FastAPI | Process memory; deadlines based on monotonic time |
| Event history, telemetry, alert settings/presets | SQLite | `DATABASE_PATH`; desktop uses AppData `school_zone.db` |
| Telemetry encryption key | FastAPI | `TELEMETRY_KEY_PATH`; desktop uses AppData `telemetry.key` |
| Exported CSV files | FastAPI | `EXPORT_DIRECTORY`; desktop uses AppData `exports` |
| Desktop config, Python environment, model copy | Electron | Electron userData: config, runtime, models |
| Wi-Fi credentials and API discovery state | ESP32 | NVS via Arduino `Preferences`; credential entry portal is served by device |
| Traffic phases, beep sequence, OTA state | ESP32 firmware | Device process memory; output pins defined near top of `main.cpp` |

Do not confuse two alert state stores: alert thresholds/duration/cooldown persist in SQLite, but the active alert, manual mode, hardware heartbeat, and dwell controller are in API process memory. The browser owns the actual audio playback acknowledgement; hardware has its own completion acknowledgement.

## 4. Important execution paths

### Browser development

1. Start backend from `backend` with `uvicorn main:app --reload --host 127.0.0.1 --port 8000`.
2. Start Vite from `frontend`; its `/api` proxy forwards to `127.0.0.1:8000`.
3. `main.jsx` mounts `App`; `App` mounts `ConnectionGate`. The gate checks the ESP32 setup portal and only then mounts `Cam` (the setup-complete flag is stored locally).
4. `useCameraStream` opens the selected camera with `getUserMedia`, enumerates video devices, and stops tracks on cleanup.
5. `Cam` draws the latest video frame to a canvas, scales it to at most 640 px wide, encodes JPEG quality 0.78 and submits one request at a time. A 5 ms interval is a sampling check, not a 200 FPS inference guarantee: an in-flight request suppresses further samples.
6. `Cam` updates event/performance state and overlays response boxes over the original video. The browser owns audio playback and sends `/api/alert-finished` when appropriate.

### Electron desktop

`desktop/main.cjs` loads or creates `desktop-config.json`; ensures the AppData venv is ready (shows setup progress); copies/verifies the configured bundled model; chooses a port; starts an ephemeral loopback HTTP server that serves `frontend/dist` and proxies `/api/*`; then spawns Uvicorn. API binds `127.0.0.1`, or `0.0.0.0` only when `allowEsp32LanAccess` is enabled. Electron grants camera permission only to its local dashboard origin and shuts down the backend process tree on quit. `package.json`'s Electron Builder config packages the UI, desktop shell, selected backend files and model resources.

Desktop defaults in code include YOLO11n, hardware alerts off, LAN access off, retention zero (no automatic deletion), and API port 8000 (with a free-port fallback). The installer still requires a host-installed Python 3.11+ and internet for Python packages on first launch; Python/PyTorch are not bundled.

### Detection and alert path

`POST /api/detect` body is raw JPEG/PNG bytes; `X-Detection-Zone` is JSON for zero to two normalized rectangles. FastAPI validates size/format/zones, lazily loads and warms YOLO, filters class `person`, and counts a person inside a zone only when the detection-box center falls inside it. Empty/no zones mean full frame. A transition from no person to person creates one event; repeated occupied frames do not create an event each time. Every processed frame does create a telemetry row.

The dwell controller starts when the zone has people; threshold depends on current count (defaults: 12 seconds for one, 8 for two, 5 for three or more). Changing group size changes the threshold without resetting elapsed time; empty frames or a changed zone reset the timer. On trigger, the API locks the next trigger until playback/output completes and cooldown elapses. Browser sound can be disabled; the browser still acknowledges the playback lock. With hardware enabled and not manual mode, FastAPI also activates the hardware latch. When an ESP32 client has been seen recently, the backend gives the physical output a five-second watchdog grace; the output deadline itself remains the configured duration.

### ESP32 path

The device starts an AP setup portal if it has no saved Wi-Fi. It saves credentials in NVS, reconnects with retry/backoff, advertises OTA, and discovers `_safetawid._tcp` over mDNS. The desktop advertises this service only when LAN access and hardware alerts are both enabled. Firmware polls `/api/hardware-alert` every 100 ms with `X-Hardware-Client: safetawid-esp32`; an active latch starts the traffic phase and buzzer. At completion it POSTs `/api/hardware-alert/finished`. The firmware uses break-before-make for green signal transitions. If mDNS discovery fails, check same-LAN multicast/client isolation and firewall; the firmware retries discovery every 10 seconds.

## 5. Backend API map

| Route | Purpose / key behavior |
| --- | --- |
| `GET /api/health` | Readiness, model loaded/device/GPU, hardware enabled/active |
| `GET /api/summary` | Process status, uptime, persisted people total, latest events, GPU/hardware status |
| `POST /api/detect` | Raw frame + optional zone header; detection boxes, alert state, timing, event list |
| `GET /api/audio/{filename}` | Serves only `beep1.mp3` and `beep3.mp3` from backend/source |
| `POST /api/alert-finished` | Browser releases the API's alert-playback lock; hardware may still be active |
| `GET /api/hardware-alert` | ESP32 latch state, timing, enabled/manual/heartbeat state |
| `POST /api/hardware-alert/manual-mode` | In-memory manual mode toggle; clearing mode also clears latch |
| `POST /api/hardware-alert/manual` | Starts a manual hardware alert; 503 when hardware disabled |
| `POST /api/hardware-alert/cancel` | Clears latch and releases controller after operator stop |
| `POST /api/hardware-alert/finished` | ESP32 completion acknowledgement; releases alert lock after browser ack too |
| `GET /api/alert-settings`, `PUT /api/alert-settings` | Read/update validated persistent thresholds and durations; applies immediately |
| `GET /api/alert-presets`, `PUT /api/alert-presets/{peak-hours\|off-peak-hours}` | Persist named settings snapshots |
| `GET /api/events/export` | Full event CSV; also writes a copy under export directory |
| `GET /api/telemetry/export` | Full telemetry CSV encrypted with Fernet; also writes `.enc` copy |

Detection response timing fields are distinct: `inference_ms` measures model work, `request_ms` measures API processing, and the frontend adds `round_trip_ms`. `inference_fps` is a rolling processed-frame rate, not camera capture FPS. Current telemetry columns for end-to-end alert activation and GPIO activation latency are explicitly `NULL`; they are not measured by this code.

## 6. Persistence schema and meaning

- `detection_events`: one record per transition from clear to occupied, with UTC ISO ID, local display `HH:MM:SS`, mean confidence percentage, and a simple zone result.
- `dashboard_stats`: legacy/single-row counter table initialized at startup. Current displayed `people_seen` is computed from retained telemetry sums rather than this row.
- `telemetry_records`: one per processed frame; UTC time, rolling inference FPS, mean confidence, whether a zone was configured, intrusion indicator/time, detection count, model latency, and currently-null future latency metrics. `crosswalk_intrusion` is NULL when no zone exists; with a zone it reflects whether people were detected in-zone.
- `alert_settings`: key/value numeric settings applied on startup and updated live.
- `alert_presets`: named JSON snapshots, only `peak-hours` and `off-peak-hours` are accepted.

SQLite uses WAL. Retention is controlled by `DATA_RETENTION_DAYS`: 0 keeps records; positive values delete older event and telemetry rows at startup and then at most hourly during inference. The telemetry key must be retained alongside encrypted exports if they need to remain decryptable. Desktop config controls retention through `retentionDays`.

## 7. Configuration and entry points

Backend environment variables in `backend/main.py`: `YOLO_MODEL` (default `yolo11m.pt`), `YOLO_DEVICE` (`auto`), `YOLO_IMAGE_SIZE` (416), `DETECTION_CONFIDENCE` (0.65), `DATABASE_PATH`, `EXPORT_DIRECTORY`, `TELEMETRY_KEY_PATH`, `TELEMETRY_ENCRYPTION_KEY`, `DATA_RETENTION_DAYS`, dwell timing variables, `HARDWARE_ALERT_ENABLED`, `FRONTEND_ORIGINS`, `ESP32_DISCOVERY_ENABLED`, and `ESP32_DISCOVERY_PORT`.

Frontend API selection is in `frontend/src/api.js`: Electron injects `window.__SCHOOL_ZONE_DESKTOP__` and uses same-origin proxy paths; otherwise `VITE_API_BASE_URL` wins; otherwise the current source fallback is `http://192.168.1.4:8000`. Development Vite proxy is separately `http://127.0.0.1:8000`. Review this default before changing local or deployed networking: it is not the localhost development proxy.

Direct commands and guides:

- Desktop run/build/package: root `package.json`; detailed steps in `DESKTOP.md`.
- Browser run and hosted frontend: root `readme.md`.
- Backend dependency/GPU setup: `backend/setup_backend.ps1`.
- Standalone camera utility: `backend/yolo11_camera.py` (does not start the API or persist dashboard data).
- Hardware USB/OTA targets and wiring: `hardware/platformio.ini`, `hardware/README.md`.

## 8. Frontend component responsibilities

- `ConnectionGate.jsx`: ESP32 setup-network gate and setup portal link.
- `Cam.jsx`: dashboard composition and the orchestration center; browser preferences, frame sampling, alert audio/schedule/manual controls, metrics, events, settings panels.
- `useCameraStream.js`: browser camera lifecycle, device enumeration, error mapping.
- `CameraFeed.jsx`: video/overlay and zone edit interaction.
- `AIRecognitionPanel.jsx`: model/service status and scheduled/manual alert controls.
- `AlertSettingsPanel.jsx`: fetches and writes persistent backend settings/presets.
- `RecentDetectionsPanel.jsx`: recent event list and export links.
- `PerformanceDashboard.jsx`: SVG charts from an in-memory 30-sample frontend window.
- `HardwareAlertNote.jsx`: backend hardware status/polling and operator note.
- `ClockBadge.jsx`, `Footer.jsx`, `Icon.jsx`: presentational UI.

Keep new cross-cutting state in the correct owner: persistent alert thresholds belong in backend API/SQLite; browser-only preferences belong in `Cam.jsx` localStorage; device behavior belongs in firmware. Avoid moving camera capture to Python without deliberately redesigning the browser-local capture/data path.

## 9. Change guide / where to start

| Change request | Read first |
| --- | --- |
| Detection model, boxes, zones, frame validation | `backend/main.py` (`get_model`, `parse_detection_zone`, `/api/detect`); `CameraFeed.jsx`; `Cam.jsx` |
| Alert dwell/countdown/cooldown | `backend/alert_logic.py`, its unit tests, then alert state and `/api/detect` in `backend/main.py` |
| Sound/scheduled/manual dashboard alerts | `frontend/src/components/Cam.jsx`, `AIRecognitionPanel.jsx`, backend alert acknowledgement routes |
| Alert settings/presets | `AlertSettingsPanel.jsx`, `backend/main.py` settings routes/schema |
| Event history or telemetry shape | `backend/main.py` schema, `save_telemetry`, exports, plus `RecentDetectionsPanel.jsx` |
| ESP32 transport/network settings | Electron config/env in `desktop/main.cjs`, mDNS code in `backend/main.py`, poll/ack code in `hardware/src/main.cpp` |
| LEDs/buzzer/wiring/OTA | `hardware/src/main.cpp`, `hardware/platformio.ini`, `hardware/README.md` |
| Desktop startup, local paths, packaging | `desktop/main.cjs`, root `package.json`, `build/installer.nsh`, `DESKTOP.md` |
| Browser origin / deployment | `frontend/src/api.js`, `frontend/vite.config.js`, FastAPI CORS in `backend/main.py`, README deployment section |

## 10. Verification and known cautions

Existing targeted tests are `python -m unittest backend.test_alert_logic` (or run the test from `backend`) and frontend scripts are `npm --prefix frontend run lint` / `npm --prefix frontend run build`. No broad integration test suite or hardware simulator is present. Do not assume UI/API/hardware changes are covered by the alert state-machine tests.

Things an agent should verify rather than assume:

1. `readme.md` says local Vite uses its proxy, but `api.js` currently defaults non-desktop builds to `http://192.168.1.4:8000`; local browser testing needs `VITE_API_BASE_URL` set to empty/same-origin or a compatible LAN API. Check actual intended setup before “fixing” either side.
2. `hardware/README.md` includes a direct-Uvicorn `ESP32_DISCOVERY_ENABLED` setup, while the main README's browser-development command only sets `HARDWARE_ALERT_ENABLED`. mDNS discovery and hardware alert enablement are separate flags.
3. `ConnectionGate` is unconditional in `App.jsx`; the dashboard first asks the operator to connect to the ESP32 setup AP, even though ESP32 is an optional hardware integration in other docs. Do not remove/change this flow without checking product intent.
4. The top-level `dashboard_stats` table is initialized but the current `people_seen` value sums `telemetry_records`; changing one will not necessarily affect the UI.
5. `alert_controller` and hardware state are module globals (single API process assumptions). Multiple Uvicorn workers would split alert state and are not a supported deployment shape without redesign.
6. The service-worker registration is disabled in Electron, but browser/PWA deployment may cache frontend assets; remember stale client assets when debugging frontend deployment.
7. LAN/public exposure has no built-in user authentication. Do not recommend public port forwarding. The desktop API listens on all interfaces only when opted in for ESP32 LAN access.

## 11. Suggested onboarding sequence for another agent

Read this file, then `readme.md` and `DESKTOP.md`; inspect root/frontend package scripts; trace `Cam.jsx` to `/api/detect`; read `alert_logic.py` and its tests; inspect backend persistence/export routes; finally review desktop startup and the ESP32 polling path if the task touches deployment or hardware. Start edits at the owner of the behavior, then check every caller/consumer across the interface boundary.
