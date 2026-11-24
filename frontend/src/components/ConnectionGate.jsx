import { useEffect, useState } from "react";
import Cam from "./Cam.jsx";

const ESP32_SETUP_URL = "http://192.168.4.1/";

export default function ConnectionGate() {
  const [setupNetworkDetected, setSetupNetworkDetected] = useState(false);
  const [unlocked, setUnlocked] = useState(() => {
    if (window.__SCHOOL_ZONE_DESKTOP__) return true;
    try { return window.localStorage.getItem("school-zone-setup-complete") === "true"; }
    catch { return false; }
  });

  useEffect(() => {
    if (window.__SCHOOL_ZONE_DESKTOP__ || unlocked) return undefined;
    let active = true;
    const checkSetupNetwork = async () => {
      try {
        // An opaque no-cors response is expected; it tells us the ESP32 portal
        // answered without requiring the portal to expose browser-readable data.
        await fetch(ESP32_SETUP_URL, { mode: "no-cors", cache: "no-store" });
        if (active) setSetupNetworkDetected(true);
      } catch {
        // Keep a detected portal available while the ESP32 restarts after saving credentials.
      }
    };
    checkSetupNetwork();
    const timer = window.setInterval(checkSetupNetwork, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [unlocked]);

  if (unlocked) return <Cam />;

  return (
    <main className="connection-gate">
      <section className="connection-gate-modal" role="dialog" aria-modal="true" aria-labelledby="connection-gate-title">
        <div className={`connection-gate-icon${setupNetworkDetected ? " is-connected" : ""}`} aria-hidden="true">
          <span />
        </div>
        <div className="section-kicker">SAFETAWID DEVICE SETUP</div>
        <h1 id="connection-gate-title">{setupNetworkDetected ? "Configure ESP32 Wi-Fi" : "ESP32 not connected"}</h1>
        <p role="status" aria-live="polite">
          {setupNetworkDetected
            ? "The ESP32 setup network is detected. Configure the Wi-Fi network used by this dashboard before continuing."
            : "Connect your computer or phone to the ESP32 setup Wi-Fi network to begin configuration."}
        </p>
        {!setupNetworkDetected ? (
          <div className="connection-gate-help">
            <strong>SAFETawid-Setup-…</strong>
            <span>Setup password: TawidSetup26</span>
            <small>This page checks for the ESP32 setup portal automatically.</small>
          </div>
        ) : (
          <div className="connection-gate-actions">
            <a className="primary-button" href={ESP32_SETUP_URL} target="_blank" rel="noreferrer">Configure Wi-Fi credentials</a>
            <button className="connection-gate-continue" type="button" onClick={() => {
              try { window.localStorage.setItem("school-zone-setup-complete", "true"); }
              catch { /* The dashboard can still be opened for this session. */ }
              setUnlocked(true);
            }}>I’ve configured Wi-Fi — continue</button>
          </div>
        )}
      </section>
    </main>
  );
}
