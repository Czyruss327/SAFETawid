# SAFETawid Reliability Changes

Here is a file-by-file explanation of the changes made during the reliability pass. Code changes are grouped by file and changed section; new files are explained line by line.

## Backend

### `backend/runtime_config.py` — new file

- **Lines 1–5:** Describe the module and import helpers for reading environment variables, checking finite numbers, and validating device strings.
- **Lines 8–18 — `read_int`:** Reads an integer setting, uses a supplied default when unset, enforces optional minimum and maximum values, and raises a descriptive error if conversion or bounds checks fail.
- **Lines 21–33 — `read_float`:** Reads a float, rejects non-numeric and non-finite values such as `NaN` and infinity, checks optional bounds, and returns the validated value.
- **Lines 36–42 — `read_bool`:** Accepts explicit true and false spellings. Invalid strings now raise an error instead of silently becoming false.
- **Lines 45–49 — `read_device`:** Allows only `auto`, `cpu`, `cuda`, `cuda:N`, or a numeric GPU index.

**Why:** Backend settings used to be parsed inline with little or no validation. Invalid values could fail later during model loading or produce unpredictable behavior.

### `backend/test_runtime_config.py` — new file

- **Lines 1–8:** Import the test framework, environment patching helpers, and the configuration parsers. The import fallback supports running tests either as a package or from the backend directory.
- **Lines 11–18:** Test valid integer bounds and reject non-numeric, too-small, and too-large values.
- **Lines 20–24:** Test rejection of `NaN`, infinity, and out-of-range floats.
- **Lines 26–32:** Test accepted boolean spellings and rejection of an invalid one.
- **Lines 34–41:** Test accepted device values and rejection of malformed device names.
- **Lines 44–45:** Allow direct execution of the test file.

**Why:** These parsers can be tested without installing the full inference stack. All four test methods pass.

### `backend/main.py`

- **Lines 20, 33, and 36:** Import Starlette’s client-disconnect exception and the new environment parsers. Keep both package-style and direct `uvicorn main:app` import modes working.
- **Lines 39–52:** Validate the model name, device, image size, confidence, retention days, dwell times, and hardware-alert flag at startup. Image size is constrained to 32–2048, confidence to 0–1, retention to a nonnegative integer, and dwell times to 0–300 seconds.
- **Line 51:** Set a 20-million-pixel decoded image limit. A compressed upload size limit alone would not prevent a small image file from expanding to consume excessive memory.
- **Line 68:** Parse the ESP32 discovery flag as a strict boolean.
- **Line 73:** Constrain the advertised mDNS port to 1–65535.
- **Lines 100–103:** Trim and remove blank frontend origins before configuring CORS.
- **Line 548:** Reject booleans as detection-zone coordinates. Python treats booleans as integers, so `true` and `false` previously passed the numeric type check.
- **Lines 660–667:** Check `Content-Length` before reading the body; reject oversized or malformed values early.
- **Lines 668–678:** Read frame data incrementally and stop once it exceeds 8 MB. Convert interrupted uploads into a controlled 400 response.
- **Lines 682–690:** Accept only JPEG and PNG, reject images over the pixel limit before conversion, preserve deliberate 413/415 errors, and return a controlled 400 for other decoding errors.

**Why:** These checks prevent oversized requests, invalid configuration, malformed zones, and image decoding problems from turning into memory pressure or unclear runtime failures.

## Desktop launcher and packaging

### `desktop/main.cjs`

- **Lines 50–78 — `loadConfig`:** Require a JSON object; validate feature flags, API port, retention days, Python path, model, and device settings. Missing config still creates defaults. Invalid JSON and filesystem errors now receive clearer messages.
- **Line 100 — `backendDependenciesReady`:** Check all backend imports, including Pillow, cryptography, and zeroconf. Increase the check timeout from 60 to 180 seconds to allow slower computers to finish imports.
- **Lines 158–165 — `resolveModel`:** Use `path.relative` to prevent relative model paths escaping the AppData models folder. If an official model is neither local nor bundled, return its model name so Ultralytics can download it on first inference.
- **Lines 176–179 — `ensureBundledModel`:** When the installer does not contain a model, preserve any local copy and allow the download fallback. If a model is bundled, existing copy and hash checks remain in effect.
- **Lines 234–281 — `serveAndProxy`:** Catch malformed requests, handle invalid URL encoding, prevent paths escaping the frontend build directory, distinguish missing assets from other read errors, and handle request/proxy stream failures without corrupting responses.
- **Lines 297–299 — `createWindow`:** Catch a failed dashboard load and route it through the startup error dialog.
- **Line 302:** Catch failures opening external links instead of leaving an unhandled promise rejection.
- **Lines 308–318 — `showStartupError`:** Handle errors displaying the dialog and always quit after a startup failure. This prevents Electron from remaining open without a usable window.
- **Lines 340–341:** Catch failures opening the local data folder or configuration file.

