import fs from "node:fs";
import { config } from "./config.mjs";

const EXPIRY_MARGIN_MS = 60_000;
const CHECK_CACHE_MS = 30_000;

let cache = null;

export function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(config.statePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("state_corrupt");
  }
  if (!parsed || !Array.isArray(parsed.cookies)) {
    throw new Error("state_corrupt");
  }
  return parsed;
}

export function saveState(cookies) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const payload = {
    base_origin: config.origin,
    saved_at: new Date().toISOString(),
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? null,
      path: cookie.path ?? "/",
      expires: typeof cookie.expires === "number" ? cookie.expires : 0,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      sameSite: cookie.sameSite ?? null,
    })),
  };
  const tmp = `${config.statePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, config.statePath);
  fs.chmodSync(config.statePath, 0o600);
  cache = null;
  return payload;
}

export function cookieHeader(state) {
  if (!state || state.cookies.length === 0) return "";
  return state.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export function sessionCookieNames(state) {
  if (!state) return [];
  return state.cookies
    .filter((cookie) => cookie.httpOnly === true || /session/i.test(cookie.name))
    .map((cookie) => cookie.name);
}

export function stateStatus() {
  const now = Date.now();
  if (cache && now - cache.checkedAt < CHECK_CACHE_MS) return cache.value;

  let state = null;
  let reason = null;
  try {
    state = loadState();
  } catch (err) {
    cache = { checkedAt: now, value: { state: null, expired: true, reason: "state_corrupt", error: err.message } };
    return cache.value;
  }

  if (!state) {
    reason = "session_missing";
  } else if (sessionCookieNames(state).length === 0) {
    reason = "session_expired";
  } else {
    const dead = state.cookies.some(
      (cookie) =>
        sessionCookieNames(state).includes(cookie.name) &&
        cookie.expires > 0 &&
        cookie.expires * 1000 < now + EXPIRY_MARGIN_MS,
    );
    if (dead) reason = "session_expired";
  }

  const value = { state, expired: reason !== null, reason };
  cache = { checkedAt: now, value };
  return value;
}

export function resetStateCache() {
  cache = null;
}
