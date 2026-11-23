#include <Arduino.h>
#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

namespace {
constexpr char CONFIG_AP_PREFIX[] = "SAFETawid-Setup-";
constexpr char CONFIG_AP_PASSWORD[] = "TawidSetup26";
constexpr uint8_t CONFIG_BUTTON_PIN = 0;  // Hold the board's BOOT button for 3 seconds to reconfigure.

constexpr uint8_t PEDESTRIAN_TOP_GREEN_PIN = 35;
constexpr uint8_t PEDESTRIAN_TOP_RED_PIN = 36;
constexpr uint8_t VEHICLE_TOP_RED_PIN = 38;
constexpr uint8_t VEHICLE_TOP_GREEN_PIN = 37;
constexpr uint8_t VEHICLE_BOTTOM_RED_PIN = 18;
constexpr uint8_t VEHICLE_BOTTOM_GREEN_PIN = 17;
constexpr uint8_t PEDESTRIAN_BOTTOM_RED_PIN = 15;
constexpr uint8_t PEDESTRIAN_BOTTOM_GREEN_PIN = 16;
constexpr uint8_t BUZZER_PIN = 42;
constexpr uint16_t BUZZER_TONE_HZ = 8000;
// PWM duty cycle percent: 0 is silent; increase toward 100 for a stronger tone.
constexpr uint8_t BUZZER_VOLUME_PERCENT = 100;
constexpr uint8_t BUZZER_PWM_BITS = 8;
constexpr uint16_t BUZZER_PWM_MAX_DUTY = (1U << BUZZER_PWM_BITS) - 1;
static_assert(BUZZER_VOLUME_PERCENT <= 100, "Buzzer volume must be between 0 and 100 percent.");
constexpr uint32_t BACKEND_POLL_MS = 100;
constexpr uint32_t WIFI_RETRY_MS = 10000;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 30000;
constexpr uint32_t BACKEND_DISCOVERY_RETRY_MS = 10000;
constexpr uint32_t FINAL_FAST_PHASE_MS = 3000;
constexpr uint32_t SIGNAL_BLINK_STEP_MS = 125;
constexpr uint32_t NORMAL_BEEP_INTERVAL_MS = 1000;
constexpr uint32_t BEEP_PULSE_MS = 100;

bool alertActive = false;
bool backendAlert = false;
bool wasConnected = false;
bool backendReachable = false;
bool wifiAttemptInProgress = false;
bool otaStarted = false;
bool mdnsStarted = false;
bool configPortalActive = false;
bool backendDiscoveryAttempted = false;
bool pedestrianPhaseActive = false;
bool trafficPhaseInitialized = false;
bool phaseLampsVisible = true;
bool buzzerPulseActive = false;
bool fastBlinkModeActive = false;
int lastBackendFailureStatus = 0;
uint32_t alertStartedAt = 0;
uint32_t alertDurationMs = 12000;
uint32_t lastSignalBlinkAt = 0;
uint32_t lastBuzzerBeepAt = 0;
uint32_t buzzerPulseEndsAt = 0;
uint32_t lastBackendPollAt = 0;
uint32_t lastWiFiAttemptAt = 0;
uint32_t lastBackendDiscoveryAt = 0;
uint32_t configButtonPressedAt = 0;
String wifiSsid;
String wifiPassword;
String backendApiUrl;
String configApPassword;
Preferences preferences;
WebServer configServer(80);

void setBuzzer(bool enabled) {
  const uint32_t duty = enabled
      ? (static_cast<uint32_t>(BUZZER_PWM_MAX_DUTY) * BUZZER_VOLUME_PERCENT + 50) / 100
      : 0;
  ledcWrite(BUZZER_PIN, duty);
}

void setPhaseLampsVisible(bool visible) {
  phaseLampsVisible = visible;
  digitalWrite(PEDESTRIAN_TOP_GREEN_PIN, visible && pedestrianPhaseActive ? HIGH : LOW);
  digitalWrite(PEDESTRIAN_BOTTOM_GREEN_PIN, visible && pedestrianPhaseActive ? HIGH : LOW);
  digitalWrite(PEDESTRIAN_TOP_RED_PIN, visible && !pedestrianPhaseActive ? HIGH : LOW);
  digitalWrite(PEDESTRIAN_BOTTOM_RED_PIN, visible && !pedestrianPhaseActive ? HIGH : LOW);
  digitalWrite(VEHICLE_TOP_RED_PIN, visible && pedestrianPhaseActive ? HIGH : LOW);
  digitalWrite(VEHICLE_BOTTOM_RED_PIN, visible && pedestrianPhaseActive ? HIGH : LOW);
  digitalWrite(VEHICLE_TOP_GREEN_PIN, visible && !pedestrianPhaseActive ? HIGH : LOW);
  digitalWrite(VEHICLE_BOTTOM_GREEN_PIN, visible && !pedestrianPhaseActive ? HIGH : LOW);
}

void setTrafficPhase(bool pedestriansMayCross) {
  if (trafficPhaseInitialized && pedestrianPhaseActive == pedestriansMayCross) {
    setPhaseLampsVisible(true);
    return;
  }

  // Break before make: extinguish every green before changing red lamps or enabling the other phase.
  digitalWrite(PEDESTRIAN_TOP_GREEN_PIN, LOW);
  digitalWrite(PEDESTRIAN_BOTTOM_GREEN_PIN, LOW);
  digitalWrite(VEHICLE_TOP_GREEN_PIN, LOW);
  digitalWrite(VEHICLE_BOTTOM_GREEN_PIN, LOW);

  pedestrianPhaseActive = pedestriansMayCross;
  trafficPhaseInitialized = true;
  setPhaseLampsVisible(true);
}

String apiUrl(const char *path) {
  return backendApiUrl + path;
}

void startConfigPortal() {
  if (configPortalActive) return;
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(false);
  const String suffix = WiFi.macAddress().substring(9, 17);
  const String apName = String(CONFIG_AP_PREFIX) + suffix;
  configApPassword = CONFIG_AP_PASSWORD;
  if (!WiFi.softAP(apName.c_str(), configApPassword.c_str())) {
    Serial.println("Could not start the Wi-Fi setup network.");
    return;
  }
  configServer.on("/", HTTP_GET, []() {
  const String html = F("<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>SAFETawid setup</title><style>body{font:16px system-ui;max-width:480px;margin:40px auto;padding:0 18px}input{box-sizing:border-box;width:100%;padding:10px;margin:6px 0 16px}button{padding:12px 18px;background:#087a59;color:white;border:0;border-radius:6px}</style></head><body><h1>SAFETawid hardware setup</h1><p>Enter the Wi-Fi network used by the computer running the dashboard. The ESP32 will find the SAFETawid API automatically on that network.</p><form method='post' action='/save'><label>Wi-Fi name</label><input name='ssid' required maxlength='32'><label>Wi-Fi password</label><input name='password' type='password' maxlength='64'><button type='submit'>Save and connect</button></form></body></html>");
    configServer.send(200, "text/html; charset=utf-8", html);
  });
  configServer.on("/save", HTTP_POST, []() {
    String ssid = configServer.arg("ssid");
    String password = configServer.arg("password");
    if (ssid.isEmpty()) {
      configServer.send(400, "text/plain; charset=utf-8", "Enter a Wi-Fi name.");
      return;
    }
    preferences.begin("safetawid", false);
    preferences.putString("ssid", ssid);
    preferences.putString("password", password);
    preferences.remove("backend");
    preferences.end();
    configServer.send(200, "text/html; charset=utf-8", "<!doctype html><meta name='viewport' content='width=device-width'><h2>Settings saved</h2><p>The device is restarting and will connect to Wi-Fi.</p>");
    delay(1200);
    ESP.restart();
  });
  configServer.onNotFound([]() { configServer.sendHeader("Location", "/"); configServer.send(302, "text/plain", ""); });
  configServer.begin();
  configPortalActive = true;
  Serial.printf("Setup Wi-Fi: %s\nSetup password: %s\nOpen: http://192.168.4.1\n", apName.c_str(), configApPassword.c_str());
}

void handleConfigButton() {
  if (digitalRead(CONFIG_BUTTON_PIN) == LOW) {
    if (configButtonPressedAt == 0) configButtonPressedAt = millis();
    else if (millis() - configButtonPressedAt >= 3000) {
      configButtonPressedAt = UINT32_MAX;
      Serial.println("Starting Wi-Fi setup portal.");
      startConfigPortal();
    }
  } else {
    configButtonPressedAt = 0;
  }
}

void logWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    Serial.printf("Wi-Fi disconnected; reason code: %u\n",
                  static_cast<unsigned>(info.wifi_sta_disconnected.reason));
  } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    Serial.printf("Wi-Fi connected; ESP32 IP: %s; signal: %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  Serial.printf("Connecting to Wi-Fi: %s\n", wifiSsid.c_str());
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  lastWiFiAttemptAt = millis();
  wifiAttemptInProgress = true;
}

