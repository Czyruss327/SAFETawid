# Physical ESP32-S3 alert controller

This firmware is for the physical ESP32-S3, green and red LEDs driven through transistors, and a passive piezo buzzer. The ESP32 uses Wi-Fi to poll FastAPI and supports wireless firmware updates after its initial USB flash. USB is not needed for normal use or serial monitoring. Power the board from USB-C or a suitable external 5 V supply.

## Wiring

Disconnect USB power before wiring.

| ESP32-S3 | Connection |
| --- | --- |
| GPIO 35 | Top pedestrian green |
| GPIO 36 | Top pedestrian red |
| GPIO 38 | Top vehicle red |
| GPIO 37 | Top vehicle green |
| GPIO 18 | Bottom vehicle red |
| GPIO 17 | Bottom vehicle green |
| GPIO 15 | Bottom pedestrian red |
| GPIO 14 | Bottom pedestrian green |
| GPIO 42 | Piezo positive (+) |
| GND | Piezo negative (−) |

At idle, both pedestrian signals are red and both vehicle signals are green. During an alert, both pedestrian signals turn green and both vehicle signals turn red; the piezo sounds intermittently for the configured **Alert output duration** in the dashboard settings. The dashboard's green **Stop** button ends a manual alert early and restores the idle phase. The firmware turns all green outputs off before changing phases to prevent conflicting green signals. Adjust `BUZZER_VOLUME_PERCENT` near the top of `src/main.cpp` from `0` (silent) to `100` (strongest PWM setting). The firmware expects a passive piezo. Use suitable current-limiting resistors or transistor drivers for the LEDs; do not power high-current loads directly from GPIO pins. Confirm your exact ESP32-S3 board exposes GPIO 42 and these other pins before wiring.

## Configure and run

You do not need to put Wi-Fi credentials or the backend address in PlatformIO or edit the firmware for each network. The firmware must be uploaded once to a new board, using USB. After that, power the ESP32 normally; it opens its own setup Wi-Fi page when it has no saved connection. Connect to the `SAFETawid-Setup-...` network with password `TawidSetup26`, then enter the Wi-Fi details and backend address on `http://192.168.4.1`. The ESP32 saves them internally. You do not need to keep a USB connection or serial monitor open during normal operation. Later firmware updates can be sent wirelessly while the ESP32 and computer are on the same network; the OTA upload password is the configured Wi-Fi password.

For an optional wireless firmware update, open PowerShell in the `hardware` folder, set `$env:SAFETAWID_OTA_PASSWORD` to the ESP32's Wi-Fi password, then run `pio run -e esp32-s3-ota -t upload`. The first firmware upload still has to use USB because the blank board has no OTA service yet.

1. In the desktop app's local data folder, open `desktop-config.json` and set `allowEsp32LanAccess` and `hardwareAlertsEnabled` to `true`. Keep the computer and ESP32 on the same trusted private Wi-Fi network. Restart the app after changing the file.
2. Start the desktop app and note the `ESP32 API listening on ...` address in its startup output. Find the computer's private LAN IPv4 address in Windows Network settings. Combine it with the API port, for example `http://192.168.1.20:8000`.
3. On first power-up, connect a phone or computer to the Wi-Fi network named `SAFETawid-Setup-...` using password `TawidSetup26`. Open `http://192.168.4.1`, enter the site's Wi-Fi name/password and the computer API address, then save. The ESP32 stores these settings and restarts.
4. To change saved settings later, hold the ESP32 board's **BOOT** button for 3 seconds while it is running. Connect again to its `SAFETawid-Setup-...` network with password `TawidSetup26` and submit the updated values.
5. At idle, the pedestrian signals show red and the vehicle signals show green. Use the dashboard's red **Trigger** and green **Stop** buttons to switch and restore the crossing phase. The ESP32 polls the backend over Wi-Fi.

If you run FastAPI directly instead of through the desktop app, enable hardware alerts and make it reachable on the trusted LAN:

   ```powershell
   cd backend
   $env:HARDWARE_ALERT_ENABLED = "1"
   uvicorn main:app --host 0.0.0.0 --port 8000
   ```

Check the serial monitor for `Wi-Fi connected` and `Backend API connected.` The disconnect reason code is printed when Wi-Fi drops.

Allow port 8000 through the computer's firewall for the private network. Keep the backend on a trusted local network; do not expose port 8000 directly to the public internet.
