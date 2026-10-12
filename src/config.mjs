import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`config_missing: set ${name}`);
  }
  return value.trim();
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(names) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function findBundledChrome() {
  const parent = path.join(os.homedir(), ".omp", "puppeteer", "chrome");
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  const build = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("linux-"))
    .map((entry) => entry.name)
    .sort()
    .pop();
  if (!build) return null;
  const candidate = path.join(parent, build, "chrome-linux64", "chrome");
  return isExecutable(candidate) ? candidate : null;
}

function resolveBrowserPath() {
  const explicit = process.env.LMS_BROWSER_PATH ?? process.env.CHROME_PATH;
  if (explicit) {
    if (!isExecutable(explicit)) {
      throw new Error(`browser_not_found: ${explicit} is not executable; set LMS_BROWSER_PATH`);
    }
    return explicit;
  }
  const fromPath = findOnPath([
    "chromium",
    "chromium-browser",
    "google-chrome-stable",
    "google-chrome",
    "brave-browser",
  ]);
  if (fromPath) return fromPath;
  const bundled = findBundledChrome();
  if (bundled) return bundled;
  throw new Error("browser_not_found: set LMS_BROWSER_PATH");
}

function resolveStateDir() {
  const configured = process.env.LMS_STATE_DIR;
  if (configured === undefined || configured.trim() === "") {
    return path.join(os.homedir(), ".local", "state", "learn-mcp-tools");
  }
  return path.resolve(configured.trim());
}

const baseUrl = required("LMS_BASE_URL").replace(/\/+$/, "");
const stateDir = resolveStateDir();
const relativeStateDir = path.relative(root, stateDir);
if (relativeStateDir === "" || (!relativeStateDir.startsWith("..") && !path.isAbsolute(relativeStateDir))) {
  throw new Error("state_dir_inside_repo");
}

export const config = {
  baseUrl,
  origin: new URL(baseUrl).origin,
  root,
  stateDir,
  statePath: path.join(stateDir, "state.json"),
  profileDir: path.join(stateDir, "profile"),
  downloadDir:
    process.env.LMS_DOWNLOAD_DIR ?? path.join(os.homedir(), "Downloads", "learn-mcp-tools"),
  allowWrite: process.env.LMS_ALLOW_WRITE === "1",
  headless: process.env.LMS_HEADLESS === "1",
  userAgent: "learn-mcp-tools/1.0.0 (+local automation)",
  minRequestGapMs: 250,
  get browserPath() {
    return resolveBrowserPath();
  },
};
