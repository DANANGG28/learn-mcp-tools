#!/usr/bin/env node
// Exercises the read-only tools against one real meeting and assignment.
// Prints one line per HTTP request so the run stays auditable.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerReadTools, registerSubmissionTools } from "../src/tools.mjs";
import { setRequestObserver } from "../src/client.mjs";

setRequestObserver((method, resourcePath) => console.log(`${method} ${resourcePath}`));

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const pertemuanId = Number(flag("pertemuan", 0));
const tugasId = Number(flag("tugas", 0));
const dryRunSubmit = flag("dry-run-submit", false) === true;
const filePath = flag("file", null);

const server = new McpServer({ name: "learn-mcp-tools", version: "1.0.0" });
registerReadTools(server);
registerSubmissionTools(server);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "read-smoke", version: "1.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((part) => part.text).join("\n");
  return { result, text };
}

const report = {};

const status = await call("status", {});
report.status = JSON.parse(status.text);
console.log("status:", JSON.stringify(report.status));

const negative = {};
negative.bad_path = JSON.parse((await call("page", { path: "https://evil.example/x" })).text);
negative.bad_download = JSON.parse((await call("download", { path: "/v3/dashboard" })).text);
if (Number.isInteger(pertemuanId) && pertemuanId > 0 && Number.isInteger(tugasId) && tugasId > 0) {
  if (report.status.authenticated !== true) {
    negative.assignment_without_session = JSON.parse(
      (await call("assignment", { pertemuan_id: pertemuanId, tugas_id: tugasId })).text,
    );
  }
  if (process.env.LMS_ALLOW_WRITE !== "1") {
    negative.write_disabled = JSON.parse(
      (
        await call("submit", {
          pertemuan_id: pertemuanId,
          tugas_id: tugasId,
          file_path: filePath ?? "/tmp/dummy.pdf",
          dry_run: true,
        })
      ).text,
    );
  }
}
report.negative = negative;
console.log("negative:", JSON.stringify(negative));

if (report.status.authenticated !== true) {
  console.log("read path skipped: no usable session");
} else {
  const dashboard = await call("page", { path: "/v3/dashboard" });
  const dashboardData = JSON.parse(dashboard.text);
  report.dashboard = {
    url: dashboardData.url,
    title: dashboardData.title,
    link_count: dashboardData.links.length,
    kinds: [...new Set(dashboardData.links.map((link) => link.kind))],
  };
  console.log("dashboard:", JSON.stringify(report.dashboard));

  if (Number.isInteger(pertemuanId) && pertemuanId > 0 && Number.isInteger(tugasId) && tugasId > 0) {
    const assignment = await call("assignment", { pertemuan_id: pertemuanId, tugas_id: tugasId });
    report.assignment = JSON.parse(assignment.text);
    console.log(
      "assignment:",
      JSON.stringify({
        url: report.assignment.url,
        title: report.assignment.title,
        submitted: report.assignment.submitted,
        submissions: report.assignment.submissions,
        deadline_text: report.assignment.deadline_text,
        submit_form: report.assignment.submit_form && {
          action: report.assignment.submit_form.action,
          method: report.assignment.submit_form.method,
          enctype: report.assignment.submit_form.enctype,
          csrf_present: report.assignment.submit_form.csrf_present,
          file_field: report.assignment.submit_form.file_field,
          fields: report.assignment.submit_form.fields,
        },
        files: report.assignment.files,
      }),
    );

    if (dryRunSubmit && filePath) {
      const submit = await call("submit", {
        pertemuan_id: pertemuanId,
        tugas_id: tugasId,
        file_path: filePath,
        dry_run: true,
      });
      report.submit = JSON.parse(submit.text);
      console.log("submit:", JSON.stringify(report.submit));
    }
  }
}

await client.close();
await server.close();