void startOtaService() {
  if (otaStarted || WiFi.status() != WL_CONNECTED) return;
  ArduinoOTA.setHostname("safetawid-esp32");
  // Reuse the configured Wi-Fi secret to protect firmware uploads without another setup field.
  if (!wifiPassword.isEmpty()) ArduinoOTA.setPassword(wifiPassword.c_str());
  ArduinoOTA.onStart([]() { Serial.println("Wireless firmware update started."); });
  ArduinoOTA.onEnd([]() { Serial.println("Wireless firmware update complete; restarting."); });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("Wireless firmware update failed (%u).\n", static_cast<unsigned>(error));
  });
  ArduinoOTA.begin();
  otaStarted = true;
  Serial.printf("Wireless firmware updates available at %s.local\n", "safetawid-esp32");
}

void beginAlert(uint32_t durationMs) {
  if (alertActive) return;
  alertActive = true;
  backendAlert = true;
  alertStartedAt = millis();
  alertDurationMs = max<uint32_t>(1, durationMs);
  lastSignalBlinkAt = alertStartedAt;
  lastBuzzerBeepAt = alertStartedAt;
  buzzerPulseActive = true;
  fastBlinkModeActive = false;
  buzzerPulseEndsAt = alertStartedAt + BEEP_PULSE_MS;
  setTrafficPhase(true);
  setBuzzer(true);
  Serial.printf("Backend alert received; pedestrian green and buzzer for %lu ms.\n",
                static_cast<unsigned long>(alertDurationMs));
}

