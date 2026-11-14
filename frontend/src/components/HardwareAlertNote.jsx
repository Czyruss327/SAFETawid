// Explain the division between browser audio and the physical ESP32 alert outputs.
export default function HardwareAlertNote({ title = "Hardware alerts", message = "The ESP32 receives alert signals over Wi-Fi. Set its Wi-Fi and computer address on the device setup page; no firmware edits are needed for network changes." }) {
  return <div className="integration-note"><span className="note-mark">i</span><p><strong>{title}</strong><br />{message}</p></div>;
}
