import { useEffect, useState } from "react";
import { apiUrl } from "../api.js";

const defaults = {
  confidence_threshold: 0.65,
  one_person_dwell_seconds: 12,
  two_person_dwell_seconds: 8,
  three_or_more_dwell_seconds: 5,
  standby_beep_delay_seconds: 1,
  alert_duration_seconds: 12,
};

const fields = [
  ["confidence_threshold", "Minimum detection confidence", 0, 1, 0.01, "0–1", (value) => `${Math.round(value * 100)}%`],
  ["one_person_dwell_seconds", "Alert delay · 1 person", 0, 300, 1, "sec", (value) => `${value} sec`],
  ["two_person_dwell_seconds", "Alert delay · 2 people", 0, 300, 1, "sec", (value) => `${value} sec`],
  ["three_or_more_dwell_seconds", "Alert delay · 3+ people", 0, 300, 1, "sec", (value) => `${value} sec`],
  ["alert_duration_seconds", "Alert output duration", 1, 300, 1, "sec", (value) => `${value} sec`],
  ["standby_beep_delay_seconds", "Standby beep interval", 0, 60, 0.5, "sec", (value) => `${value} sec`],
];

export default function AlertSettingsPanel() {
  const [values, setValues] = useState(defaults);
  const [presets, setPresets] = useState({ "peak-hours": null, "off-peak-hours": null });
  const [status, setStatus] = useState("Loading alert settings…");
  const [saving, setSaving] = useState(false);
  const [savingPreset, setSavingPreset] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(apiUrl("/api/alert-settings")),
      fetch(apiUrl("/api/alert-presets")),
    ])
      .then(async ([settingsResponse, presetsResponse]) => {
        if (!settingsResponse.ok || !presetsResponse.ok) throw new Error("Could not load alert settings from the detection service.");
        return Promise.all([settingsResponse.json(), presetsResponse.json()]);
      })
      .then(([settings, savedPresets]) => {
        if (active) {
          setValues({ ...defaults, ...settings });
          setPresets(savedPresets);
          setStatus("");
        }
      })
      .catch((error) => { if (active) setStatus(error.message); });
    return () => { active = false; };
  }, []);

  const loadPreset = (presetKey, label) => {
    const saved = presets[presetKey];
    if (!saved) return;
    setValues({ ...defaults, ...saved });
    setStatus(`${label} loaded. Select Save settings to apply it.`);
  };

  const savePreset = async (presetKey, label) => {
    setSavingPreset(presetKey);
    setStatus("");
    try {
      const response = await fetch(apiUrl(`/api/alert-presets/${presetKey}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || `Could not save ${label}.`);
      setPresets((current) => ({ ...current, [presetKey]: result.settings }));
      setStatus(`${label} saved.`);
    } catch (error) {
      setStatus(error.message || `Could not save ${label}.`);
    } finally {
      setSavingPreset("");
    }
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setStatus("");
    try {
      const response = await fetch(apiUrl("/api/alert-settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Could not save alert settings.");
      setValues({ ...defaults, ...result });
      setStatus("Alert settings saved and active.");
    } catch (error) {
      setStatus(error.message || "Could not save alert settings.");
    } finally {
      setSaving(false);
    }
  };

  return <section className="panel alert-settings-panel" aria-label="Alert settings">
    <div className="panel-heading"><div><div className="section-kicker">DETECTION AND SOUND</div><h2>Alert settings</h2></div></div>
    <p className="alert-settings-description">Changes apply to this detection service and are saved across restarts. Alert delays set how long a person must be detected before triggering; alert output duration sets how long the dashboard sound, hardware lights, and buzzer stay active.</p>
    <div className="alert-presets" aria-label="Saved alert presets">
      {[["peak-hours", "Peak hours settings"], ["off-peak-hours", "Off-peak hours settings"]].map(([presetKey, label]) => (
        <div className="alert-preset-card" key={presetKey}>
          <div><strong>{label}</strong><small>{presets[presetKey] ? "Preset saved" : "No preset saved yet"}</small></div>
          <div className="alert-preset-actions">
            <button type="button" onClick={() => loadPreset(presetKey, label)} disabled={!presets[presetKey] || saving || Boolean(savingPreset)}>Load</button>
            <button type="button" onClick={() => savePreset(presetKey, label)} disabled={saving || Boolean(savingPreset)}>{savingPreset === presetKey ? "Saving…" : "Save current"}</button>
          </div>
        </div>
      ))}
    </div>
    <form onSubmit={save}>
      {fields.map(([key, label, min, max, step, unit, format]) => <label className="alert-setting-field" key={key} htmlFor={`alert-setting-${key}`}>
        <span>{label}<small>{format(values[key])}</small></span>
        <input id={`alert-setting-${key}`} type="number" min={min} max={max} step={step} required value={values[key]} disabled={saving} onChange={(event) => setValues((current) => ({ ...current, [key]: Number(event.target.value) }))} />
        <em>{unit}</em>
      </label>)}
      <p className="alert-settings-hint">A 0 second delay triggers immediately. Confidence is the minimum score required to accept a person detection.</p>
      <button className="alert-settings-save" type="submit" disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
    </form>
    {status && <p className="alert-settings-status" role="status">{status}</p>}
  </section>;
}