void stopAlert() {
  alertActive = false;
  backendAlert = false;
  buzzerPulseActive = false;
  fastBlinkModeActive = false;
  setBuzzer(false);
  setTrafficPhase(false);
  Serial.println("Alert sequence finished");
}

void handleBackendAlertInactive() {
  if (!alertActive || !backendAlert) return;
  stopAlert();
}

void acknowledgeBackendAlert() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.setTimeout(1500);
  if (http.begin(apiUrl("/api/hardware-alert/finished"))) {
    const int status = http.POST("");
    Serial.printf("Backend alert acknowledgement: HTTP %d\n", status);
    http.end();
  }
}

void pollBackend() {
  const uint32_t now = millis();
  if (now - lastBackendPollAt < BACKEND_POLL_MS || WiFi.status() != WL_CONNECTED) return;
  lastBackendPollAt = now;

  HTTPClient http;
  http.setTimeout(1500);
  if (!http.begin(apiUrl("/api/hardware-alert"))) return;
  http.addHeader("X-Hardware-Client", "safetawid-esp32");
  const int status = http.GET();
  if (status == HTTP_CODE_OK) {
    if (!backendReachable) Serial.println("Backend API connected.");
    backendReachable = true;
    lastBackendFailureStatus = 0;
    const String body = http.getString();
    const bool activeOnServer = body.indexOf("\"active\":true") >= 0;
    if (activeOnServer && !alertActive) {
      const int outputRemainingKey = body.indexOf("\"output_remaining_ms\":");
      uint32_t outputDurationMs = 12000;
      if (outputRemainingKey >= 0) {
        const int valueStart = outputRemainingKey + static_cast<int>(sizeof("\"output_remaining_ms\":") - 1);
        outputDurationMs = static_cast<uint32_t>(body.substring(valueStart).toInt());
      } else {
        // Compatibility with an older backend that reports only the configured duration.
        const int durationKey = body.indexOf("\"duration_ms\":");
        if (durationKey >= 0) {
          const int valueStart = durationKey + static_cast<int>(sizeof("\"duration_ms\":") - 1);
          outputDurationMs = static_cast<uint32_t>(body.substring(valueStart).toInt());
        } else {
          const int remainingKey = body.indexOf("\"remaining_ms\":");
          if (remainingKey >= 0) {
            const int valueStart = remainingKey + static_cast<int>(sizeof("\"remaining_ms\":") - 1);
            outputDurationMs = static_cast<uint32_t>(body.substring(valueStart).toInt());
          }
        }
      }
      if (outputDurationMs > 0) {
        beginAlert(outputDurationMs);
      } else {
        Serial.println("Hardware alert output interval already elapsed; acknowledging stale alert.");
        acknowledgeBackendAlert();
      }
    }
    if (!activeOnServer) handleBackendAlertInactive();
  } else if (status < 0) {
    backendReachable = false;
    if (lastBackendFailureStatus != status) {
      Serial.printf("Backend poll failed for %s: %s\n", backendApiUrl.c_str(),
                    http.errorToString(status).c_str());
      lastBackendFailureStatus = status;
    }
  } else {
    backendReachable = false;
    if (lastBackendFailureStatus != status) {
      Serial.printf("Backend poll returned HTTP %d\n", status);
      lastBackendFailureStatus = status;
    }
  }
  http.end();
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiAttemptInProgress = false;
    if (!wasConnected) {
      wasConnected = true;
      backendReachable = false;
    }
    startOtaService();
    return;
  }
  if (wasConnected) {
    wasConnected = false;
    backendReachable = false;
    otaStarted = false;
    Serial.println("Wi-Fi disconnected; reconnecting...");
    if (mdnsStarted) MDNS.end();
    mdnsStarted = false;
    backendDiscoveryAttempted = false;
    backendApiUrl = "";
  }

  const uint32_t now = millis();
  if (wifiAttemptInProgress) {
    if (now - lastWiFiAttemptAt < WIFI_CONNECT_TIMEOUT_MS) return;
    Serial.println("Wi-Fi connection timed out; resetting before retrying.");
    WiFi.disconnect(false, false);
    wifiAttemptInProgress = false;
    lastWiFiAttemptAt = now;
    return;
  }
  if (now - lastWiFiAttemptAt < WIFI_RETRY_MS) return;
  connectWiFi();
}

