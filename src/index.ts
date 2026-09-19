#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * stdio entry point, which is what `npx streamprobe-mcp` runs.
 *
 * Nothing may be written to stdout except protocol frames: stdout *is* the
 * transport, and a stray console.log corrupts the stream in a way that
 * presents as an unhelpful client-side parse error. Diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("streamprobe-mcp ready on stdio\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`streamprobe-mcp failed to start: ${String(error)}\n`);
  process.exit(1);
});
