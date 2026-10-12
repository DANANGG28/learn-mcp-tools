import { loadState } from "./session.mjs";

const REDACTED = "<redacted>";
const SENSITIVE_PAIR =
  /((?:[A-Za-z0-9_-]*(?:session|token|clearance)[A-Za-z0-9_-]*)|_token|password)=([^;,\s"&]+)/gi;
// Tool payloads are JSON, where the same secrets appear as "key": "value".
const SENSITIVE_JSON =
  /("(?:[A-Za-z0-9_-]*(?:session|token|clearance)[A-Za-z0-9_-]*|_token|password)"\s*:\s*")([^"]*)(")/gi;

function knownSecrets() {
  try {
    const state = loadState();
    if (!state) return [];
    return state.cookies
      .map((cookie) => cookie.value)
      .filter((value) => typeof value === "string" && value.length >= 4);
  } catch {
    return [];
  }
}

export function redact(text) {
  if (typeof text !== "string" || text === "") return text;
  let output = text;
  for (const secret of knownSecrets()) output = output.split(secret).join(REDACTED);
  return output.replace(SENSITIVE_PAIR, `$1=${REDACTED}`).replace(SENSITIVE_JSON, `$1${REDACTED}$3`);
}

export function redactObject(value, seen = new WeakSet()) {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, seen));
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = redactObject(item, seen);
  return output;
}
