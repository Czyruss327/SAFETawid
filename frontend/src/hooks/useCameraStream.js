import { useCallback, useEffect, useRef, useState } from "react";

const errorMessages = {
  NotAllowedError: "Camera permission was denied. Allow access in your browser settings and retry.",
  NotFoundError: "No camera was found. Connect a camera and try again.",
  NotReadableError: "The camera is being used by another app.",
  OverconstrainedError: "That camera is no longer available. Choose another camera.",
};

/** Owns camera permission, stream lifecycle, device selection, and stale-request cancellation. */
export default function useCameraStream() {
  const cameraAvailable = Boolean(navigator.mediaDevices?.getUserMedia);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const requestId = useRef(0);
  const invalidatePending = useCallback(() => { requestId.current += 1; }, []);
  const [status, setStatus] = useState(() => cameraAvailable ? "starting" : "error");
  const [error, setError] = useState(() => cameraAvailable ? "" : "Camera access requires a recent browser on HTTPS or localhost.");
  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState("");

  const releaseStream = useCallback(() => {
    // Stop every media track before dropping the stream so the camera indicator turns off promptly.
    streamRef.current?.getTracks().forEach((track) => {
      try { track.stop(); } catch { /* Continue releasing remaining tracks if one browser track fails. */ }
    });
    streamRef.current = null;
    if (videoRef.current) {
      try { videoRef.current.srcObject = null; } catch { /* The media track has still been stopped. */ }
    }
  }, []);

  const start = useCallback(async (deviceId = "") => {
    // Ignore late getUserMedia/enumerateDevices results after a newer start or stop request.
    const currentRequest = ++requestId.current;
    releaseStream();
    setStatus("starting");
    setError("");

    try {
      // Prefer HD defaults; a user-selected device is requested exactly to avoid silent device changes.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      if (currentRequest !== requestId.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      const devices = await navigator.mediaDevices.enumerateDevices?.() ?? [];
      if (currentRequest !== requestId.current) return;
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("Camera stream did not include a video track.");
      setCameras(devices.filter((device) => device.kind === "videoinput"));
      setCameraId(videoTrack.getSettings().deviceId ?? "");
      setStatus("live");
    } catch (cameraError) {
      if (currentRequest !== requestId.current) return;
      releaseStream();
      setError(errorMessages[cameraError.name] ?? `Unable to start camera (${cameraError.name}).`);
      setStatus("error");
    }
  }, [releaseStream]);

  const stop = useCallback(() => {
    requestId.current++;
    releaseStream();
    setStatus("idle");
  }, [releaseStream]);

  useEffect(() => {
    if (!cameraAvailable) return undefined;
    let active = true;
    Promise.resolve().then(() => {
      if (active) void start("");
    });
    return () => {
      active = false;
      invalidatePending();
      releaseStream();
    };
  }, [cameraAvailable, start, releaseStream, invalidatePending]);

  return { videoRef, status, error, cameras, cameraId, setCameraId, start, stop };
}
