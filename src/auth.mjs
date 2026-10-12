import { config } from "./config.mjs";
import { request } from "./client.mjs";
import { saveState } from "./session.mjs";

const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_SECONDS = 240;

function parseCookieHeader(header, host) {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index < 1) return null;
      return {
        name: part.slice(0, index).trim(),
        value: part.slice(index + 1).trim(),
        domain: host,
        path: "/",
        expires: 0,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      };
    })
    .filter(Boolean);
}

export async function acquire({ cookieHeader, timeoutSeconds } = {}) {
  const host = new URL(config.baseUrl).hostname;

  if (cookieHeader && cookieHeader.trim() !== "") {
    const cookies = parseCookieHeader(cookieHeader, host);
    if (cookies.length === 0) return { error: { code: "session_invalid", hint: "cookie header kosong" } };

    const probe = await request("/v3/dashboard", {
      cookieOverride: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    });
    if (probe.kind === "ok") {
      const state = saveState(cookies);
      return {
        authenticated: true,
        url: probe.finalUrl,
        cookie_count: state.cookies.length,
        cookie_names: state.cookies.map((cookie) => cookie.name),
        state_path: config.statePath,
      };
    }
    return {
      error: {
        code: probe.kind === "cloudflare_challenge" ? "cloudflare_challenge" : "session_invalid",
        message: `cookie header ditolak (${probe.status})`,
      },
    };
  }

  const timeout = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
  let puppeteer;
  try {
    ({ default: puppeteer } = await import("puppeteer-core"));
  } catch (err) {
    return { error: { code: "internal", message: `puppeteer-core tidak tersedia: ${err.message}` } };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: config.browserPath,
      headless: config.headless,
      userDataDir: config.profileDir,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
  } catch (err) {
    return {
      error: { code: "internal", message: `gagal meluncurkan browser: ${err.message}`, hint: "set LMS_BROWSER_PATH" },
    };
  }

  try {
    const page = await browser.newPage();
    await page.goto(`${config.baseUrl}/login`, { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      let url;
      try {
        url = new URL(page.url());
      } catch {
        continue;
      }
      if (url.origin !== config.origin || url.pathname === "/login") continue;

      const cookies = await page.cookies();
      const state = saveState(cookies);
      return {
        authenticated: true,
        url: page.url(),
        cookie_count: state.cookies.length,
        cookie_names: state.cookies.map((cookie) => cookie.name),
        state_path: config.statePath,
      };
    }
    return {
      error: {
        code: "auth_timeout",
        message: `tidak ada sesi dalam ${timeout} detik`,
        hint: "selesaikan login (SSO atau email) sebelum batas waktu",
      },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
