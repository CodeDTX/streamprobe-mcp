import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkSegments, probeStream } from "./probe.js";
import { FetchError } from "./fetch.js";
import type { Finding, StreamModel } from "./types.js";

/**
 * Tool surface.
 *
 * Four tools, not fourteen. An agent choosing between many near-identical
 * tools picks badly, and every one of these answers a question an engineer
 * actually asks out loud: what is this, what is wrong with it, how is it
 * protected, and are the segments really there.
 *
 * Every tool returns text rather than JSON blobs. The consumer is a language
 * model relaying to a human, and a readable report survives that trip; a
 * nested object gets summarised into vagueness.
 */

const urlArg = z.string().url().describe("Absolute URL of an HLS .m3u8 or DASH .mpd manifest");

const headersArg = z
  .record(z.string())
  .optional()
  .describe("Extra request headers, for CDN tokens or a required Referer");

function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return "No problems found.";
  const icon = { error: "ERROR", warning: "WARN ", info: "INFO " } as const;
  return findings
    .map((f) => {
      const lines = [`[${icon[f.severity]}] ${f.title}`, `  ${f.detail}`];
      for (const line of f.evidence ?? []) lines.push(`  - ${line}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function renderModel(model: StreamModel): string {
  const video = model.renditions.filter((r) => r.contentType === "video");
  const audio = model.renditions.filter((r) => r.contentType === "audio");
  const text = model.renditions.filter((r) => r.contentType === "text");

  const lines = [
    `Protocol:    ${model.protocol.toUpperCase()}${model.version ? ` (${model.version})` : ""}`,
    // "unknown" is honest for a master playlist, which genuinely does not say,
    // but on its own it reads like a failure rather than a consequence.
    `Type:        ${model.kind === "unknown" ? "unknown (the media playlists decide; use deep=true)" : model.kind}`,
    `Structure:   ${model.multivariant ? "multivariant" : "single playlist"}`,
    `Renditions:  ${video.length} video, ${audio.length} audio, ${text.length} text`,
  ];

  if (model.drm.length > 0) {
    lines.push(`Protection:  ${model.drm.map((d) => d.name ?? d.systemId).join(", ")}`);
  } else {
    lines.push("Protection:  none declared");
  }
  if (model.adMarkers.length > 0) lines.push(`Ad markers:  ${model.adMarkers.length}`);
  if (model.minimumUpdatePeriod !== undefined) {
    lines.push(`MPD refresh: every ${model.minimumUpdatePeriod}s`);
  }

  if (video.length > 0) {
    lines.push("", "Video ladder:");
    for (const r of [...video].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0))) {
      const size = r.width && r.height ? `${r.width}x${r.height}` : "unknown size";
      const rate = r.bandwidth ? `${Math.round(r.bandwidth / 1000)} kbps` : "no bandwidth";
      lines.push(`  ${size.padEnd(11)} ${rate.padEnd(12)} ${r.codecs ?? "no codecs"}`);
    }
  }

  if (audio.length > 0) {
    lines.push("", "Audio:");
    for (const r of audio) {
      lines.push(
        `  ${(r.language ?? "und").padEnd(6)} ${r.codecs ?? "no codecs"} ${r.group ? `group=${r.group}` : ""}`,
      );
    }
  }

  const segments = Object.entries(model.segments);
  if (segments.length > 0) {
    lines.push("", "Segments:");
    for (const [id, seg] of segments) {
      lines.push(
        `  ${shorten(id)}: ${seg.count} segments, ${seg.totalDuration.toFixed(1)}s` +
          (seg.targetDuration ? `, target ${seg.targetDuration}s` : "") +
          (seg.discontinuities ? `, ${seg.discontinuities} discontinuities` : "") +
          (seg.endList ? ", ENDLIST" : ""),
      );
    }
  }

  return lines.join("\n");
}

function shorten(id: string): string {
  if (id.length <= 48) return id;
  return `...${id.slice(-45)}`;
}

function errorText(error: unknown): string {
  if (error instanceof FetchError) {
    return `Could not read the manifest.\n\n  URL:    ${error.url}\n  Reason: ${error.message}`;
  }
  return `Failed: ${error instanceof Error ? error.message : String(error)}`;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "streamprobe-mcp", version: "0.1.0" });

  server.registerTool(
    "diagnose_stream",
    {
      title: "Diagnose an HLS or DASH stream",
      description:
        "Fetch a manifest and report what is wrong with it, worst first. Start here when a " +
        "stream misbehaves and you do not yet know why. Set deep to also read each rendition's " +
        "media playlist, which is required to catch segment timing and live window problems.",
      inputSchema: {
        url: urlArg,
        deep: z
          .boolean()
          .optional()
          .describe("Also fetch media playlists. One extra request per rendition. Default false."),
        maxRenditions: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("Cap on playlists read when deep. Default 6."),
        headers: headersArg,
      },
    },
    async ({ url, deep, maxRenditions, headers }) => {
      try {
        const result = await probeStream(url, { deep, maxRenditions, headers });
        const counts = result.findings.reduce<Record<string, number>>((acc, f) => {
          acc[f.severity] = (acc[f.severity] ?? 0) + 1;
          return acc;
        }, {});
        const summary =
          `${counts["error"] ?? 0} errors, ${counts["warning"] ?? 0} warnings, ${counts["info"] ?? 0} notes` +
          (deep ? "" : "  (shallow read: pass deep=true for segment and live window checks)");

        return {
          content: [
            {
              type: "text" as const,
              text: [renderModel(result.model), "", summary, "", renderFindings(result.findings)].join("\n"),
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    "describe_stream",
    {
      title: "Describe a stream without judging it",
      description:
        "The facts only: protocol, live or VOD, the rendition ladder, codecs, audio and subtitle " +
        "tracks, protection and ad markers. Use when you want to know what a stream is rather " +
        "than what is wrong with it.",
      inputSchema: { url: urlArg, headers: headersArg },
    },
    async ({ url, headers }) => {
      try {
        const result = await probeStream(url, { headers });
        return {
          content: [
            {
              type: "text" as const,
              text: [
                renderModel(result.model),
                "",
                `Fetched in ${result.fetch.elapsedMs}ms, HTTP ${result.fetch.status}` +
                  (result.fetch.finalUrl !== url ? `, redirected to ${result.fetch.finalUrl}` : ""),
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    "inspect_drm",
    {
      title: "Inspect stream protection",
      description:
        "Report the DRM systems, key identifiers and license URIs a manifest declares. Reads the " +
        "manifest only: it never requests a license or attempts decryption.",
      inputSchema: { url: urlArg, headers: headersArg },
    },
    async ({ url, headers }) => {
      try {
        const result = await probeStream(url, { headers });
        if (result.model.drm.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "No protection declared in this manifest.\n\nFor HLS, note that EXT-X-KEY lives in the " +
                  "media playlists, so a master playlist alone can look unprotected. Re-run diagnose_stream " +
                  "with deep=true to read them.",
              },
            ],
          };
        }
        const lines = result.model.drm.map((d) =>
          [
            `${d.name ?? "Unrecognised system"}`,
            `  system id: ${d.systemId}`,
            `  scheme:    ${d.scheme}`,
            d.keyIds.length ? `  key ids:   ${d.keyIds.join(", ")}` : null,
            d.uri ? `  uri:       ${d.uri}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
        return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    "check_segments",
    {
      title: "Check that segments are really there",
      description:
        "Request the newest few segments of the first rendition and report failures and timings. " +
        "Answers the case where the manifest is valid but the media behind it is missing or slow. " +
        "Uses HEAD where the CDN allows it.",
      inputSchema: {
        url: urlArg,
        sample: z.number().int().min(1).max(20).optional().describe("How many segments to probe. Default 5."),
        headers: headersArg,
      },
    },
    async ({ url, sample, headers }) => {
      try {
        const result = await checkSegments(url, { sample, headers });
        if (result.checked === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No segment URLs found to probe. Is this a master playlist with unreadable renditions?",
              },
            ],
          };
        }
        const lines = [
          `Probed ${result.checked} segments.`,
          result.failures.length === 0
            ? "All returned successfully."
            : `${result.failures.length} failed:\n` +
              result.failures.map((f) => `  ${f.status || f.method}  ${f.url}`).join("\n"),
        ];
        if (result.slowest) {
          lines.push(`Slowest: ${result.slowest.elapsedMs}ms  ${result.slowest.url}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
      }
    },
  );

  return server;
}
