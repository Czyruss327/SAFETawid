# Desktop app: local setup and operation

The desktop shell reuses the React dashboard and FastAPI/YOLO service. Electron starts one local API process, proxies the dashboard's API calls, and stops the service when the app closes. Camera video is captured by the desktop Chromium window and sent to the local backend in memory; this project does not save camera frames or video files.

## First-time Windows setup

1. Install Node.js 20 or newer and Python 3.11 or newer.
2. From the project folder, run `npm install` and `npm --prefix frontend install`.
3. Run `npm run desktop:start`. On first launch, the app creates its Python environment under AppData, installs backend packages, and selects CUDA or CPU PyTorch. Python packages are downloaded, so first setup needs an internet connection. Development runs default to the lighter YOLO11n model; set `model` in `desktop-config.json` to `yolo11s.pt`, `yolo11m.pt`, or `yolo11l.pt` to choose another size.

For development, run `npm run desktop:dev` after the frontend has been built. The desktop app binds its API to 127.0.0.1 by default and uses a random available port. It does not open a public endpoint.

## Local data and privacy

The app writes its SQLite database, generated telemetry encryption key, and exported CSV files under Electron's user data folder (Windows: `%APPDATA%\school-zone-safety-monitor-desktop` or the path shown by **App → Open local data folder**). Detection frames are processed in memory and are not persisted. Detection events and one-per-frame metrics are persisted as described in the main README. Keep Windows account access restricted to approved operators and protect backups according to the approved research protocol.

Set `retentionDays` in `desktop-config.json` to the period approved for the study. `0` disables automatic deletion; it means records remain until an operator deletes them. When set above zero, the backend deletes older event and telemetry records on startup and periodically during inference. Before live research use, set this to match the UREC-approved retention period rather than relying on the default.

To delete local records, quit the app, then remove `school_zone.db`, `school_zone.db-shm`, and `school_zone.db-wal` from the local data folder. This also deletes saved events, totals, alert settings, and telemetry. Remove `telemetry.key` only if encrypted exports should no longer be decryptable. Delete exports separately if they are no longer required. Follow the approved protocol and backup/deletion rules.

## Desktop configuration

The app creates `desktop-config.json` under the local data folder on first launch:

- `allowEsp32LanAccess`: defaults to `false`; set to `true` on the designated trusted school LAN when the ESP32 needs to connect. The OS firewall may need a narrow local-network rule. Do not forward the port from the router or expose it through a public tunnel.
- `apiPort`: defaults to `8000`; the backend advertises its selected port and LAN address over mDNS when LAN access and hardware alerts are both enabled. ESP32 discovers it automatically, even if the app had to select a different port.
- `hardwareAlertsEnabled`: defaults to `false`; set to `true` when the approved deployment calls for physical alerts.
- `retentionDays`: set to the UREC-approved data retention period in days; zero means no automatic cleanup.
- `pythonExecutable`: optional full path to the Python executable used to create the AppData runtime on first launch.
- `model`: local model filename or supported Ultralytics model name. YOLO11n is recommended for most laptops. YOLO11s, YOLO11m, and YOLO11l use progressively more memory and compute.
- `device`: `auto` (default), `cpu`, or a CUDA device such as `cuda:0`. Use `cpu` to avoid GPU/CUDA runtime problems.

Close and restart the desktop app after changing configuration. ESP32 Wi-Fi credentials are configured through its on-device setup Wi-Fi page; the backend address is discovered automatically. Dashboard alert thresholds remain editable in **Dashboard menu → Alert settings**. Hardware access exposes the backend to other devices on the local network and does not add user authentication; use it only on a trusted, access-controlled LAN.

For automatic ESP32 connection, run `npm run backend:setup` to install the backend's mDNS service advertiser. Set both `allowEsp32LanAccess` and `hardwareAlertsEnabled` to `true`, restart the desktop app, and allow its API TCP port plus mDNS multicast (UDP 5353) on the Windows Private network if prompted. On first setup, enter only the site's Wi-Fi credentials in the ESP32 setup page. The ESP32 then discovers the API automatically and repeats discovery after reconnecting. The computer and ESP32 must share a LAN that permits multicast; guest Wi-Fi/client isolation can block discovery.

## CUDA setup troubleshooting

An RTX 3050 is CUDA-capable (compute capability 8.6). The first CUDA probe may report that CUDA is unavailable because the initial `requirements.txt` install can bring in a CPU-only PyTorch build; the setup script then installs and probes a GPU-enabled build. The probe now runs a CUDA/cuDNN convolution before reporting success. If neither GPU wheel passes, setup installs CPU PyTorch so the app can still run.

If setup ends with CPU fallback, update the NVIDIA driver and rerun `npm run backend:setup`. CUDA 13.x needs a recent driver (NVIDIA lists 580 or newer for minor-version compatibility); the setup script also tries the CUDA 12.6 wheel for older supported drivers. A separate CUDA Toolkit installation is not required for the PyTorch wheels. See the [PyTorch Windows wheel options](https://pytorch.org/get-started/previous-versions/) and [NVIDIA CUDA driver compatibility table](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html).

If the GPU build still fails, set `device` to `cpu` in `desktop-config.json` to use the app while investigating, and share the final CUDA/cuDNN probe output plus `nvidia-smi` driver version for diagnosis.

## Packaging

Install the npm dependencies on a Windows x64 build machine, then run `npm run package:win`. Electron Builder produces an NSIS installer under `release/`. During installation, users choose YOLO11n (recommended), YOLO11s, YOLO11m, or YOLO11l. The installer includes all four weights but keeps only the chosen weight in installed resources; first launch copies that weight to AppData. The app runs `backend/setup_backend.ps1` and writes the Python environment, database, exports, and config to the user's AppData folder. The target PC still needs Python 3.11 or newer and an internet connection for first-time Python package installation; this installer does not bundle Python or PyTorch. Unsigned builds may show a Windows SmartScreen warning. Build and launch the installer on the target PC before deployment, and verify camera access and CPU/GPU inference there.
