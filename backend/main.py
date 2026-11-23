"""FastAPI service for browser frame inference, alert state, persistence, and data exports."""

import io
import json
import logging
import math
import os
import sqlite3
import socket
import time
from collections import deque
from contextlib import closing
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from csv import writer
from io import StringIO

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from cryptography.fernet import Fernet
from PIL import Image
import torch
from ultralytics import YOLO
from zeroconf import IPVersion, ServiceInfo
from zeroconf.asyncio import AsyncZeroconf

try:
    from .alert_logic import PedestrianAlertController
except ImportError:
    from alert_logic import PedestrianAlertController


# Runtime settings are environment driven so the same API can run on CPU-only and CUDA hosts.
MODEL_PATH = os.getenv("YOLO_MODEL", "yolo11m.pt")
DEVICE_SETTING = os.getenv("YOLO_DEVICE", "auto").strip().lower()
IMAGE_SIZE = int(os.getenv("YOLO_IMAGE_SIZE", "416"))
CONFIDENCE_THRESHOLD = float(os.getenv("DETECTION_CONFIDENCE", "0.65"))
TELEMETRY_ENCRYPTION_KEY = os.getenv("TELEMETRY_ENCRYPTION_KEY", "").strip()
TELEMETRY_KEY_PATH = Path(os.getenv("TELEMETRY_KEY_PATH", Path(__file__).with_name("telemetry.key")))
MAX_FRAME_BYTES = 8 * 1024 * 1024
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", Path(__file__).with_name("school_zone.db")))
EXPORT_DIRECTORY = Path(os.getenv("EXPORT_DIRECTORY", Path(__file__).with_name("export")))
DATA_RETENTION_DAYS = max(0, int(os.getenv("DATA_RETENTION_DAYS", "0")))
ALERT_ONE_PERSON_DWELL_SECONDS = max(0.0, float(os.getenv("ALERT_ONE_PERSON_DWELL_SECONDS", "12")))
ALERT_TWO_PERSON_DWELL_SECONDS = max(0.0, float(os.getenv("ALERT_TWO_PERSON_DWELL_SECONDS", "8")))
ALERT_THREE_OR_MORE_DWELL_SECONDS = max(0.0, float(os.getenv("ALERT_THREE_OR_MORE_DWELL_SECONDS", "5")))
HARDWARE_ALERT_ENABLED = os.getenv("HARDWARE_ALERT_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
HARDWARE_ALERT_WATCHDOG_GRACE_SECONDS = 5
STANDBY_BEEP_DELAY_SECONDS = 1.0
AUDIO_SOURCE_DIRECTORY = Path(__file__).with_name("source")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app):
    """Advertise the LAN API so ESP32 devices can find it without a typed IP address."""
    zeroconf = None
    service_info = None
    if os.getenv("ESP32_DISCOVERY_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect(("192.0.2.1", 9))
                address = socket.inet_aton(probe.getsockname()[0])
            port = int(os.getenv("ESP32_DISCOVERY_PORT", "8000"))
            service_info = ServiceInfo(
                "_safetawid._tcp.local.",
                "SAFETawid API._safetawid._tcp.local.",
                addresses=[address],
                port=port,
                properties={"path": "/api/hardware-alert", "version": "1"},
                server="safetawid-api.local.",
            )
            zeroconf = AsyncZeroconf(ip_version=IPVersion.V4Only)
            registration = await zeroconf.async_register_service(service_info)
            await registration
            logger.info("Advertised SAFETawid API on %s:%d via mDNS", socket.inet_ntoa(address), port)
        except Exception:
            logger.exception("Could not advertise the ESP32 API with mDNS")
            if zeroconf:
                await zeroconf.async_close()
                zeroconf = None
    try:
        yield
    finally:
        if zeroconf:
            try:
                if service_info:
                    unregistration = await zeroconf.async_unregister_service(service_info)
                    await unregistration
            finally:
                await zeroconf.async_close()

app = FastAPI(title="School Zone Camera Detection API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("FRONTEND_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["*"],
)

model = None
active_device = None
started_at = time.monotonic()
frame_times = deque(maxlen=30)
last_retention_cleanup = 0.0
person_was_present = False
alert_controller = PedestrianAlertController(
    ALERT_ONE_PERSON_DWELL_SECONDS,
    ALERT_TWO_PERSON_DWELL_SECONDS,
    ALERT_THREE_OR_MORE_DWELL_SECONDS,
)
alert_settings = {
    "confidence_threshold": CONFIDENCE_THRESHOLD,
    "one_person_dwell_seconds": ALERT_ONE_PERSON_DWELL_SECONDS,
    "two_person_dwell_seconds": ALERT_TWO_PERSON_DWELL_SECONDS,
    "three_or_more_dwell_seconds": ALERT_THREE_OR_MORE_DWELL_SECONDS,
    "standby_beep_delay_seconds": STANDBY_BEEP_DELAY_SECONDS,
    "alert_duration_seconds": 12.0,
    "cooldown_seconds": 10.0,
}
# Keep hardware delivery independent from browser audio playback acknowledgments.
hardware_alert_active = False
hardware_alert_deadline = None
hardware_alert_output_deadline = None
hardware_last_seen_at = None
dashboard_alert_finished = False
hardware_manual_mode = False


def clear_hardware_alert():
    global hardware_alert_active, hardware_alert_deadline, hardware_alert_output_deadline
    hardware_alert_active = False
    hardware_alert_deadline = None
    hardware_alert_output_deadline = None


def activate_hardware_alert():
    global hardware_alert_active, hardware_alert_deadline, hardware_alert_output_deadline, dashboard_alert_finished
    hardware_alert_active = True
    dashboard_alert_finished = False
    now = time.monotonic()
    hardware_alert_output_deadline = now + float(alert_settings["alert_duration_seconds"])
    hardware_connected = hardware_last_seen_at is not None and now - hardware_last_seen_at <= 3.0
    watchdog_grace = HARDWARE_ALERT_WATCHDOG_GRACE_SECONDS if hardware_connected else 0
    hardware_alert_deadline = hardware_alert_output_deadline + watchdog_grace


def expire_hardware_alert_if_needed():
    if hardware_alert_active and hardware_alert_deadline is not None and time.monotonic() >= hardware_alert_deadline:
        clear_hardware_alert()
        alert_controller.finish_alert(time.monotonic())


@app.get("/api/audio/{filename}")
def get_alert_audio(filename: str):
    """Serve only the packaged alert sounds; arbitrary filesystem paths are not accepted."""
    if filename not in {"beep1.mp3", "beep3.mp3"}:
        raise HTTPException(status_code=404, detail="Audio file not found.")
    path = AUDIO_SOURCE_DIRECTORY / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Audio file not found.")
    return FileResponse(path, media_type="audio/mpeg")


@app.post("/api/alert-finished")
def alert_finished():
    """Let the browser release the alert playback lock after audio ends or is stopped."""
    global dashboard_alert_finished
    expire_hardware_alert_if_needed()
    dashboard_alert_finished = True
    # When hardware delivery is enabled, wait for the MCU to acknowledge its output sequence.
    if not hardware_alert_active:
        alert_controller.finish_alert(time.monotonic())
    return {"status": "ready"}


@app.get("/api/hardware-alert")
def hardware_alert_status(request: Request):
    """Expose the active alert latch for an ESP32 polling over the local network."""
    global hardware_last_seen_at
    now = time.monotonic()
    if request.headers.get("X-Hardware-Client") == "safetawid-esp32":
        hardware_last_seen_at = now
    expire_hardware_alert_if_needed()
    now = time.monotonic()
    remaining_ms = max(0, int((hardware_alert_deadline - now) * 1000)) if hardware_alert_active and hardware_alert_deadline is not None else 0
    output_remaining_ms = max(0, int((hardware_alert_output_deadline - now) * 1000)) if hardware_alert_active and hardware_alert_output_deadline is not None else 0
    hardware_connected = hardware_last_seen_at is not None and now - hardware_last_seen_at <= 3.0
    return {
        "active": hardware_alert_active,
        "enabled": HARDWARE_ALERT_ENABLED,
        "manual_mode": hardware_manual_mode,
        "remaining_ms": remaining_ms,
        "duration_ms": int(float(alert_settings["alert_duration_seconds"]) * 1000),
        "output_remaining_ms": output_remaining_ms,
        "hardware_connected": hardware_connected,
    }


class HardwareManualModeUpdate(BaseModel):
    enabled: bool


@app.post("/api/hardware-alert/manual-mode")
def update_hardware_manual_mode(settings: HardwareManualModeUpdate):
    """Tell the ESP32 whether to show its manual-mode idle signal."""
    global hardware_manual_mode
    hardware_manual_mode = settings.enabled
    if not hardware_manual_mode:
        clear_hardware_alert()
    return {"manual_mode": hardware_manual_mode, "active": hardware_alert_active}


@app.post("/api/hardware-alert/manual")
def start_manual_hardware_alert():
    """Latch a manual dashboard alert for the ESP32 to pick up on its next poll."""
    if not HARDWARE_ALERT_ENABLED:
        raise HTTPException(status_code=503, detail="Hardware alerts are disabled on the backend.")
    activate_hardware_alert()
    return {"status": "active", "duration_seconds": alert_settings["alert_duration_seconds"]}


@app.post("/api/hardware-alert/cancel")
def cancel_manual_hardware_alert():
    """Clear a manual hardware alert when the operator stops it from the dashboard."""
    clear_hardware_alert()
    alert_controller.finish_alert(time.monotonic())
    return {"status": "ready"}


@app.post("/api/hardware-alert/finished")
def hardware_alert_finished():
    """Acknowledge that the external light/sound sequence completed."""
    clear_hardware_alert()
    if dashboard_alert_finished:
        alert_controller.finish_alert(time.monotonic())
    return {"status": "ready"}


def connect_database():
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database():
    """Create the local SQLite schema idempotently before serving API requests."""
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect_database()) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS detection_events (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                time TEXT NOT NULL,
                confidence INTEGER NOT NULL,
                zone_result TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS dashboard_stats (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                people_seen INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS telemetry_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp_utc TEXT NOT NULL,
                inference_fps REAL NOT NULL,
                mean_detection_confidence REAL,
                zone_configured INTEGER NOT NULL,
                crosswalk_intrusion INTEGER,
                intrusion_timestamp_utc TEXT,
                detection_count INTEGER NOT NULL,
                inference_latency_ms REAL NOT NULL,
                end_to_end_alert_latency_seconds REAL,
                gpio_output_activation_latency_ms REAL
            );
            CREATE TABLE IF NOT EXISTS alert_presets (
                preset_key TEXT PRIMARY KEY,
                settings_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT OR IGNORE INTO dashboard_stats (id, people_seen) VALUES (1, 0);
            """
        )
        connection.execute("CREATE TABLE IF NOT EXISTS alert_settings (key TEXT PRIMARY KEY, value REAL NOT NULL)")
        rows = connection.execute("SELECT key, value FROM alert_settings").fetchall()
        for row in rows:
            if row["key"] in alert_settings:
                alert_settings[row["key"]] = float(row["value"])
        connection.commit()


def cleanup_expired_records():
    """Enforce configured retention for event and per-frame telemetry records."""
    if not DATA_RETENTION_DAYS:
        return
    cutoff = datetime.now(timezone.utc).timestamp() - DATA_RETENTION_DAYS * 86400
    cutoff_iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
    with closing(connect_database()) as connection:
        connection.execute("DELETE FROM telemetry_records WHERE timestamp_utc < ?", (cutoff_iso,))
        # Event IDs are UTC ISO timestamps; the display-only event time is a local HH:MM:SS string.
        connection.execute("DELETE FROM detection_events WHERE id < ?", (cutoff_iso,))
        connection.commit()


def get_recent_events(limit=100):
    """Return newest-first event rows in the camelCase shape expected by the dashboard."""
    with closing(connect_database()) as connection:
        rows = connection.execute(
            "SELECT id, label, time, confidence, zone_result FROM detection_events ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [
        {"id": row["id"], "label": row["label"], "time": row["time"],
         "confidence": row["confidence"], "zoneResult": row["zone_result"]}
        for row in rows
    ]


def get_people_seen():
    """Sum detections still inside the configured telemetry retention window."""
    with closing(connect_database()) as connection:
        row = connection.execute("SELECT COALESCE(SUM(detection_count), 0) AS people_seen FROM telemetry_records").fetchone()
    return row["people_seen"]


def save_telemetry(timestamp, fps, detections, detection_zone, inference_ms):
    """Append one record per processed frame; intrusion stays NULL when no zone is configured."""
    global last_retention_cleanup
    intrusion = bool(detections) if detection_zone else None
    mean_confidence = (
        sum(item["confidence"] for item in detections) / len(detections) if detections else None
    )
    with closing(connect_database()) as connection:
        now = time.monotonic()
        if DATA_RETENTION_DAYS and now - last_retention_cleanup >= 3600:
            cutoff = datetime.now(timezone.utc).timestamp() - DATA_RETENTION_DAYS * 86400
            cutoff_iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
            connection.execute("DELETE FROM telemetry_records WHERE timestamp_utc < ?", (cutoff_iso,))
            connection.execute("DELETE FROM detection_events WHERE id < ?", (cutoff_iso,))
            last_retention_cleanup = now
        connection.execute(
            """
            INSERT INTO telemetry_records (
                timestamp_utc, inference_fps, mean_detection_confidence, zone_configured,
                crosswalk_intrusion, intrusion_timestamp_utc, detection_count,
                inference_latency_ms, end_to_end_alert_latency_seconds,
                gpio_output_activation_latency_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
            """,
            (
                timestamp,
                fps,
                mean_confidence,
                int(detection_zone is not None),
                int(intrusion) if intrusion is not None else None,
                timestamp if intrusion else None,
                len(detections),
                inference_ms,
            ),
        )
        connection.commit()


def get_telemetry_cipher():
    """Build the export cipher from an explicit key or a race-safe generated local key file."""
    if TELEMETRY_ENCRYPTION_KEY:
        return Fernet(TELEMETRY_ENCRYPTION_KEY.encode("ascii"))

    TELEMETRY_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        key = TELEMETRY_KEY_PATH.read_bytes().strip()
    except FileNotFoundError:
        key = Fernet.generate_key()
        try:
            with TELEMETRY_KEY_PATH.open("xb") as key_file:
                key_file.write(key)
        except FileExistsError:
            key = TELEMETRY_KEY_PATH.read_bytes().strip()
    return Fernet(key)


initialize_database()
cleanup_expired_records()


def apply_alert_settings():
    global CONFIDENCE_THRESHOLD, STANDBY_BEEP_DELAY_SECONDS
    CONFIDENCE_THRESHOLD = alert_settings["confidence_threshold"]
    STANDBY_BEEP_DELAY_SECONDS = alert_settings["standby_beep_delay_seconds"]
    alert_controller.one_person_seconds = alert_settings["one_person_dwell_seconds"]
    alert_controller.two_persons_seconds = alert_settings["two_person_dwell_seconds"]
    alert_controller.three_or_more_seconds = alert_settings["three_or_more_dwell_seconds"]
    alert_controller.cooldown_seconds = alert_settings["cooldown_seconds"]


apply_alert_settings()


class AlertSettingsUpdate(BaseModel):
    confidence_threshold: float = Field(ge=0.0, le=1.0)
    one_person_dwell_seconds: float = Field(ge=0.0, le=300.0)
    two_person_dwell_seconds: float = Field(ge=0.0, le=300.0)
    three_or_more_dwell_seconds: float = Field(ge=0.0, le=300.0)
    standby_beep_delay_seconds: float = Field(ge=0.0, le=60.0)
    alert_duration_seconds: float = Field(ge=1.0, le=300.0)
    cooldown_seconds: float = Field(ge=0.0, le=300.0)


ALERT_PRESET_KEYS = {"peak-hours", "off-peak-hours"}


@app.get("/api/alert-settings")
def get_alert_settings():
    return dict(alert_settings)


@app.put("/api/alert-settings")
def update_alert_settings(settings: AlertSettingsUpdate):
    updated = settings.model_dump()
    with closing(connect_database()) as connection:
        connection.executemany(
            "INSERT INTO alert_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            list(updated.items()),
        )
        connection.commit()
    alert_settings.update(updated)
    apply_alert_settings()
    return dict(alert_settings)


@app.get("/api/alert-presets")
def get_alert_presets():
    with closing(connect_database()) as connection:
        rows = connection.execute("SELECT preset_key, settings_json FROM alert_presets").fetchall()
    presets = {key: None for key in ALERT_PRESET_KEYS}
    for row in rows:
        if row["preset_key"] in presets:
            presets[row["preset_key"]] = json.loads(row["settings_json"])
    return presets


@app.put("/api/alert-presets/{preset_key}")
def save_alert_preset(preset_key: str, settings: AlertSettingsUpdate):
    if preset_key not in ALERT_PRESET_KEYS:
        raise HTTPException(status_code=404, detail="Unknown alert preset.")
    saved_settings = settings.model_dump()
    with closing(connect_database()) as connection:
        connection.execute(
            "INSERT INTO alert_presets (preset_key, settings_json, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(preset_key) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at",
            (preset_key, json.dumps(saved_settings), datetime.now(timezone.utc).isoformat()),
        )
        connection.commit()
    return {"preset_key": preset_key, "settings": saved_settings}


def get_model():
    global model, active_device
    if model is None:
        automatic = DEVICE_SETTING == "auto"
        if automatic:
            target_device = "0" if torch.cuda.is_available() else "cpu"
        else:
            target_device = DEVICE_SETTING
            if (target_device.isdigit() or target_device.startswith("cuda")) and not torch.cuda.is_available():
                raise RuntimeError(
                    f"YOLO_DEVICE={DEVICE_SETTING} requests CUDA, but CUDA is unavailable to PyTorch. "
                    "Use YOLO_DEVICE=auto or cpu, or install a compatible CUDA-enabled PyTorch build."
                )

        try:
            loaded_model = _load_and_warm_model(target_device)
        except Exception:
            if not automatic or target_device == "cpu":
                raise
            # Include the warmup in device selection: CUDA may be visible yet fail on the first real kernel.
            logger.exception("CUDA model startup failed; falling back to CPU")
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            target_device = "cpu"
            loaded_model = _load_and_warm_model(target_device)

        active_device = target_device
        model = loaded_model
    return model


def _load_and_warm_model(device):
    """Load the model and run a representative prediction so startup catches device errors."""
    loaded_model = YOLO(MODEL_PATH)
    loaded_model.to(f"cuda:{device}" if device.isdigit() else device)
    loaded_model.predict(
        Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE)),
        device=device,
        imgsz=IMAGE_SIZE,
        quantize=16 if is_cuda_device(device) else 32,
        classes=[0],
        verbose=False,
    )
    if is_cuda_device(device):
        torch.cuda.synchronize(cuda_device_index(device))
    return loaded_model


def is_cuda_device(device):
    return device.isdigit() or device.startswith("cuda")


def cuda_device_index(device):
    if device.isdigit():
        return int(device)
    if device == "cuda":
        return 0
    if device.startswith("cuda:") and device.split(":", 1)[1].isdigit():
        return int(device.split(":", 1)[1])
    return 0


def api_device_name(device):
    return f"cuda:{device}" if device and device.isdigit() else device


def parse_detection_zone(value):
    """Parse up to two normalized rectangles; an empty list means full frame."""
    if not value or value == "null":
        return None
    try:
        payload = json.loads(value)
        zones = payload if isinstance(payload, list) else [payload]
        if len(zones) > 2:
            raise ValueError("At most two detection areas are supported.")
        parsed = []
        for zone in zones:
            x, y, width, height = (zone[key] for key in ("x", "y", "width", "height"))
            if not all(isinstance(item, (int, float)) and math.isfinite(item) for item in (x, y, width, height)):
                raise ValueError("Zone coordinates must be finite numbers.")
            if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
                raise ValueError("Zone must be a non-empty rectangle inside the camera frame.")
            parsed.append({"x": x, "y": y, "width": width, "height": height})
        return parsed or None
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid detection zone: {error}") from error


def gpu_status():
    """Report CUDA visibility separately from the device chosen for the loaded model."""
    available = torch.cuda.is_available()
    index = cuda_device_index(active_device) if active_device and is_cuda_device(active_device) else 0
    return {
        "available": available,
        "device": torch.cuda.get_device_name(index) if available else None,
        "cuda_runtime": torch.version.cuda,
        "selected_device": api_device_name(active_device) if active_device else None,
    }

@app.get("/api/health")
def health():
    """Lightweight readiness endpoint; it reports standby until first inference loads YOLO."""
    gpu = gpu_status()
    return {
        "status": "ready" if model is not None else "standby",
        "model": MODEL_PATH,
        "model_loaded": model is not None,
        "device": api_device_name(active_device) if model is not None else None,
        "gpu": gpu,
        "hardware_alert_enabled": HARDWARE_ALERT_ENABLED,
        "hardware_alert_active": hardware_alert_active,
    }


@app.get("/api/summary")
def summary():
    """Provide persisted dashboard totals and recent events without running inference."""
    return {
        "status": "ready" if model is not None else "standby",
        "model": MODEL_PATH,
        "device": api_device_name(active_device),
        "gpu": gpu_status(),
        "hardware_alert_enabled": HARDWARE_ALERT_ENABLED,
        "hardware_alert_active": hardware_alert_active,
        "uptime_seconds": round(time.monotonic() - started_at),
        "people_seen": get_people_seen(),
        "events": get_recent_events(),
    }


@app.get("/api/events/export")
def export_events():
    """Export the full event history as a spreadsheet-friendly UTF-8 CSV."""
    output = StringIO(newline="")
    csv_writer = writer(output)
    csv_writer.writerow(("Timestamp", "Event", "Confidence (%)", "Zone result"))
    with closing(connect_database()) as connection:
        rows = connection.execute(
            "SELECT id, label, confidence, zone_result FROM detection_events ORDER BY id ASC"
        ).fetchall()
    for row in rows:
        csv_writer.writerow((row["id"], row["label"], row["confidence"], row["zone_result"]))
    content = "\ufeff" + output.getvalue()
    EXPORT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (EXPORT_DIRECTORY / "school-zone-events.csv").write_text(content, encoding="utf-8", newline="")
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="school-zone-events.csv"'},
    )


@app.get("/api/telemetry/export")
def export_telemetry():
    """Encrypt the full frame telemetry CSV before returning it to the browser."""
    output = StringIO(newline="")
    csv_writer = writer(output)
    csv_writer.writerow((
        "Timestamp UTC", "Inference FPS", "Mean detection confidence (%)",
        "Crosswalk zone configured", "Crosswalk intrusion", "Intrusion timestamp UTC",
        "Detection count", "Inference latency (ms)",
        "End-to-end alert activation latency (s)", "GPIO output activation latency (ms)",
    ))
    with closing(connect_database()) as connection:
        rows = connection.execute("SELECT * FROM telemetry_records ORDER BY id ASC").fetchall()
    for row in rows:
        csv_writer.writerow((
            row["timestamp_utc"], row["inference_fps"], row["mean_detection_confidence"],
            row["zone_configured"], row["crosswalk_intrusion"], row["intrusion_timestamp_utc"],
            row["detection_count"], row["inference_latency_ms"],
            row["end_to_end_alert_latency_seconds"], row["gpio_output_activation_latency_ms"],
        ))
    try:
        encrypted_csv = get_telemetry_cipher().encrypt(
            ("\ufeff" + output.getvalue()).encode("utf-8")
        )
    except (ValueError, UnicodeEncodeError, OSError) as error:
        raise HTTPException(status_code=503, detail="Unable to load the telemetry encryption key.") from error
    EXPORT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (EXPORT_DIRECTORY / "school-zone-telemetry.csv.enc").write_bytes(encrypted_csv)
    return Response(
        content=encrypted_csv,
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="school-zone-telemetry.csv.enc"'},
    )

@app.post("/api/detect")
async def detect(request: Request):
    """Decode one JPEG/PNG frame, run person detection, persist metrics, and return overlay data."""
    global hardware_alert_active, person_was_present
    request_started_at = time.perf_counter()
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="No camera frame was provided.")
    if len(image_bytes) > MAX_FRAME_BYTES:
        raise HTTPException(status_code=413, detail="Camera frame is too large.")
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=400, detail="Frame must be a valid JPEG or PNG image.") from error
    detection_zone = parse_detection_zone(request.headers.get("x-detection-zone"))

    try:
        loaded_model = get_model()
        if is_cuda_device(active_device):
            torch.cuda.synchronize(cuda_device_index(active_device))
        inference_started_at = time.perf_counter()
        result = loaded_model.predict(
            image,
            conf=CONFIDENCE_THRESHOLD,
            device=active_device,
            imgsz=IMAGE_SIZE,
            quantize=16 if is_cuda_device(active_device) else 32,
            classes=[0],
            verbose=False,
        )[0]
        if is_cuda_device(active_device):
            torch.cuda.synchronize(cuda_device_index(active_device))
        inference_ms = (time.perf_counter() - inference_started_at) * 1000
    except Exception as error:
        logger.exception("YOLO detection failed (model=%s, device=%s)", MODEL_PATH, active_device or DEVICE_SETTING)
        raise HTTPException(status_code=503, detail=f"Detection model failed: {error}") from error

    detections = []
    # Zone membership uses the box center, so partial overlap at a zone edge does not count as entry.
    for box in result.boxes:
        class_id = int(box.cls[0].item())
        label = result.names[class_id]
        if label != "person":
            continue
        confidence = float(box.conf[0].item())
        if confidence < CONFIDENCE_THRESHOLD:
            continue
        x1, y1, x2, y2 = [int(value) for value in box.xyxy[0].tolist()]
        if detection_zone:
            center_x = ((x1 + x2) / 2) / image.width
            center_y = ((y1 + y2) / 2) / image.height
            if not any(
                zone["x"] <= center_x <= zone["x"] + zone["width"]
                and zone["y"] <= center_y <= zone["y"] + zone["height"]
                for zone in detection_zone
            ):
                continue
        detections.append({"label": "Person", "confidence": round(confidence * 100, 1), "box": [x1, y1, x2, y2]})

    now = datetime.now(timezone.utc).isoformat()
    event = None
    # Events mark the transition from an empty frame to an occupied frame, not every sampled frame.
    if detections and not person_was_present:
        event = {
            "id": now,
            "label": f"{len(detections)} pedestrian" + ("s" if len(detections) != 1 else ""),
            "time": datetime.now().astimezone().strftime("%H:%M:%S"),
            "confidence": round(sum(item["confidence"] for item in detections) / len(detections)),
            "zoneResult": "Person detected",
        }
    person_was_present = bool(detections)

    people_count = len(detections)
    zone_key = None if detection_zone is None else tuple(
        tuple(zone[key] for key in ("x", "y", "width", "height")) for zone in detection_zone
    )
    expire_hardware_alert_if_needed()
    detection_now = time.monotonic()
    alert_status = alert_controller.update(people_count, zone_key, detection_now)
    if alert_status["trigger"] and HARDWARE_ALERT_ENABLED and not hardware_manual_mode:
        activate_hardware_alert()

    with closing(connect_database()) as connection:
        if event:
            connection.execute(
                "INSERT INTO detection_events (id, label, time, confidence, zone_result) VALUES (?, ?, ?, ?, ?)",
                (event["id"], event["label"], event["time"], event["confidence"], event["zoneResult"]),
            )
        connection.commit()
    # This deque yields a rolling processed-frame rate; it is not the camera's capture FPS.
    frame_times.append(time.monotonic())
    fps = 0
    if len(frame_times) > 1 and frame_times[-1] > frame_times[0]:
        fps = (len(frame_times) - 1) / (frame_times[-1] - frame_times[0])
    save_telemetry(now, fps, detections, detection_zone, inference_ms)
    request_ms = (time.perf_counter() - request_started_at) * 1000
    return {
        "timestamp": now,
        "model": MODEL_PATH,
        "device": api_device_name(active_device),
        "detections": detections,
        "count": len(detections),
        "alert_trigger": alert_status["trigger"],
        "alert_pending": alert_status["pending"],
        "alert_playing": alert_status["alert_playing"],
        "alert_settings": {
            "one_person_dwell_seconds": ALERT_ONE_PERSON_DWELL_SECONDS,
            "two_person_dwell_seconds": ALERT_TWO_PERSON_DWELL_SECONDS,
            "three_or_more_dwell_seconds": ALERT_THREE_OR_MORE_DWELL_SECONDS,
            "standby_beep_delay_seconds": STANDBY_BEEP_DELAY_SECONDS,
            "alert_duration_seconds": alert_settings["alert_duration_seconds"],
            "cooldown_seconds": alert_settings["cooldown_seconds"],
        },
        "average_confidence": round(sum(item["confidence"] for item in detections) / len(detections), 1) if detections else None,
        "total_people_seen": get_people_seen(),
        "inference_fps": round(fps, 1),
        "inference_ms": round(inference_ms, 1),
        "request_ms": round(request_ms, 1),
        "frame_width": image.width,
        "frame_height": image.height,
        "detection_zone": detection_zone,
        "events": get_recent_events(10),
    }
