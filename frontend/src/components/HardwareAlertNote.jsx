import { useEffect, useState } from "react";
import { apiUrl } from "../api.js";

export default function HardwareAlertNote() {
  const [hardware, setHardware] = useState(null);
  const [setupNetworkDetected, setSetupNetworkDetected] = useState(false);

  useEffect(() => {
    let active = true;
    const checkSetupNetwork = async () => {
      try {
        await fetch("http://192.168.4.1/", { mode: "no-cors", cache: "no-store" });
        if (active) setSetupNetworkDetected(true);
      } catch {
        if (active) setSetupNetworkDetected(false);
      }
    };
    checkSetupNetwork();
    const setupTimer = window.setInterval(checkSetupNetwork, 2500);
    const refresh = () => fetch(apiUrl("/api/hardware-alert"))
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("status unavailable")))
      .then((data) => { if (active) setHardware(data); })
      .catch(() => { if (active) setHardware(null); });
    refresh();
    const hardwareTimer = window.setInterval(refresh, 2000);
    return () => {
      active = false;
      window.clearInterval(setupTimer);
      window.clearInterval(hardwareTimer);
    };
  }, []);

  const message = !hardware
    ? "Could not read hardware status from the detection service."
    : !hardware.enabled
      ? "Hardware alerts are disabled. Enable allowEsp32LanAccess and hardwareAlertsEnabled in desktop-config.json, then restart the app."
      : hardware.hardware_connected
        ? "ESP32 connected. Detection alerts are delivered to the dashboard and ESP32 together."
        : "Hardware alerts are enabled, but the ESP32 has not checked in recently. Verify its Wi-Fi connection and mDNS discovery.";

  return <>
    <section className={`device-setup-status${setupNetworkDetected ? " is-detected" : ""}`} aria-live="polite">
      <span className="device-setup-status-dot" aria-hidden="true" />
      <div>
        <strong>{setupNetworkDetected ? "ESP32 setup network detected" : "ESP32 setup network not detected"}</strong>
        <p>{setupNetworkDetected
          ? "The ESP32 setup portal is reachable. Configure the Wi-Fi network used by this dashboard."
          : "To configure a new device, connect this computer or phone to the ESP32 setup Wi-Fi network (SAFETawid-Setup-…)."}</p>
        {setupNetworkDetected && <a className="primary-button" href="http://192.168.4.1/" target="_blank" rel="noreferrer">Configure Wi-Fi credentials</a>}
        {!setupNetworkDetected && <small>Setup password: TawidSetup26 · This status checks the temporary setup network.</small>}
      </div>
    </section>
    <div className="integration-note"><span className="note-mark">i</span><p><strong>Hardware alerts{hardware?.hardware_connected ? " · connected" : ""}</strong><br />{message}<br />Once configured, the ESP32 discovers the desktop API automatically and polls it every 100 ms.</p></div>
  </>;
}
