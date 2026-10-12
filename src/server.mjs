#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.mjs";
import { registerReadTools, registerSubmissionTools } from "./tools.mjs";

const server = new McpServer({ name: "learn-mcp-tools", version: "1.0.0" });

registerReadTools(server);
registerSubmissionTools(server);

const transport = new StdioServerTransport();
await server.connect(transport).catch((err) => {
  console.error(`fatal: ${err?.message ?? err}`);
  process.exit(1);
});

process.stderr.write(`learn-mcp-tools ready for ${config.origin} (write=${config.allowWrite})\n`);
