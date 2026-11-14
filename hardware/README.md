# Physical ESP32-S3 alert controller

This firmware is for the physical ESP32-S3, green and red LEDs driven through transistors, and a passive piezo buzzer. USB-C powers and programs the board and provides serial logs. The ESP32 uses Wi-Fi to poll FastAPI; USB does not carry alert requests.

## Wiring

Disconnect USB power before wiring.

| ESP32-S3 | Connection |
| --- | --- |
| GPIO 17 | Green LED transistor control input |
| GPIO 18 | Red LED transistor control input |
| GPIO 36 | Piezo positive (+) |
| GND | Piezo negative (−) |

The green LED indicates the board can reach the backend. During an alert, green turns off while red flashes and the piezo sounds for five seconds. Adjust `BUZZER_VOLUME_PERCENT` near the top of `src/main.cpp` from `0` (silent) to `100` (strongest PWM setting), then upload again. Perceived loudness may not change linearly with the number. The firmware expects a passive piezo. The LED transistors should be wired as drivers with a shared ground; do not power the LEDs directly from the GPIO pins. Some ESP32-S3 board variants reserve GPIO 36 for flash or PSRAM. If yours does, choose a free GPIO and change `BUZZER_PIN` in `src/main.cpp` to match.

## Configure and run

Wi-Fi details and the computer API address are saved on the ESP32, outside the firmware source. You only need to upload firmware again if you change the wiring or firmware itself.

1. In the desktop app's local data folder, open `desktop-config.json` and set `allowEsp32LanAccess` and `hardwareAlertsEnabled` to `true`. Keep the computer and ESP32 on the same trusted private Wi-Fi network. Restart the app after changing the file.
2. Start the desktop app and note the `ESP32 API listening on ...` address in its startup output. Find the computer's private LAN IPv4 address in Windows Network settings. Combine it with the API port, for example `http://192.168.1.20:8000`.
3. On first power-up, connect a phone or computer to the Wi-Fi network named `SAFETawid-Setup-...`. The setup password and address `http://192.168.4.1` are printed to the USB serial monitor at 115200 baud. Enter the site's Wi-Fi name/password and the computer API address, then save. The ESP32 stores these settings and restarts.
4. To change saved settings later, hold the ESP32 board's **BOOT** button for 3 seconds while it is running. Connect again to its `SAFETawid-Setup-...` network and submit the updated values. The password is shown in the USB serial monitor.
5. The green LED turns on after the ESP32 can reach the backend. Start the camera/dashboard; alerts then trigger the red LED and buzzer. USB is still used for power, firmware upload, and setup logs; alert requests continue over Wi-Fi.

If you run FastAPI directly instead of through the desktop app, enable hardware alerts and make it reachable on the trusted LAN:

   ```powershell
   cd backend
   $env:HARDWARE_ALERT_ENABLED = "1"
   uvicorn main:app --host 0.0.0.0 --port 8000
   ```

Check the serial monitor for `Wi-Fi connected` and `Backend API connected.` The disconnect reason code is printed when Wi-Fi drops.

Allow port 8000 through the computer's firewall for the private network. Keep the backend on a trusted local network; do not expose port 8000 directly to the public internet.
