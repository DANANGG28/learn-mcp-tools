#!/usr/bin/env node
// Opens a browser for a one-time manual sign-in, then stores the resulting
// cookies in the state file. No credential is ever read from the terminal.
import { acquire } from "../src/auth.mjs";

const timeoutFlag = process.argv.indexOf("--timeout");
const timeoutSeconds = timeoutFlag >= 0 ? Number(process.argv[timeoutFlag + 1]) : undefined;

const result = await acquire({ timeoutSeconds });
console.log(JSON.stringify(result, null, 2));
process.exit(result.authenticated ? 0 : 1);