void updateOutputs() {
  const uint32_t now = millis();
  if (!alertActive) {
    setTrafficPhase(false);
    setBuzzer(false);
    return;
  }

  const uint32_t elapsed = now - alertStartedAt;
  const uint32_t fastPhaseDuration = min<uint32_t>(FINAL_FAST_PHASE_MS, alertDurationMs);
  const uint32_t fastPhaseStartsAt = alertDurationMs - fastPhaseDuration;
  const bool fastPhase = elapsed >= fastPhaseStartsAt;
  if (elapsed >= alertDurationMs) {
    const bool shouldAcknowledge = backendAlert;
    stopAlert();
    if (shouldAcknowledge) acknowledgeBackendAlert();
    return;
  }

  if (fastPhase) {
    if (!fastBlinkModeActive) {
      fastBlinkModeActive = true;
      lastSignalBlinkAt = now;
      if (!phaseLampsVisible) setPhaseLampsVisible(true);
      lastBuzzerBeepAt = now;
      buzzerPulseActive = true;
      buzzerPulseEndsAt = now + BEEP_PULSE_MS;
      setBuzzer(true);
    }
    if (now - lastSignalBlinkAt >= SIGNAL_BLINK_STEP_MS) {
      lastSignalBlinkAt = now;
      setPhaseLampsVisible(!phaseLampsVisible);
      if (phaseLampsVisible) {
        lastBuzzerBeepAt = now;
        buzzerPulseActive = true;
        buzzerPulseEndsAt = now + BEEP_PULSE_MS;
        setBuzzer(true);
      } else {
        buzzerPulseActive = false;
        setBuzzer(false);
      }
    } else if (buzzerPulseActive && static_cast<int32_t>(now - buzzerPulseEndsAt) >= 0) {
      buzzerPulseActive = false;
      setBuzzer(false);
    }
  } else if (now - lastBuzzerBeepAt >= NORMAL_BEEP_INTERVAL_MS) {
    lastBuzzerBeepAt = now;
    buzzerPulseActive = true;
    buzzerPulseEndsAt = now + BEEP_PULSE_MS;
    setBuzzer(true);
  } else if (buzzerPulseActive && static_cast<int32_t>(now - buzzerPulseEndsAt) >= 0) {
    buzzerPulseActive = false;
    setBuzzer(false);
  }
}

