#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.mjs";
import { redact } from "./redact.mjs";
import { registerReadTools, registerSubmissionTools } from "./tools.mjs";

// Every byte written to stdout/stderr passes through redaction first, so a
// session value can never leak through a log line or a stack trace.
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function wrapWrite(original) {
  return (chunk, ...rest) => original(typeof chunk === "string" ? redact(chunk) : chunk, ...rest);
}

process.stdout.write = wrapWrite(originalStdoutWrite);
process.stderr.write = wrapWrite(originalStderrWrite);

const server = new McpServer({ name: "learn-mcp-tools", version: "1.0.0" });

registerReadTools(server);
registerSubmissionTools(server);

const transport = new StdioServerTransport();
await server.connect(transport).catch((err) => {
  console.error(`fatal: ${err?.message ?? err}`);
  process.exit(1);
});

console.error(`learn-mcp-tools ready for ${config.origin} (write=${config.allowWrite})`);
