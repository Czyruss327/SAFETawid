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
| GPIO 16 | Bottom pedestrian green |
| GPIO 15 | Bottom pedestrian red |
| GPIO 42 | Piezo positive (+) |
| GPIO 0 (BOOT) | Optional external momentary, normally-open button to GND |
| GND | Piezo negative (−) |

At idle, GPIO 36 and 15 show pedestrian red while GPIO 37 and 17 show motorist green. When the dashboard's detection alert fires, pedestrian green (GPIO 35 and 16), motorist red (GPIO 38 and 17), dashboard sound, and the buzzer start together. The configurable **Pedestrian green + alert duration** controls how long both pedestrian green and buzzer are active. The buzzer gives a short beep every 500 ms through the alert; during its final 3 seconds the pedestrian green and motorist red blink faster and the buzzer beeps faster. At the end, buzzer and pedestrian green stop together and the motorist green/pedestrian red phase resumes. In manual mode, the dashboard's **Start alert / Stop alert** button keeps the alert active until stopped. A configurable cooldown prevents another detection alert until the selected delay passes. The firmware turns all green outputs off before changing phases to prevent conflicting green signals. Adjust `BUZZER_VOLUME_PERCENT` near the top of `src/main.cpp` from `0` (silent) to `100` (strongest PWM setting). The firmware expects a passive piezo. Use suitable current-limiting resistors or transistor drivers for the LEDs; do not power high-current loads directly from GPIO pins. Confirm your exact ESP32-S3 board exposes GPIO 42 and these other pins before wiring.

### External BOOT button

To access BOOT without reaching the module button, connect a momentary, normally-open pushbutton between **GPIO 0** and **GND**. It can be wired in parallel with the board's built-in BOOT button. Do not connect GPIO 0 to 3.3 V. The firmware configures GPIO 0 with an internal pull-up, so the button pulls it low only while pressed.

For USB firmware upload or recovery, hold the external button while resetting or powering on the board, then release it once the serial bootloader is ready. This makes GPIO 0 low during reset, which selects the ROM download bootloader. Start the upload from PlatformIO. Exact reset/BOOT timing can vary by board; if it does not connect, hold BOOT, tap RESET/EN, then release BOOT. This button does not make uploads wireless; normal updates can use OTA as described below.

While the application is running, a 3-second press on GPIO 0 still opens the Wi-Fi setup portal, matching the built-in BOOT button behavior. A short press alone does not enter the bootloader; GPIO 0 must be held low during reset for that.

## Configure and run

You do not need to put Wi-Fi credentials or a backend address in PlatformIO. The firmware must be uploaded once to a new board over USB. On first power-up it opens a setup Wi-Fi page. Connect to the `SAFETawid-Setup-...` network (password `TawidSetup26`) and enter the site's Wi-Fi name and password at `http://192.168.4.1`. The ESP32 saves those credentials, joins the network, and discovers the desktop API automatically over mDNS; no computer IP or API port is entered. You do not need USB or a serial monitor during normal operation. Later firmware updates can be sent wirelessly while the ESP32 and computer are on the same network; the OTA upload password is the configured Wi-Fi password.

For an optional wireless firmware update, open PowerShell in the `hardware` folder, set `$env:SAFETAWID_OTA_PASSWORD` to the ESP32's Wi-Fi password, then run `pio run -e esp32-s3-ota -t upload`. The first firmware upload still has to use USB because the blank board has no OTA service yet.

1. Run `npm run backend:setup` so the Python environment installs the mDNS advertiser dependency.
2. In the desktop app's local data folder, set `allowEsp32LanAccess` and `hardwareAlertsEnabled` to `true` in `desktop-config.json`, then restart the app. Keep the computer and ESP32 on the same trusted private Wi-Fi network. Permit the API's TCP port and mDNS multicast (UDP 5353) on the Windows **Private** network profile if Windows Firewall asks. The dashboard's **Device setup** panel shows whether the ESP32 has checked in recently.
3. On first power-up, connect a phone or computer to `SAFETawid-Setup-...` (password `TawidSetup26`), open `http://192.168.4.1`, enter the site's Wi-Fi name and password, and save. The ESP32 restarts, joins that Wi-Fi, discovers the SAFETawid API automatically, and begins polling it.
4. On later power-ups, the ESP32 reconnects using its saved Wi-Fi credentials and rediscovers the API without setup or a BOOT-button press. To change Wi-Fi credentials, hold BOOT for 3 seconds while running and use the setup page again.
5. At idle, pedestrians show red and vehicles show green. The ESP32 polls the backend for automatic detection alerts; dashboard **Trigger** and **Stop** buttons remain available for manual control.

Automatic discovery requires mDNS multicast between the ESP32 and computer. They must be on the same LAN, and the Wi-Fi must not use guest/client isolation. If discovery fails, check the Windows private-network firewall rules and router multicast settings. The ESP32 retries discovery every 10 seconds.

If you run FastAPI directly instead of through the desktop app, enable hardware alerts and make it reachable on the trusted LAN:

   ```powershell
   cd backend
   $env:HARDWARE_ALERT_ENABLED = "1"
   $env:ESP32_DISCOVERY_ENABLED = "1"
   $env:ESP32_DISCOVERY_PORT = "8000"
   uvicorn main:app --host 0.0.0.0 --port 8000
   ```

Check the serial monitor for `Wi-Fi connected` and `Backend API connected.` The disconnect reason code is printed when Wi-Fi drops.

Allow port 8000 through the computer's firewall for the private network. Keep the backend on a trusted local network; do not expose port 8000 directly to the public internet.
