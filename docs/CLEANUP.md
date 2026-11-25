# SAFETawid Folder and File Review

I reviewed the current source tree and searched for references to the files that look like cleanup candidates. **I did not delete anything.**

## Lowest-risk cleanup candidates

These files appear unused by the running application based on the current source references:

| File | Why it appears unused | Recommendation |
|---|---|---|
| `frontend/frontend/package-lock.json` | It is an almost-empty lockfile in a nested folder with no matching `package.json` or app code. The real frontend package and lockfile are in `frontend/`. | **Best first candidate to remove.** |
| `frontend/src/assets/vite.svg` | No application code references it; it is leftover Vite starter artwork. | Safe to remove if you do not want to keep starter assets. |
| `frontend/src/assets/react.svg` | No application code references it; it is leftover React starter artwork. | Safe to remove if you do not want to keep starter assets. |
| `frontend/src/assets/hero.png` | No application code references it. | Safe to remove if it is not reserved for future UI work. |
| `frontend/public/icons.svg` | No code or HTML references it. The app’s `Icon.jsx` defines its own icons. | Safe to remove if no external page links to it. |
| `backend/source/beep2.mp3` | The API explicitly serves only `beep1.mp3` and `beep3.mp3`; no other references to `beep2.mp3` were found. | Safe to remove if it is not intended for a future sound feature. |

These are **optional workflow files**, not dead weight in the same sense. Remove them only if you are sure you do not need their associated use:

| File | What would be lost if removed |
|---|---|
| `backend/yolo11_camera.py` | The standalone camera-inference utility documented in `readme.md`. It runs YOLO without the dashboard/API. |
| `backend/decrypt.py` | A helper for decrypting telemetry exports. It is included in the packaged backend resource list, though the running service does not import it. |
| `desktop/desktop-config.example.json` | A sample configuration. The Electron app creates its own config, but the sample can help operators understand LAN and hardware settings. |
| `hardware/.vscode/extensions.json` | A VS Code recommendation for PlatformIO. It does not affect firmware builds or operation. |
| `backend/test_alert_logic.py` and `backend/test_runtime_config.py` | Tests are not required at runtime, but deleting them would remove regression checks. I recommend keeping them. |

## Files I recommend keeping

These files support normal builds, documented workflows, or system behavior:

| Folder | Files | Purpose |
|---|---|---|
| Project root | `package.json`, `package-lock.json` | Electron scripts, installer configuration, and pinned root dependencies. |
| Project root | `readme.md`, `DESKTOP.md`, `PROJECT_MAP.md` | User setup and deployment instructions, desktop operation, and the codebase knowledge map. |
| `build/` | `installer.nsh` | Custom NSIS installer page for selecting a YOLO model. The root build configuration refers to it. |
| `desktop/` | `main.cjs` | Electron startup, configuration, backend process management, local UI server, and API proxy. |
| `desktop/` | `desktop-config.example.json` | Optional operator reference, as described above. |
| `backend/` | `main.py` | FastAPI application, inference, API endpoints, alerts, persistence, and exports. |
| `backend/` | `alert_logic.py`, `runtime_config.py` | Alert state machine and environment configuration validation. |
| `backend/` | `requirements.txt`, `setup_backend.ps1` | Python dependencies and Windows backend environment setup. |
| `backend/source/` | `beep1.mp3`, `beep3.mp3` | Sounds currently served by the API and used by the dashboard. |
| `frontend/` | `package.json`, `package-lock.json` | The actual Vite/React package and its pinned dependencies. Keep this lockfile; it is separate from the root lockfile. |
| `frontend/` | `vite.config.js`, `eslint.config.js`, `index.html` | Frontend development server, lint rules, and browser entry document. |
| `frontend/src/` | `main.jsx`, `App.jsx`, `api.js`, `App.css`, `index.css` | React startup, root component, API URL selection, and styles. |
| `frontend/src/components/` | `Cam.jsx`, `CameraFeed.jsx`, `ConnectionGate.jsx`, `useCameraStream.js` | Main dashboard orchestration, camera view, setup gate, and camera lifecycle. |
| `frontend/src/components/` | `AIRecognitionPanel.jsx`, `AlertSettingsPanel.jsx`, `HardwareAlertNote.jsx`, `RecentDetectionsPanel.jsx`, `PerformanceDashboard.jsx` | Dashboard status, settings, hardware state, events, and metrics UI. |
| `frontend/src/components/` | `ClockBadge.jsx`, `Footer.jsx`, `Icon.jsx` | Shared display components and the app’s icon system. |
| `frontend/public/` | `favicon.svg`, `pwa-icon.svg`, `manifest.webmanifest`, `service-worker.js` | Browser/PWA icons, install metadata, and offline app-shell caching. These are referenced by the HTML, manifest, or service-worker registration. |
| `hardware/` | `src/main.cpp`, `platformio.ini`, `README.md` | ESP32 firmware, build targets, wiring, setup, and operation instructions. |

## Generated folders

These are build/install outputs rather than source files:

- `node_modules/` — installed root Node dependencies.
- `frontend/node_modules/` — installed frontend dependencies.
- `frontend/dist/` — generated frontend production build.
- `release/` — generated Windows installer and unpacked app.

They can be regenerated, but `release/` currently contains the installer. Keep it if you want to retain that build artifact. The source `.gitignore` already excludes these generated folders.

## Suggested cleanup choices

1. **Minimal cleanup:** remove only `frontend/frontend/package-lock.json`.
2. **Remove unused starter/media files too:** remove that nested lockfile, the three unreferenced frontend source assets, `frontend/public/icons.svg`, and `backend/source/beep2.mp3`.
3. **Trim optional tools:** additionally remove `backend/yolo11_camera.py`, `backend/decrypt.py`, the desktop config example, or VS Code recommendations only if you are willing to give up those documented or operator-facing utilities.

I recommend keeping the tests, both actual package lockfiles, installer script, PWA files, and hardware files.```