**Why:** These changes make malformed configuration, missing models, failed local requests, and Electron API failures easier to diagnose and less likely to leave a broken app running.

### `package.json`

- **Line 36:** Add `runtime_config.py` to Electron Builder’s backend resources.

**Why:** The packaged backend imports this module. Without packaging it, the source tree could work while the installed app failed at startup.

### `DESKTOP.md`

- **Packaging section:** Correct the statement that installers always contain every YOLO weight. It now explains that weights are bundled when present during packaging, and otherwise downloaded on first inference. It also clarifies that this requires internet access.

**Why:** The repository checkout used for testing did not contain the model files, so the previous documentation overstated what the installer included.

## Frontend

### `frontend/src/components/Cam.jsx`

- **Lines 40–41:** Add refs holding the current alert-playback and standby-sound functions.
- **Lines 120–123:** Close the modal directly in the responsive-layout change handler and remove the follow-up state-setting effect.
- **Lines 271–274:** Refresh the function refs after renders so long-running effects use current callbacks.
- **Lines 321–323:** Keep sound preference persistence, but remove sound-stopping state changes from the effect.
- **Line 378:** Use the current alert callback for scheduled playback.
- **Lines 405–406:** Remove a synchronous FPS state update from an effect’s early exit.
- **Lines 523–525:** Use the current alert and standby callbacks in the frame-processing effect.
- **Lines 613–619:** When sound is switched off, stop the active sounds directly in the click handler before saving the preference.
- **Line 674:** Reset camera FPS when the operator stops the feed.

**Why:** These changes resolve React hook/ref lint errors and prevent stale callbacks in scheduled and detection-triggered alert flows.

### `frontend/src/components/CameraFeed.jsx`

- **Lines 39–41:** Track video dimensions in React state instead of reading the video ref during render.
- **Lines 45–51:** Validate the view element and dimensions before calculating pointer coordinates, avoiding division by zero and invalid zone coordinates.
- **Lines 113–122:** Update the saved dimensions when video metadata loads, but only when width and height are positive.

**Why:** Reading refs during render triggered lint errors and could leave the overlay dependent on changes React does not track.

### `frontend/src/hooks/useCameraStream.js`

- **Lines 12, 17–18:** Determine whether camera APIs are available during initial state setup so unsupported browsers start in an error state immediately.
- **Line 15:** Add a helper to invalidate pending camera requests during cleanup.
- **Lines 22–30:** Stop each media track defensively and detach the video element without letting one cleanup failure prevent the rest.
- **Lines 52–58:** Make device enumeration optional, verify a video track exists, and release the stream if setup fails.
- **Lines 76–86:** Defer initial camera startup to a guarded microtask. Cleanup cancels startup if the effect has already been disposed, invalidates pending requests, and releases active media.

**Why:** A camera stream could remain active if setup failed after `getUserMedia` succeeded. The cleanup changes close that leak and make camera startup resilient to React effect cleanup.

## Project documentation

### `PROJECT_MAP.md`

- **Lines 48 and 51:** Add the runtime configuration module and its tests to the repository map.

The rest of this file was created in the previous turn as the architecture guide, covering project structure, data flow, API routes, persistence, configuration, component ownership, and change locations.

### `readme.md`

- **Line 3:** Link to `PROJECT_MAP.md` near the top of the main README.

**Why:** This makes the agent-oriented project guide easy to find.

## Verification

- 10 backend unit tests passed.
- Python source compilation passed.
- Frontend lint passed.
- Frontend production build passed.
- Electron main-process syntax check passed.
- Windows NSIS installer packaging completed.

The installer build reported that the YOLO weights were absent; the updated app downloads the selected official model on first inference. The FastAPI service and ESP32 were not exercised because the required Python runtime packages and physical hardware were unavailable.