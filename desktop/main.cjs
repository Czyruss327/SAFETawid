const { app, BrowserWindow, Menu, dialog, session, shell } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

if (!app.requestSingleInstanceLock()) app.quit();

const projectRoot = path.resolve(__dirname, "..");
const resourceRoot = app.isPackaged ? process.resourcesPath : projectRoot;
const frontendRoot = path.join(projectRoot, "frontend");
const backendRoot = path.join(resourceRoot, "backend");
const configFile = path.join(app.getPath("userData"), "desktop-config.json");
const runtimeDirectory = path.join(app.getPath("userData"), "runtime");
const modelDirectory = path.join(app.getPath("userData"), "models");
const venvPython = path.join(runtimeDirectory, "python-env", "Scripts", "python.exe");
const BUNDLED_MODEL_HASHES = {
  "yolo11n.pt": "0ebbc80d4a7680d14987a577cd21342b65ecfd94632bd9a8da63ae6417644ee1",
  "yolo11s.pt": "85a76fe86dd8afe384648546b56a7a78580c7cb7b404fc595f97969322d502d5",
  "yolo11m.pt": "d5ffc1a674953a08e11a8d21e022781b1b23a19b730afc309290bd9fb5305b95",
  "yolo11l.pt": "9ebd0e09d59811db4b1d61e2bc6730649608b1ac47f8dd01e2da6bca7c20023f",
};
let apiServer;
let backendProcess;
let setupProcess;
let setupWindow;
let windowRef;
let apiPort;
let uiPort;
let shuttingDown = false;

function loadConfig() {
  let installerModel = "yolo11n.pt";
  try {
    const selectedModel = fs.readFileSync(path.join(resourceRoot, "model-selection.txt"), "utf8").trim();
    if (Object.hasOwn(BUNDLED_MODEL_HASHES, selectedModel)) installerModel = selectedModel;
  } catch { /* Development runs and older installers default to the recommended light model. */ }
  const defaults = {
    allowEsp32LanAccess: false,
    hardwareAlertsEnabled: false,
    retentionDays: 0,
    apiPort: 8000,
    pythonExecutable: "",
    model: installerModel,
    device: "auto",
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(configFile, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Could not read desktop configuration at ${configFile}: ${error.message}`);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify(defaults, null, 2)}\n`, { flag: "wx" });
    return defaults;
  }
}

