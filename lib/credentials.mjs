/** Never carry a saved key to a different server without an explicitly supplied key. */
export function mergeProfile(current = {}, patch = {}) {
  patch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const next = { ...current, ...patch };
  const origin = (value) => {
    try { return new URL(value).origin; } catch { return null; }
  };
  if ("baseUrl" in patch && String(patch.baseUrl) !== String(current.baseUrl) &&
      (!origin(current.baseUrl) || origin(current.baseUrl) !== origin(patch.baseUrl)) &&
      !String(patch.apiKey ?? "").trim()) {
    next.apiKey = "";
  }
  return next;
}
