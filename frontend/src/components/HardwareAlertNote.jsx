import { useEffect, useState } from "react";
import { apiUrl } from "../api.js";

export default function HardwareAlertNote() {
  const [hardware, setHardware] = useState(null);

  useEffect(() => {
    let active = true;
    const refresh = () => fetch(apiUrl("/api/hardware-alert"))
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("status unavailable")))
      .then((data) => { if (active) setHardware(data); })
      .catch(() => { if (active) setHardware(null); });
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const message = !hardware
    ? "Could not read hardware status from the detection service."
    : !hardware.enabled
      ? "Hardware alerts are disabled. Enable allowEsp32LanAccess and hardwareAlertsEnabled in desktop-config.json, then restart the app."
      : hardware.hardware_connected
        ? "ESP32 connected. Detection alerts are delivered to the dashboard and ESP32 together."
        : "Hardware alerts are enabled, but the ESP32 has not checked in recently. Verify its Wi-Fi connection and mDNS discovery.";

  return <div className="integration-note"><span className="note-mark">i</span><p><strong>Hardware alerts{hardware?.hardware_connected ? " · connected" : ""}</strong><br />{message}<br />On first setup, enter the Wi-Fi credentials on the ESP32 setup page; it discovers the desktop API automatically. The ESP32 polls every 100 ms.</p></div>;
}