function choosePort(host, requestedPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function backendDependenciesReady(python) {
  try {
    execFileSync(python, ["-c", "import fastapi, uvicorn, ultralytics, torch"], { stdio: "ignore", timeout: 60000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function appendSetupLog(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (!setupWindow || setupWindow.isDestroyed() || lines.length === 0) return;
  const encoded = JSON.stringify(`${lines.join("\n")}\n`);
  setupWindow.webContents.executeJavaScript(`document.getElementById('log').textContent += ${encoded}; document.getElementById('log').scrollTop = document.getElementById('log').scrollHeight;`).catch(() => {});
}

function openSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 680,
    height: 500,
    resizable: true,
    title: "Preparing School Zone Safety Monitor",
    backgroundColor: "#f4f6f9",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preparing app</title><style>body{font:14px system-ui,sans-serif;color:#203148;background:#f4f6f9;margin:0;padding:30px}h1{font-size:22px}p{color:#647387;line-height:1.5}pre{height:270px;overflow:auto;padding:14px;background:#101821;color:#d6e5ee;border-radius:8px;white-space:pre-wrap;font:11px ui-monospace,monospace}</style><h1>Preparing the backend</h1><p>First launch installs the Python packages required for detection. This may take several minutes and requires an internet connection. You can keep this window open while setup runs.</p><pre id="log">Starting setup…\n</pre>`;
  setupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
}

async function ensureBackend(config) {
  if (fs.existsSync(venvPython) && backendDependenciesReady(venvPython)) return venvPython;
  const setupScript = path.join(backendRoot, "setup_backend.ps1");
  if (!fs.existsSync(setupScript)) throw new Error(`Backend setup script is missing: ${setupScript}`);
  openSetupWindow();
  const basePython = config.pythonExecutable || "";
  await new Promise((resolve, reject) => {
    setupProcess = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", setupScript,
      "-RuntimeDirectory", runtimeDirectory,
      ...(basePython ? ["-PythonExecutable", basePython] : []),
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let errorOutput = "";
    setupProcess.stdout.on("data", (chunk) => appendSetupLog(chunk));
    setupProcess.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); appendSetupLog(chunk); });
    setupProcess.once("error", reject);
    setupProcess.once("exit", (code) => {
      setupProcess = null;
      if (code === 0 && backendDependenciesReady(venvPython)) resolve();
      else reject(new Error(errorOutput.trim() || `Backend setup failed (exit code ${code}).`));
    });
  }).finally(() => {
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
    setupWindow = null;
  });
  return venvPython;
}

function resolveModel(config) {
  const configuredModel = config.model || "yolo11n.pt";
  if (path.isAbsolute(configuredModel)) return configuredModel;
  const modelPath = path.resolve(modelDirectory, configuredModel);
  if (!modelPath.startsWith(`${modelDirectory}${path.sep}`)) throw new Error("The configured model path must stay inside the AppData models folder or be an absolute path.");
  return modelPath;
}

function ensureBundledModel(config) {
  if (path.isAbsolute(config.model || "")) return;
  const modelName = path.basename(config.model || "yolo11n.pt");
  const expectedHash = BUNDLED_MODEL_HASHES[modelName];
  if (!expectedHash) return;
  const target = resolveModel(config);
  if (fs.existsSync(target)) {
    const currentHash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    if (currentHash === expectedHash) return;
    fs.rmSync(target, { force: true });
  }
  const packagedModel = path.join(resourceRoot, "models", modelName);
  if (!fs.existsSync(packagedModel)) throw new Error(`The packaged YOLO model is missing: ${packagedModel}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporaryModel = `${target}.part`;
  fs.copyFileSync(packagedModel, temporaryModel);
  const copiedHash = crypto.createHash("sha256").update(fs.readFileSync(temporaryModel)).digest("hex");
  if (copiedHash !== expectedHash) {
    fs.rmSync(temporaryModel, { force: true });
    throw new Error(`The bundled ${modelName} model failed its SHA-256 integrity check.`);
  }
  fs.renameSync(temporaryModel, target);
}

function startBackend(config, python) {
  const dataDir = app.getPath("userData");
  const bindHost = config.allowEsp32LanAccess ? "0.0.0.0" : "127.0.0.1";
  fs.mkdirSync(modelDirectory, { recursive: true });
  backendProcess = spawn(python, ["-m", "uvicorn", "main:app", "--host", bindHost, "--port", String(apiPort)], {
    cwd: modelDirectory,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_PATH: path.join(dataDir, "school_zone.db"),
      TELEMETRY_KEY_PATH: path.join(dataDir, "telemetry.key"),
      EXPORT_DIRECTORY: path.join(dataDir, "exports"),
      HARDWARE_ALERT_ENABLED: String(Boolean(config.hardwareAlertsEnabled)),
      ESP32_DISCOVERY_ENABLED: String(Boolean(config.allowEsp32LanAccess && config.hardwareAlertsEnabled)),
      ESP32_DISCOVERY_PORT: String(apiPort),
      DATA_RETENTION_DAYS: String(Math.max(0, Number(config.retentionDays) || 0)),
      YOLO_DEVICE: process.env.YOLO_DEVICE || config.device || "auto",
      FRONTEND_ORIGINS: "http://127.0.0.1",
      PYTHONPATH: [backendRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      YOLO_MODEL: resolveModel(config),
    },
  });
  backendProcess.stdout.on("data", (chunk) => process.stdout.write(`[backend] ${chunk}`));
  backendProcess.stderr.on("data", (chunk) => process.stderr.write(`[backend] ${chunk}`));
  backendProcess.on("error", (error) => showStartupError(`Could not start Python backend: ${error.message}`));
  backendProcess.on("exit", (code) => {
    if (!shuttingDown && code !== 0) showStartupError(`The Python service stopped (exit code ${code}). Check that backend setup completed.`);
  });
}

function serveAndProxy() {
  const distRoot = path.join(frontendRoot, "dist");
  apiServer = http.createServer((request, response) => {
    const target = new URL(request.url, `http://127.0.0.1:${uiPort}`);
    if (target.pathname.startsWith("/api/")) {
      const proxy = http.request({ hostname: "127.0.0.1", port: apiPort, path: `${target.pathname}${target.search}`, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${apiPort}` } }, (upstream) => {
        response.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(response);
      });
      proxy.on("error", () => { response.writeHead(503); response.end("Local detection service is unavailable."); });
      request.pipe(proxy);
      return;
    }
    const relative = decodeURIComponent(target.pathname === "/" ? "/index.html" : target.pathname);
    const filePath = path.resolve(distRoot, `.${relative}`);
    if (!filePath.startsWith(`${distRoot}${path.sep}`) && filePath !== path.join(distRoot, "index.html")) {
      response.writeHead(403); response.end("Forbidden"); return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) { response.writeHead(404); response.end("Not found"); return; }
      const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".mp3": "audio/mpeg" }[path.extname(filePath)] || "application/octet-stream";
      response.writeHead(200, { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
      if (path.basename(filePath) === "index.html") {
        response.end(content.toString("utf8").replace("</head>", "<script>window.__SCHOOL_ZONE_DESKTOP__=true</script></head>"));
      } else {
        response.end(content);
      }
    });
  });
  return new Promise((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(0, "127.0.0.1", () => { uiPort = apiServer.address().port; resolve(); });
  });
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 700,
    title: "School Zone Safety Monitor",
    backgroundColor: "#f5f8fb",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  windowRef.loadURL(`http://127.0.0.1:${uiPort}/`);
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1:")) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  windowRef.on("closed", () => { windowRef = null; });
}

async function showStartupError(message) {
  if (shuttingDown) return;
  await dialog.showMessageBox({ type: "error", title: "School Zone Safety Monitor", message, detail: `Setup guide: ${path.join(resourceRoot, "DESKTOP.md")}` });
}

app.whenReady().then(async () => {
  const config = loadConfig();
  const python = await ensureBackend(config);
  ensureBundledModel(config);
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return permission === "media" && new URL(requestingOrigin).hostname === "127.0.0.1";
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trustedDashboard = webContents.getURL().startsWith("http://127.0.0.1:");
    callback(trustedDashboard && permission === "media" && details.mediaTypes?.includes("video"));
  });
  const bindHost = config.allowEsp32LanAccess ? "0.0.0.0" : "127.0.0.1";
  apiPort = await choosePort(bindHost, Math.max(1024, Math.min(65535, Number(config.apiPort) || 8000)));
  console.log(`ESP32 API listening on ${bindHost}:${apiPort}`);
  await serveAndProxy();
  startBackend(config, python);
  createWindow();
}).catch((error) => showStartupError(`Desktop startup failed: ${error.message}`));

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: "App", submenu: [
    { label: "Open local data folder", click: () => shell.openPath(app.getPath("userData")) },
    { label: "Open desktop configuration", click: () => shell.openPath(configFile) },
    { type: "separator" }, { role: "quit" },
  ] },
]));

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!backendProcess || backendProcess.exitCode !== null || !backendProcess.pid) {
    if (apiServer) apiServer.close();
    return;
  }

  // Keep Electron alive until the Python/Uvicorn process tree has released model and GPU memory.
  event.preventDefault();
  let finished = false;
  const finishShutdown = () => {
    if (finished) return;
    finished = true;
    clearTimeout(forceTimer);
    if (apiServer) apiServer.close();
    app.quit();
  };
  backendProcess.once("exit", finishShutdown);
  const forceTimer = setTimeout(() => {
    if (backendProcess.exitCode === null) backendProcess.kill();
    setTimeout(finishShutdown, 1500).unref();
  }, 5000);
  forceTimer.unref();

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(backendProcess.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => backendProcess.kill());
  } else {
    backendProcess.kill("SIGTERM");
  }
});
app.on("window-all-closed", () => app.quit());
