import { config } from "./config.mjs";
import { cookieHeader, stateStatus } from "./session.mjs";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

let lastRequestAt = 0;
let queue = Promise.resolve();
let observer = null;

// Optional audit hook: receives (method, path) for every outgoing request so a
// wrapper script can prove which calls a run actually made.
export function setRequestObserver(fn) {
  observer = typeof fn === "function" ? fn : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throttle() {
  const run = queue.then(async () => {
    const wait = lastRequestAt + config.minRequestGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  queue = run.catch(() => {});
  return run;
}

function decodeBody(buffer, contentType) {
  const charset = /charset=([^;]+)/i.exec(contentType ?? "")?.[1]?.trim().replace(/^["']|["']$/g, "");
  const label = charset && charset.toLowerCase() !== "utf-8" ? charset : "utf-8";
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function classify(status, location, body) {
  if ((status === 302 || status === 303) && location) {
    try {
      if (new URL(location, config.baseUrl).pathname === "/login") return "session_expired";
    } catch {
      /* unparseable location: fall through */
    }
  }
  if (status === 200 && /<title>[^<]*\|\s*Login\s*<\/title>/i.test(body)) return "session_expired";
  if (status === 403 && body.includes("cdn-cgi/challenge-platform")) return "cloudflare_challenge";
  if (status >= 400) return "http_error";
  return "ok";
}

export async function request(resourcePath, options = {}) {
  const { method = "GET", headers = {}, body, bodyFactory, cookieOverride } = options;

  if (typeof resourcePath !== "string" || !resourcePath.startsWith("/")) {
    throw new Error("origin_rejected");
  }
  let url = new URL(resourcePath, config.baseUrl);
  if (url.origin !== config.origin) throw new Error("origin_rejected");

  const status = stateStatus();
  const baseHeaders = {
    "user-agent": config.userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "id-ID,id;q=0.9,en;q=0.5",
    ...headers,
  };
  const cookie = cookieOverride ?? (status.state ? cookieHeader(status.state) : "");
  if (cookie) baseHeaders.cookie = cookie;

  const redirects = [];
  let currentMethod = method;
  let currentBody = body;
  let response;

  for (let hop = 0; ; hop += 1) {
    if (observer) observer(currentMethod, url.pathname + url.search);
    await throttle();
    response = await fetch(url, {
      method: currentMethod,
      headers: baseHeaders,
      body: currentBody,
      redirect: "manual",
    });

    const location = response.headers.get("location");
    if (!REDIRECT_STATUS.has(response.status) || !location || hop >= MAX_REDIRECTS) break;

    const next = new URL(location, url);
    if (next.origin !== config.origin) throw new Error("origin_rejected");
    redirects.push(next.pathname + next.search);
    url = next;
    if (response.status === 303 || (currentMethod === "POST" && response.status !== 307 && response.status !== 308)) {
      currentMethod = "GET";
      currentBody = undefined;
    } else if (bodyFactory) {
      currentBody = bodyFactory();
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BODY_BYTES) throw new Error("body_too_large");
  const contentType = response.headers.get("content-type");
  const text = decodeBody(buffer, contentType);

  return {
    status: response.status,
    headers: response.headers,
    body: text,
    bytes: buffer.byteLength,
    contentType,
    finalUrl: url.toString(),
    redirects,
    kind: classify(response.status, response.headers.get("location"), text),
  };
}

export async function getHtml(resourcePath, options = {}) {
  return request(resourcePath, { ...options, method: "GET" });
}

export async function postMultipart(resourcePath, { fields = [], file, headers = {} } = {}) {
  const build = () => {
    const form = new FormData();
    for (const [name, value] of fields) form.append(name, value ?? "");
    if (file) form.append(file.field, new Blob([file.bytes]), file.filename);
    return form;
  };
  return request(resourcePath, {
    method: "POST",
    headers,
    body: build(),
    bodyFactory: file ? build : null,
  });
}

export function describeRequest(method, resourcePath) {
  return `${method} ${resourcePath}`;
}
