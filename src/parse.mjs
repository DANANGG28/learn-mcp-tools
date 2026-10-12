import * as cheerio from "cheerio";
import { config } from "./config.mjs";

const TEXT_LIMIT = 20_000;
const HTML_LIMIT = 500_000;

export function clean(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function classifyLink(pathname) {
  if (/^\/akses\//.test(pathname)) return "akses";
  if (/^\/pertemuan\/\d+\/tugas\//.test(pathname)) return "tugas";
  if (/^\/pertemuan\/\d+\/materi\//.test(pathname)) return "materi";
  if (/^\/pertemuan\/\d+\/presensi\//.test(pathname)) return "presensi";
  if (/^\/pertemuan\//.test(pathname)) return "pertemuan";
  if (/^\/(v3|admin|dosen)(\/|$)/.test(pathname)) return "nav";
  return "other";
}

function extractLinks($, pageUrl) {
  const seen = new Set();
  const links = [];
  $("a[href]").each((_, element) => {
    const raw = $(element).attr("href");
    if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) return;
    let url;
    try {
      url = new URL(raw, pageUrl);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.origin !== config.origin) return;
    const href = url.pathname + url.search;
    const text = clean($(element).text());
    const key = `${href}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ href, text, kind: classifyLink(url.pathname) });
  });
  return links;
}

function extractForms($, pageUrl) {
  const forms = [];
  $("form").each((_, element) => {
    const $form = $(element);
    const rawAction = $form.attr("action") ?? "";
    let action = rawAction;
    try {
      const resolved = new URL(rawAction || pageUrl, pageUrl);
      action = resolved.origin === config.origin ? resolved.pathname + resolved.search : resolved.toString();
    } catch {
      action = rawAction;
    }
    const fields = [];
    $form.find("input[name], textarea[name], select[name]").each((__, field) => {
      const $field = $(field);
      const tag = field.tagName.toLowerCase();
      const type = tag === "input" ? ($field.attr("type") ?? "text").toLowerCase() : tag;
      if (type === "submit" || type === "button" || type === "reset") return;
      fields.push({
        name: $field.attr("name"),
        type,
        required: $field.attr("required") !== undefined,
        tag,
      });
    });
    forms.push({
      action,
      method: ($form.attr("method") ?? "GET").toUpperCase(),
      enctype: $form.attr("enctype") ?? "application/x-www-form-urlencoded",
      csrf_present: fields.some((field) => field.name === "_token"),
      fields,
    });
  });
  return forms;
}

function extractTables($) {
  const tables = [];
  $("table").each((_, element) => {
    const $table = $(element);
    const rows = $table.find("tr").toArray();
    let headers = $table
      .find("thead th")
      .toArray()
      .map((cell) => clean($(cell).text()));
    let bodyRows = $table.find("tbody tr").toArray();
    let headerRowIndex = -1;

    if (headers.length === 0) {
      const headRow = rows.find((row) => $(row).find("th").length > 0);
      if (headRow) {
        headerRowIndex = rows.indexOf(headRow);
        headers = $(headRow)
          .find("th")
          .toArray()
          .map((cell) => clean($(cell).text()));
      }
    }
    if (headers.length === 0 && rows.length > 0) {
      const first = rows[0];
      if ($(first).find("td").length > 0) {
        headerRowIndex = 0;
        headers = $(first)
          .find("td")
          .toArray()
          .map((cell) => clean($(cell).text()));
      }
    }

    if (bodyRows.length === 0) {
      bodyRows = rows.filter((row, index) => index > headerRowIndex);
    }

    tables.push({
      headers,
      rows: bodyRows.map((row) =>
        $(row)
          .find("td, th")
          .toArray()
          .map((cell) => clean($(cell).text())),
      ),
    });
  });
  return tables;
}

// Submit needs the literal hidden values the server rendered (CSRF token
// included). The summarize contract stays name/type-only, so this reads the
// form a second time and returns pairs verbatim.
export function collectHiddenFields(html, formAction) {
  const $ = cheerio.load(html ?? "");
  const pairs = [];
  $("form").each((_, element) => {
    const $form = $(element);
    const rawAction = $form.attr("action") ?? "";
    let action = rawAction;
    try {
      const resolved = new URL(rawAction || config.baseUrl, config.baseUrl);
      action = resolved.origin === config.origin ? resolved.pathname + resolved.search : resolved.toString();
    } catch {
      action = rawAction;
    }
    if (action !== formAction) return;
    $form.find('input[type="hidden"][name]').each((__, input) => {
      pairs.push({ name: $(input).attr("name"), value: $(input).attr("value") ?? "" });
    });
  });
  return pairs;
}

export function summarize(html, pageUrl, options = {}) {
  const { includeText = false, includeHtml = false, status = 200, redirects = [] } = options;
  const $ = cheerio.load(html ?? "");

  const headings = $("h1, h2, h3")
    .toArray()
    .map((element) => ({ level: Number(element.tagName.slice(1)), text: clean($(element).text()) }))
    .filter((heading) => heading.text !== "");

  const links = extractLinks($, pageUrl);
  const result = {
    status,
    url: pageUrl,
    redirects,
    title: clean($("title").first().text()),
    headings,
    links,
    forms: extractForms($, pageUrl),
    tables: extractTables($),
    files: (() => {
      const seen = new Set();
      const files = [];
      for (const link of links) {
        if (link.kind !== "akses" || seen.has(link.href)) continue;
        seen.add(link.href);
        files.push({
          filename: decodeURIComponent(link.href.split("?")[0].split("/").pop() ?? ""),
          href: link.href,
        });
      }
      return files;
    })(),
    csrfToken: $('meta[name="csrf-token"]').attr("content") ?? null,
  };

  if (includeText) {
    const text = clean($("body").text());
    result.text = text.slice(0, TEXT_LIMIT);
    result.text_truncated = text.length > TEXT_LIMIT;
  }
  if (includeHtml) {
    result.html = (html ?? "").slice(0, HTML_LIMIT);
    result.html_truncated = (html ?? "").length > HTML_LIMIT;
  }
  return result;
}
