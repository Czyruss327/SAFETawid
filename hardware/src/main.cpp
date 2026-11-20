#include <Arduino.h>
#include <ArduinoOTA.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

namespace {
constexpr char CONFIG_AP_PREFIX[] = "SAFETawid-Setup-";
constexpr char CONFIG_AP_PASSWORD[] = "TawidSetup26";
constexpr uint8_t CONFIG_BUTTON_PIN = 0;  // Hold the board's BOOT button for 3 seconds to reconfigure.

constexpr uint8_t PEDESTRIAN_TOP_GREEN_PIN = 36;
constexpr uint8_t PEDESTRIAN_TOP_RED_PIN = 35;
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
constexpr uint32_t OUTPUT_STEP_MS = 250;
constexpr uint32_t BACKEND_POLL_MS = 500;
constexpr uint32_t WIFI_RETRY_MS = 10000;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 30000;

bool alertActive = false;
bool backendAlert = false;
bool outputOn = false;
bool wasConnected = false;
bool backendReachable = false;
bool wifiAttemptInProgress = false;
bool otaStarted = false;
bool configPortalActive = false;
bool pedestrianPhaseActive = false;
bool trafficPhaseInitialized = false;
int lastBackendFailureStatus = 0;
uint32_t alertStartedAt = 0;
uint32_t alertDurationMs = 12000;
uint32_t lastOutputStepAt = 0;
uint32_t lastBackendPollAt = 0;
uint32_t lastWiFiAttemptAt = 0;
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

void setTrafficPhase(bool pedestriansMayCross) {
  if (trafficPhaseInitialized && pedestrianPhaseActive == pedestriansMayCross) return;

  // Break before make: extinguish every green before changing red lamps or enabling the other phase.
  digitalWrite(PEDESTRIAN_TOP_GREEN_PIN, LOW);
  digitalWrite(PEDESTRIAN_BOTTOM_GREEN_PIN, LOW);
  digitalWrite(VEHICLE_TOP_GREEN_PIN, LOW);
  digitalWrite(VEHICLE_BOTTOM_GREEN_PIN, LOW);

  digitalWrite(PEDESTRIAN_TOP_RED_PIN, pedestriansMayCross ? LOW : HIGH);
  digitalWrite(PEDESTRIAN_BOTTOM_RED_PIN, pedestriansMayCross ? LOW : HIGH);
  digitalWrite(VEHICLE_TOP_RED_PIN, pedestriansMayCross ? HIGH : LOW);
  digitalWrite(VEHICLE_BOTTOM_RED_PIN, pedestriansMayCross ? HIGH : LOW);

  if (pedestriansMayCross) {
    digitalWrite(PEDESTRIAN_TOP_GREEN_PIN, HIGH);
    digitalWrite(PEDESTRIAN_BOTTOM_GREEN_PIN, HIGH);
  } else {
    digitalWrite(VEHICLE_TOP_GREEN_PIN, HIGH);
    digitalWrite(VEHICLE_BOTTOM_GREEN_PIN, HIGH);
  }
  pedestrianPhaseActive = pedestriansMayCross;
  trafficPhaseInitialized = true;
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
    const String html = F("<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>SAFETawid setup</title><style>body{font:16px system-ui;max-width:480px;margin:40px auto;padding:0 18px}input{box-sizing:border-box;width:100%;padding:10px;margin:6px 0 16px}button{padding:12px 18px;background:#087a59;color:white;border:0;border-radius:6px}</style></head><body><h1>SAFETawid hardware setup</h1><p>Enter the Wi-Fi network used by the computer running the dashboard, and that computer's local API address.</p><form method='post' action='/save'><label>Wi-Fi name</label><input name='ssid' required maxlength='32'><label>Wi-Fi password</label><input name='password' type='password' maxlength='64'><label>Computer API address</label><input name='backend' value='http://192.168.1.10:8000' required><button type='submit'>Save and connect</button></form></body></html>");
    configServer.send(200, "text/html; charset=utf-8", html);
  });
  configServer.on("/save", HTTP_POST, []() {
    String ssid = configServer.arg("ssid");
    String password = configServer.arg("password");
    String backend = configServer.arg("backend");
    backend.trim();
    while (backend.endsWith("/")) backend.remove(backend.length() - 1);
    if (ssid.isEmpty() || !(backend.startsWith("http://") || backend.startsWith("https://"))) {
      configServer.send(400, "text/plain; charset=utf-8", "Enter a Wi-Fi name and an API address beginning with http:// or https://.");
      return;
    }
    preferences.begin("safetawid", false);
    preferences.putString("ssid", ssid);
    preferences.putString("password", password);
    preferences.putString("backend", backend);
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
  lastOutputStepAt = 0;
  outputOn = false;
  setTrafficPhase(true);
  Serial.println("Backend alert received");
}

void stopAlert() {
  alertActive = false;
  backendAlert = false;
  setBuzzer(false);
  setTrafficPhase(false);
  Serial.println("Alert sequence finished");
}

void acknowledgeBackendAlert() {
  if (!backendAlert || WiFi.status() != WL_CONNECTED) return;
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
  const int status = http.GET();
  if (status == HTTP_CODE_OK) {
    if (!backendReachable) Serial.println("Backend API connected.");
    backendReachable = true;
    lastBackendFailureStatus = 0;
    const String body = http.getString();
    const bool activeOnServer = body.indexOf("\"active\":true") >= 0;
    if (activeOnServer && !alertActive) {
      const int remainingKey = body.indexOf("\"remaining_ms\":");
      uint32_t remainingMs = 12000;
      if (remainingKey >= 0) {
        const int valueStart = remainingKey + static_cast<int>(sizeof("\"remaining_ms\":") - 1);
        remainingMs = static_cast<uint32_t>(body.substring(valueStart).toInt());
      }
      beginAlert(remainingMs);
    }
    if (!activeOnServer && alertActive && backendAlert) stopAlert();
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
    return;
  }

  if (now - lastOutputStepAt >= OUTPUT_STEP_MS) {
    lastOutputStepAt = now;
    outputOn = !outputOn;
    setBuzzer(outputOn);
  }

  if (now - alertStartedAt >= alertDurationMs) {
    acknowledgeBackendAlert();
    stopAlert();
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
  backendApiUrl = preferences.getString("backend", "");
  preferences.end();
  Serial.println("SAFETawid hardware alert controller starting.");
  if (wifiSsid.isEmpty() || backendApiUrl.isEmpty()) startConfigPortal();
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
  if (otaStarted) ArduinoOTA.handle();
  pollBackend();
  updateOutputs();
  delay(10);
}
