/**
 * Library entry point.
 *
 * The diagnostics are useful outside an agent: in CI, in a monitoring job, or
 * from a plain script. Nothing here depends on the MCP SDK, so importing the
 * package does not drag a server into a build that only wanted the parser.
 */
export { probeStream, checkSegments, parseTop, type ProbeOptions, type ProbeResult } from "./probe.js";
export { runChecks, CHECKS } from "./checks/index.js";
export { parseMaster, parseMedia, parseAttributes, isMaster } from "./hls/parse.js";
export { parseMpd, parseDuration, isMpd } from "./dash/parse.js";
export { identifyDrm, systemName, extractSystemId, dedupeDrm } from "./drm.js";
export { fetchText, probeUrl, resolveUrl, FetchError } from "./fetch.js";
export type * from "./types.js";
