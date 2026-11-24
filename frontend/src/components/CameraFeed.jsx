import { useRef, useState } from "react";
import Icon from "./Icon.jsx";

const statusLabels = {
  starting: { badge: "CONNECTING", title: "Connecting to camera", detail: "Waiting for camera access…" },
  error: { badge: "CAMERA ERROR", title: "Camera unavailable" },
  idle: { badge: "STREAM OFFLINE", title: "Camera is offline", detail: "Turn on the camera to resume the live view." },
};

/** Renders the local video, detection/zone overlay, zone editor, and camera controls. */
export default function CameraFeed({
  videoRef,
  status,
  error,
  cameras,
  cameraId,
  onCameraChange,
  onStart,
  onStop,
  clock,
  detections = [],
  frameWidth,
  frameHeight,
  cameraFps = 0,
  detectionZone,
  editingZone,
  editingZoneIndex = 0,
  onEditDetectionZone,
  onAddDetectionZone,
  onEditingZoneChange,
  onDetectionZoneChange,
  onDetectionZoneReset,
}) {
  const live = status === "live";
  const offlineContent = statusLabels[status] ?? statusLabels.idle;
  const cameraViewRef = useRef(null);
  const dragStartRef = useRef(null);
  const [draftZone, setDraftZone] = useState(null);
  const [videoSize, setVideoSize] = useState({ width: 640, height: 360 });
  const viewWidth = frameWidth || videoSize.width;
  const viewHeight = frameHeight || videoSize.height;

  // Convert pointer coordinates through object-fit: contain's letterboxing so zones align with source-frame coordinates.
  const pointerToNormalized = (event) => {
    const rect = cameraViewRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    const video = videoRef.current;
    const sourceWidth = video?.videoWidth || viewWidth;
    const sourceHeight = video?.videoHeight || viewHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0 };
    const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
    const renderedWidth = sourceWidth * scale;
    const renderedHeight = sourceHeight * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left - offsetX) / renderedWidth)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top - offsetY) / renderedHeight)),
    };
  };

  const updateDraftZone = (point) => {
    const start = dragStartRef.current;
    if (!start) return;
    setDraftZone({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  };

  const finishZoneDrag = (event) => {
    if (!dragStartRef.current) return;
    const start = dragStartRef.current;
    const end = pointerToNormalized(event);
    const nextZone = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
    dragStartRef.current = null;
    setDraftZone(null);
    // Reject accidental clicks and tiny selections that would be hard to inspect or use reliably.
    if (nextZone.width >= 0.02 && nextZone.height >= 0.02) {
      onDetectionZoneChange(nextZone, editingZoneIndex);
      onEditingZoneChange(false);
    }
  };

  const cancelZoneEditing = () => {
    dragStartRef.current = null;
    setDraftZone(null);
    onEditingZoneChange(false);
  };

  return (
    <section className="camera-card" aria-label="Live camera feed">
      <div className="camera-toolbar">
        <div className="camera-name">
          <span className={`live-dot ${live ? "is-live" : ""}`} />
          <div><strong>CAM 01</strong><small>School zone camera</small></div>
        </div>
        <div className="camera-toolbar-right">
          <span className={`stream-badge ${live ? "stream-badge-live" : ""}`}>
            {live ? "STREAM LIVE" : offlineContent.badge}
          </span>
        </div>
      </div>

      <div className="camera-view" ref={cameraViewRef}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="camera-video"
          style={{ opacity: live ? 1 : 0 }}
          onLoadedMetadata={(event) => {
            const { videoWidth: width, videoHeight: height } = event.currentTarget;
            if (width > 0 && height > 0) setVideoSize({ width, height });
          }}
        />
        {live && (
          <svg
            className="camera-detection-overlay"
            viewBox={`0 0 ${viewWidth} ${viewHeight}`}
            preserveAspectRatio="xMidYMid meet"
            role={editingZone ? "application" : "img"}
            aria-label={editingZone ? "Drag on the camera image to draw the detection area" : `${detections.length} people detected`}
            style={{ pointerEvents: editingZone ? "auto" : "none", touchAction: editingZone ? "none" : "auto", cursor: editingZone ? "crosshair" : "default" }}
            onPointerDown={(event) => {
              if (!editingZone) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragStartRef.current = pointerToNormalized(event);
              setDraftZone({ ...dragStartRef.current, width: 0, height: 0 });
            }}
            onPointerMove={(event) => {
              if (editingZone && dragStartRef.current) updateDraftZone(pointerToNormalized(event));
            }}
            onPointerUp={finishZoneDrag}
            onPointerCancel={cancelZoneEditing}
          >
            {editingZone && <rect x="0" y="0" width={viewWidth} height={viewHeight} className="zone-editor-hit-area" />}
            {detections.map(({ box, confidence }, index) => {
              const [x1, y1, x2, y2] = box;
              return (
                <g key={`${index}-${box.join(",")}`}>
                  <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} />
                  <text x={x1 + 4} y={Math.max(18, y1 - 6)}>Person {Math.round(confidence)}%</text>
                </g>
              );
            })}
            {detectionZone.filter(Boolean).map((zone, index) => !draftZone && (
              <g className="detection-zone-shape" key={index}>
                <rect x={zone.x * viewWidth} y={zone.y * viewHeight} width={zone.width * viewWidth} height={zone.height * viewHeight} />
                <text x={zone.x * viewWidth + 8} y={zone.y * viewHeight + 22}>DETECTION AREA {index + 1}</text>
              </g>
            ))}
            {draftZone && (
              <rect className="detection-zone-draft" x={draftZone.x * viewWidth} y={draftZone.y * viewHeight} width={draftZone.width * viewWidth} height={draftZone.height * viewHeight} />
            )}
            {editingZone && <text className="zone-editor-instruction" x={viewWidth / 2} y={28} textAnchor="middle">Drag to draw the detection area</text>}
          </svg>
        )}
        <div className="view-vignette" />
        {live && <div className="view-grid" />}
        {!live && (
          <div className="camera-placeholder">
            <div className="placeholder-symbol"><Icon name={status === "error" ? "alert" : "camera"} size={25} /></div>
            <strong>{offlineContent.title}</strong>
            <p>{status === "error" ? error : offlineContent.detail}</p>
            <button className="primary-button" onClick={onStart}>Start camera</button>
          </div>
        )}
        {live && <div className="feed-overlay"><span><i />REC</span><span className="camera-fps">CAM {cameraFps || "—"} FPS</span><span>{clock.toLocaleTimeString([], { hour12: false })}</span></div>}
        {live && <button className="expand-button" title="Fullscreen" onClick={() => videoRef.current?.parentElement?.requestFullscreen?.()}><Icon name="expand" /></button>}
      </div>

      <div className="camera-controls">
        <div className="feed-meta">
          <span><i className={live ? "meta-green" : ""} />{live ? "Camera connected" : "No camera signal"}</span>
          <span className="meta-divider" />
          <span>{live ? (detectionZone.some(Boolean) ? `${detectionZone.filter(Boolean).length} detection area${detectionZone.filter(Boolean).length > 1 ? "s" : ""}` : "Detecting full frame") : "Awaiting video input"}</span>
        </div>
        <div className="feed-actions">
          {live && (
            <>
              <button className={`camera-action ${editingZone ? "camera-action-stop" : ""}`} onClick={() => editingZone ? cancelZoneEditing() : onEditDetectionZone(0)}>
                {editingZone ? "Cancel area" : detectionZone[0] ? "Edit area 1" : "Add detection area"}
              </button>
              {detectionZone[1] && !editingZone && <button className="camera-action" onClick={() => onEditDetectionZone(1)}>Edit area 2</button>}
              {detectionZone.filter(Boolean).length === 1 && !editingZone && <button className="camera-action" onClick={onAddDetectionZone}>Add second area</button>}
              {detectionZone.some(Boolean) && !editingZone && <button className="camera-action" onClick={onDetectionZoneReset}>Use full frame</button>}
            </>
          )}
          {cameras.length > 1 && (
            <select aria-label="Select camera" value={cameraId} onChange={(event) => onCameraChange(event.target.value)}>
              {cameras.map((camera, index) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}
            </select>
          )}
          <button className={`camera-action ${live ? "camera-action-stop" : ""}`} onClick={live ? onStop : onStart}>
            <span />{live ? "Stop feed" : "Start feed"}
          </button>
        </div>
      </div>
    </section>
  );
}
