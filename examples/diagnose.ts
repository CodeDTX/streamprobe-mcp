/**
 * Runs the diagnosis against a real stream from the command line.
 *
 *   pnpm example https://example.com/master.m3u8
 *
 * Useful for reproducing a finding without an MCP client in the loop, and it is
 * the quickest way to check a change against a stream you actually have.
 */
import { probeStream } from "../src/probe.js";

const url =
  process.argv[2] ??
  "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8";
const deep = process.argv.includes("--deep");

const result = await probeStream(url, { deep, maxRenditions: 3 });

console.log(
  `${result.model.protocol.toUpperCase()} ${result.model.kind} - ${result.model.renditions.length} renditions`,
);
console.log(`fetched in ${result.fetch.elapsedMs}ms\n`);

for (const finding of result.findings) {
  console.log(`[${finding.severity.toUpperCase()}] ${finding.title}`);
  for (const line of finding.evidence ?? []) console.log(`    ${line}`);
}
if (result.findings.length === 0) console.log("No findings.");
