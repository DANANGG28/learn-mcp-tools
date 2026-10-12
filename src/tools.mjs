import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { acquire } from "./auth.mjs";
import { config } from "./config.mjs";
import { getHtml, postMultipart } from "./client.mjs";
import { clean, collectHiddenFields, summarize } from "./parse.mjs";
import { loadState, stateStatus } from "./session.mjs";

const ACCESS_PREFIX = "/akses/";
const SUBMISSION_PREFIX = "/akses/pengumpulan-tugas/";
const DEADLINE_PATTERN = /(deadline|batas|tenggat|dikumpulkan|due)/i;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export class ToolError extends Error {
  constructor(code, message, hint) {
    super(message ?? code);
    this.code = code;
    this.hint = hint;
  }
}

function payload(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function ok(value) {
  return payload(value);
}

function fail(error) {
  const body =
    error instanceof ToolError
      ? {
          error: {
            code: error.code,
            ...(error.message ? { message: error.message } : {}),
            ...(error.hint ? { hint: error.hint } : {}),
          },
        }
      : { error: { code: "internal", message: String(error?.message ?? error) } };
  return { ...payload(body), isError: true };
}

const RETHROWN = new Map([
  ["origin_rejected", "path di luar origin situs"],
  ["body_too_large", "respons melebihi batas ukuran"],
  ["state_corrupt", "berkas state rusak; jalankan ulang tool auth"],
]);

function withErrors(handler) {
  return async (args) => {
    try {
      return await handler(args ?? {});
    } catch (err) {
      if (err instanceof ToolError) return fail(err);
      if (RETHROWN.has(err?.message)) return fail(new ToolError(err.message, RETHROWN.get(err.message)));
      return fail(err);
    }
  };
}

function requireSession() {
  const status = stateStatus();
  if (status.expired) {
    throw new ToolError(status.reason ?? "session_expired", "sesi tidak tersedia", "jalankan tool auth");
  }
  return status.state;
}

function ensureOk(result, hint = "jalankan tool auth") {
  if (result.kind === "ok") return result;
  throw new ToolError(result.kind, `permintaan gagal (HTTP ${result.status})`, hint);
}

async function fetchSummary(resourcePath, options = {}) {
  const result = await getHtml(resourcePath);
  ensureOk(result);
  return summarize(result.body, result.finalUrl, {
    ...options,
    status: result.status,
    redirects: result.redirects,
  });
}

function safeFilename(candidate) {
  const base = path.basename(String(candidate).replace(/[\u0000-\u001f\u007f]/g, ""));
  const cleaned = base.replace(/[\\/]/g, "_").replace(/^\.+/, "").trim();
  return cleaned === "" ? "download" : cleaned;
}

function uniquePath(directory, filename) {
  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  let candidate = path.join(directory, filename);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${stem}-${counter}${extension}`);
    counter += 1;
  }
  return candidate;
}

function findSubmitForm(forms, tugasId) {
  const marker = `/tugas/${tugasId}/submit`;
  const byAction = forms.find((form) => form.action.includes(marker));
  if (byAction) return byAction;
  return forms.find((form) => form.method === "POST" && form.fields.some((field) => field.type === "file")) ?? null;
}

function describeSubmitForm(form) {
  if (!form) return null;
  return {
    action: form.action,
    method: form.method,
    enctype: form.enctype,
    csrf_present: form.csrf_present,
    fields: form.fields,
    file_field: form.fields.find((field) => field.type === "file")?.name ?? null,
  };
}

function deadlineFromTables(tables) {
  for (const table of tables) {
    for (const row of table.rows) {
      if (row.some((cell) => DEADLINE_PATTERN.test(cell))) return row.filter(Boolean).join(" | ");
    }
    const header = table.headers.find((cell) => DEADLINE_PATTERN.test(cell));
    if (header) return header;
  }
  return null;
}

// The page body collapses to one long line, so a keyword match is reported as a
// bounded window around it instead of the whole document.
function deadlineFromText(body) {
  const text = clean(body);
  const match = DEADLINE_PATTERN.exec(text);
  if (!match) return null;
  const start = Math.max(0, match.index - 60);
  const end = Math.min(text.length, match.index + match[0].length + 120);
  return text.slice(start, end).trim();
}

async function collectAssignment(pertemuanId, tugasId) {
  requireSession();
  const resourcePath = `/pertemuan/${pertemuanId}/tugas/${tugasId}`;
  const summary = await fetchSummary(resourcePath);

  const submissions = summary.files.filter((file) => file.href.startsWith(SUBMISSION_PREFIX));
  const submitForm = describeSubmitForm(findSubmitForm(summary.forms, tugasId));

  let deadlineText = deadlineFromTables(summary.tables);
  if (deadlineText === null) {
    const withText = await fetchSummary(resourcePath, { includeText: true });
    deadlineText = deadlineFromText(withText.text);
  }

  return {
    pertemuan_id: pertemuanId,
    tugas_id: tugasId,
    url: summary.url,
    title: summary.title,
    submitted: submissions.length > 0,
    submissions,
    deadline_text: deadlineText,
    submit_form: submitForm,
    tables: summary.tables,
    links: summary.links,
    headings: summary.headings,
    files: summary.files,
    csrf_token: summary.csrfToken,
  };
}

function readUpload(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new ToolError("file_missing", `berkas tidak ditemukan: ${filePath}`);
  }
  if (!stat.isFile()) throw new ToolError("file_unreadable", `bukan berkas biasa: ${filePath}`);
  if (stat.size > MAX_UPLOAD_BYTES) throw new ToolError("file_unreadable", "berkas melebihi 200 MB");
  try {
    return { bytes: fs.readFileSync(filePath), filename: path.basename(filePath) };
  } catch {
    throw new ToolError("file_unreadable", "berkas tidak dapat dibaca");
  }
}

// The submit form's hidden inputs come from the rendered page verbatim, so the
// request mirrors what the server expects instead of guessing field values.
function submissionFields(form, hiddenPairs, description) {
  const fields = [];
  for (const pair of hiddenPairs) {
    if (typeof pair.name !== "string" || pair.name === "") continue;
    fields.push([pair.name, pair.value]);
  }
  const known = new Set(fields.map(([name]) => name));
  for (const field of form?.fields ?? []) {
    if (typeof field.name !== "string" || field.name === "" || known.has(field.name)) continue;
    if (field.type === "file" || field.type === "submit" || field.type === "button" || field.type === "hidden") continue;
    fields.push([field.name, ""]);
    known.add(field.name);
  }
  const descriptionField = (form?.fields ?? []).find((field) => field.type === "textarea")?.name ?? "deskripsi";
  if (description !== undefined) {
    const index = fields.findIndex(([name]) => name === descriptionField);
    if (index >= 0) fields[index] = [descriptionField, description];
    else fields.push([descriptionField, description]);
  }
  return fields;
}

function tokenFromHtml(html) {
  const meta = /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i.exec(html ?? "");
  return meta?.[1] ?? "";
}

export function registerReadTools(server) {
  server.registerTool(
    "status",
    {
      title: "Session status",
      description: "Report whether the stored browser session is usable, and which surfaces respond.",
      inputSchema: {},
    },
    withErrors(async () => {
      const state = loadState();
      const base = {
        base_url: config.baseUrl,
        state_path: config.statePath,
        saved_at: state?.saved_at ?? null,
        cookie_count: state?.cookies.length ?? 0,
        write_enabled: config.allowWrite,
      };
      const status = stateStatus();
      if (status.expired) return ok({ ...base, authenticated: false, reason: status.reason ?? "session_missing" });
      try {
        const summary = await fetchSummary("/v3/dashboard");
        return ok({ ...base, authenticated: true, url: summary.url, title: summary.title });
      } catch (err) {
        if (err instanceof ToolError && err.code === "session_expired") {
          return ok({ ...base, authenticated: false, reason: "session_expired" });
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "page",
    {
      title: "Read page",
      description: "Fetch one same-origin page: title, headings, links, forms, tables, and downloadable files.",
      inputSchema: {
        path: z.string().describe("Absolute path on the site, for example /v3/dashboard"),
        include_text: z.boolean().optional().describe("Include collapsed body text, truncated to 20000 characters"),
        include_html: z.boolean().optional().describe("Include raw HTML, truncated to 500000 characters"),
      },
    },
    withErrors(async ({ path: resourcePath, include_text: includeText, include_html: includeHtml }) => {
      if (typeof resourcePath !== "string" || !resourcePath.startsWith("/")) {
        throw new ToolError("origin_rejected", "path harus berupa path absolut pada situs");
      }
      requireSession();
      return ok(
        await fetchSummary(resourcePath, {
          includeText: includeText === true,
          includeHtml: includeHtml === true,
        }),
      );
    }),
  );

  server.registerTool(
    "download",
    {
      title: "Download file",
      description: "Save one file served from the site's access routes into the local download directory.",
      inputSchema: {
        path: z.string().describe("Access path, for example /akses/materi/<name>"),
        filename: z.string().optional().describe("Optional override for the saved file name"),
      },
    },
    withErrors(async ({ path: resourcePath, filename }) => {
      if (typeof resourcePath !== "string" || !resourcePath.startsWith(ACCESS_PREFIX)) {
        throw new ToolError("origin_rejected", "hanya path /akses/ yang boleh diunduh");
      }
      requireSession();
      const result = await getHtml(resourcePath);
      ensureOk(result);
      const derived = filename ?? decodeURIComponent(resourcePath.split("?")[0].split("/").pop() ?? "download");
      const name = safeFilename(derived);
      fs.mkdirSync(config.downloadDir, { recursive: true, mode: 0o700 });
      const target = uniquePath(config.downloadDir, name);
      const buffer = Buffer.from(result.body, "utf8");
      fs.writeFileSync(target, buffer, { mode: 0o600 });
      return ok({
        saved_path: target,
        filename: path.basename(target),
        bytes: buffer.byteLength,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
        content_type: result.contentType,
        content_length: result.headers.get("content-length"),
      });
    }),
  );

  server.registerTool(
    "assignment",
    {
      title: "Assignment detail",
      description: "Read one assignment page: submission state, deadline text, and the exact submit form shape.",
      inputSchema: {
        pertemuan_id: z.int().min(1).describe("Meeting identifier, taken from a course page link"),
        tugas_id: z.int().min(1).describe("Assignment identifier, taken from a meeting page link"),
      },
    },
    withErrors(async ({ pertemuan_id: pertemuanId, tugas_id: tugasId }) =>
      ok(await collectAssignment(pertemuanId, tugasId)),
    ),
  );
}

export function registerSubmissionTools(server) {
  server.registerTool(
    "submit",
    {
      title: "Submit assignment file",
      description: "Upload one local file as the assignment submission. Gated behind the write flag.",
      inputSchema: {
        pertemuan_id: z.int().min(1).describe("Meeting identifier"),
        tugas_id: z.int().min(1).describe("Assignment identifier"),
        file_path: z.string().describe("Absolute local path of the file to upload"),
        description: z.string().optional().describe("Optional text for the submission description field"),
        dry_run: z
          .boolean()
          .optional()
          .describe("When true, build the request and report it without sending anything"),
      },
    },
    withErrors(
      async ({ pertemuan_id: pertemuanId, tugas_id: tugasId, file_path: filePath, description, dry_run: dryRun }) => {
        if (!config.allowWrite) {
          throw new ToolError(
            "write_disabled",
            "pengumpulan dinonaktifkan",
            "set LMS_ALLOW_WRITE=1 lalu /mcp reload",
          );
        }

        const upload = readUpload(filePath);
        const assignment = await collectAssignment(pertemuanId, tugasId);
        const form = assignment.submit_form;
        const fallback = `/pertemuan/${pertemuanId}/tugas/${tugasId}/submit`;
        const action = form && form.action.includes("/tugas/") ? form.action : fallback;

        const page = await getHtml(`/pertemuan/${pertemuanId}/tugas/${tugasId}`);
        ensureOk(page);
        const hiddenPairs = collectHiddenFields(page.body, action);
        const token =
          hiddenPairs.find((pair) => pair.name === "_token")?.value || assignment.csrf_token || tokenFromHtml(page.body);
        if (!token) throw new ToolError("http_error", "csrf token tidak ditemukan pada halaman tugas");

        const fields = submissionFields(form, hiddenPairs, description).map(([name, value]) =>
          name === "_token" ? [name, token] : [name, value],
        );
        if (!fields.some(([name]) => name === "_token")) fields.unshift(["_token", token]);

        const fileField = form?.file_field ?? "file";

        if (dryRun === true) {
          return ok({
            dry_run: true,
            action,
            method: "POST",
            enctype: form?.enctype ?? "multipart/form-data",
            fields: fields.map(([name, value]) => ({ name, value_length: value.length })),
            file: { field: fileField, path: filePath, bytes: upload.bytes.length },
            form_found: form !== null,
          });
        }

        const result = await postMultipart(action, {
          fields,
          file: { field: fileField, filename: upload.filename, bytes: upload.bytes },
          headers: {
            origin: config.origin,
            referer: `${config.baseUrl}/pertemuan/${pertemuanId}/tugas/${tugasId}`,
          },
        });

        const accepted = result.kind === "ok" && result.status < 400;
        const submitted =
          result.body.includes("pengumpulan-tugas/") ||
          (accepted && (await collectAssignment(pertemuanId, tugasId)).submitted);
        const message =
          /id=["'](?:error|success)Toast["'][^>]*>([^<]+)</i.exec(result.body)?.[1]?.trim() ?? null;

        return ok({
          ok: accepted,
          status: result.status,
          final_url: result.finalUrl,
          submitted,
          message,
        });
      },
    ),
  );

  server.registerTool(
    "auth",
    {
      title: "Establish session",
      description:
        "Open a headed browser for a one-time manual sign-in and persist the cookies, or validate a pasted cookie header. Never receives a password.",
      inputSchema: {
        cookie_header: z.string().optional().describe("Optional raw Cookie header copied from a signed-in browser"),
        timeout_seconds: z.int().min(10).optional().describe("Seconds to wait for the manual sign-in, default 240"),
      },
    },
    withErrors(async ({ cookie_header: cookieHeader, timeout_seconds: timeoutSeconds }) => {
      const result = await acquire({ cookieHeader, timeoutSeconds });
      if (result.error) return fail(new ToolError(result.error.code, result.error.message, result.error.hint));
      return ok(result);
    }),
  );
}