void discoverBackend() {
  if (WiFi.status() != WL_CONNECTED) return;
  const uint32_t now = millis();
  if (backendDiscoveryAttempted && now - lastBackendDiscoveryAt < BACKEND_DISCOVERY_RETRY_MS) return;
  lastBackendDiscoveryAt = now;
  backendDiscoveryAttempted = true;
  if (!mdnsStarted) {
    mdnsStarted = MDNS.begin("safetawid-esp32");
    if (!mdnsStarted) {
      Serial.println("Could not start mDNS discovery.");
      return;
    }
  }
  const int services = MDNS.queryService("safetawid", "tcp");
  if (services <= 0) {
    if (backendApiUrl.isEmpty()) Serial.println("SAFETawid API not found yet; retrying discovery.");
    return;
  }
  for (int i = 0; i < services; ++i) {
    const IPAddress address = MDNS.address(i);
    const uint16_t port = MDNS.port(i);
    if (address == IPAddress(0, 0, 0, 0) || port == 0) continue;
    backendApiUrl = "http://" + address.toString() + ":" + String(port);
    Serial.printf("Discovered SAFETawid API at %s\n", backendApiUrl.c_str());
    backendReachable = false;
    lastBackendPollAt = 0;
    return;
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(CONFIG_BUTTON_PIN, INPUT_PULLUP);
  pinMode(PEDESTRIAN_TOP_GREEN_PIN, OUTPUT);
  pinMode(PEDESTRIAN_TOP_RED_PIN, OUTPUT);
  pinMode(VEHICLE_TOP_RED_PIN, OUTPUT);
  pinMode(VEHICLE_TOP_GREEN_PIN, OUTPUT);
  pinMode(VEHICLE_BOTTOM_RED_PIN, OUTPUT);
  pinMode(VEHICLE_BOTTOM_GREEN_PIN, OUTPUT);
  pinMode(PEDESTRIAN_BOTTOM_RED_PIN, OUTPUT);
  pinMode(PEDESTRIAN_BOTTOM_GREEN_PIN, OUTPUT);
  if (!ledcAttach(BUZZER_PIN, BUZZER_TONE_HZ, BUZZER_PWM_BITS)) {
    Serial.println("Could not initialize the buzzer PWM output.");
  }
  setTrafficPhase(false);
  setBuzzer(false);
  WiFi.onEvent(logWiFiEvent);
  preferences.begin("safetawid", true);
  wifiSsid = preferences.getString("ssid", "");
  wifiPassword = preferences.getString("password", "");
  preferences.end();
  Serial.println("SAFETawid hardware alert controller starting.");
  if (wifiSsid.isEmpty()) startConfigPortal();
  else connectWiFi();
}

void loop() {
  if (configPortalActive) {
    configServer.handleClient();
    delay(5);
    return;
  }
  handleConfigButton();
  maintainWiFi();
  discoverBackend();
  if (otaStarted) ArduinoOTA.handle();
  pollBackend();
  updateOutputs();
  delay(10);
}
