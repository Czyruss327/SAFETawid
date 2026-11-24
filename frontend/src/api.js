// The dashboard talks to the backend on the local network by default. Override
// this with VITE_API_BASE_URL when deploying behind a different API origin.
const apiBaseUrl = window.__SCHOOL_ZONE_DESKTOP__
  ? ""
  : (import.meta.env.VITE_API_BASE_URL || "http://192.168.1.4:8000").replace(/\/+$/, "");

export function apiUrl(path) {
  return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
