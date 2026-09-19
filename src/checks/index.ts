import type { Check, CheckContext, Finding, Rendition } from "../types.js";

/**
 * The diagnostics.
 *
 * Every check works on the normalised model, so each one covers HLS and DASH
 * at once. Three rules they all follow:
 *
 * 1. Quote the evidence. A finding an engineer cannot verify against their own
 *    manifest is a finding they have to take on trust, and they will not.
 * 2. Say why it matters, in player behaviour. "Segment exceeds target
 *    duration" means nothing; "players size their buffer on this and may
 *    stall" is the reason anyone should care.
 * 3. Never guess at intent. Where a manifest is unusual rather than wrong, the
 *    severity is `warning` or `info`, and the wording says it is worth a look
 *    rather than that it is broken.
 */

function videoOf(ctx: CheckContext): Rendition[] {
  return ctx.model.renditions.filter((r) => r.contentType === "video");
}

const missingCodecs: Check = {
  id: "ladder-missing-codecs",
  applies: (ctx) => ctx.model.renditions.length > 0,
  run: (ctx) => {
    // Only selectable variants are in scope. CODECS is required on HLS
    // EXT-X-STREAM-INF and carried by every DASH Representation, both of which
    // declare a bandwidth. An EXT-X-MEDIA entry legitimately omits it, because
    // the variant that references the group declares the codec for it, and
    // flagging those was this check failing on correct manifests.
    const offenders = ctx.model.renditions.filter(
      (r) =>
        r.bandwidth !== undefined && (r.contentType === "video" || r.contentType === "audio") && !r.codecs,
    );
    if (offenders.length === 0) return [];
    return [
      {
        id: "ladder-missing-codecs",
        severity: "error",
        title: "Renditions declare no codecs",
        detail:
          "A player decides what it can play from the codec string before fetching anything. " +
          "Without it, clients either probe a segment first, which delays startup, or skip the " +
          "rendition entirely. On HLS, CODECS is required on EXT-X-STREAM-INF for exactly this reason.",
        evidence: offenders.slice(0, 8).map((r) => `${r.id} has no codecs declared`),
        renditions: offenders.map((r) => r.id),
      },
    ];
  },
};

const bitrateOrder: Check = {
  id: "ladder-bitrate-duplicates",
  applies: (ctx) => videoOf(ctx).length > 1,
  run: (ctx) => {
    const video = videoOf(ctx).filter((r) => r.bandwidth !== undefined);
    const seen = new Map<number, string[]>();
    for (const r of video) {
      const list = seen.get(r.bandwidth!) ?? [];
      list.push(r.id);
      seen.set(r.bandwidth!, list);
    }
    const duplicates = [...seen.entries()].filter(([, ids]) => ids.length > 1);
    if (duplicates.length === 0) return [];
    return [
      {
        id: "ladder-bitrate-duplicates",
        severity: "warning",
        title: "Two renditions share a bitrate",
        detail:
          "Adaptive logic picks by bandwidth. Renditions that declare the same value are not " +
          "distinguishable to the player, so one of them will usually never be selected.",
        evidence: duplicates.map(([bw, ids]) => `${bw} bps declared by ${ids.length}: ${ids.join(", ")}`),
        renditions: duplicates.flatMap(([, ids]) => ids),
      },
    ];
  },
};

const resolutionInversion: Check = {
  id: "ladder-resolution-inversion",
  applies: (ctx) => videoOf(ctx).filter((r) => r.height && r.bandwidth).length > 1,
  run: (ctx) => {
    const video = videoOf(ctx)
      .filter((r) => r.height && r.bandwidth)
      .sort((a, b) => a.bandwidth! - b.bandwidth!);
    const inversions: string[] = [];
    for (let i = 1; i < video.length; i += 1) {
      const lower = video[i - 1]!;
      const higher = video[i]!;
      if (higher.height! < lower.height!) {
        inversions.push(
          `${higher.id} is ${higher.height}p at ${higher.bandwidth} bps, above ${lower.id} at ${lower.height}p / ${lower.bandwidth} bps`,
        );
      }
    }
    if (inversions.length === 0) return [];
    return [
      {
        id: "ladder-resolution-inversion",
        severity: "warning",
        title: "Ladder spends more bitrate on a smaller picture",
        detail:
          "A rendition higher up the bitrate ladder has a lower resolution than the one below it. " +
          "Viewers who step up will pay more bandwidth for a smaller picture. Usually an encoder " +
          "profile mistake, occasionally deliberate for a high-frame-rate or HDR variant.",
        evidence: inversions.slice(0, 8),
      },
    ];
  },
};

const singleRendition: Check = {
  id: "ladder-single-rendition",
  applies: (ctx) => ctx.model.multivariant,
  run: (ctx) => {
    const video = videoOf(ctx);
    if (video.length !== 1) return [];
    return [
      {
        id: "ladder-single-rendition",
        severity: "info",
        title: "Only one video rendition",
        detail:
          "There is nothing for adaptive bitrate to switch between, so a viewer whose bandwidth " +
          "drops will rebuffer rather than step down. Fine if intentional.",
        evidence: [`${video[0]!.id} at ${video[0]!.bandwidth ?? "unknown"} bps`],
      },
    ];
  },
};

const noAudio: Check = {
  id: "ladder-no-audio",
  applies: (ctx) => ctx.model.multivariant && videoOf(ctx).length > 0,
  run: (ctx) => {
    const hasAudio = ctx.model.renditions.some((r) => r.contentType === "audio");
    // Muxed HLS variants carry audio inside the video rendition, and declare it
    // in CODECS, so a ladder with an audio codec listed is not silent.
    const muxedAudio = videoOf(ctx).some((r) => /mp4a|ac-3|ec-3|opus|flac/i.test(r.codecs ?? ""));
    if (hasAudio || muxedAudio) return [];
    return [
      {
        id: "ladder-no-audio",
        severity: "warning",
        title: "No audio found",
        detail:
          "No separate audio rendition, and no audio codec declared on any video rendition. " +
          "Either the stream is genuinely silent or the audio codec is missing from CODECS.",
      },
    ];
  },
};

const orphanAudioGroup: Check = {
  id: "hls-audio-group-unresolved",
  applies: (ctx) => ctx.model.protocol === "hls",
  run: (ctx) => {
    const groups = new Set(
      ctx.model.renditions.filter((r) => r.contentType !== "video" && r.group).map((r) => r.group!),
    );
    const orphans = videoOf(ctx).filter((r) => r.group && !groups.has(r.group));
    if (orphans.length === 0) return [];
    return [
      {
        id: "hls-audio-group-unresolved",
        severity: "error",
        title: "Variant points at a rendition group that does not exist",
        detail:
          "A variant references an AUDIO or VIDEO group with no matching EXT-X-MEDIA entry. " +
          "Players resolving that group find nothing and typically fail the variant outright.",
        evidence: orphans.slice(0, 8).map((r) => `${r.id} references group "${r.group}"`),
        renditions: orphans.map((r) => r.id),
      },
    ];
  },
};

const segmentOverTarget: Check = {
  id: "segment-exceeds-target-duration",
  applies: (ctx) => ctx.deep && Object.keys(ctx.model.segments).length > 0,
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const [id, seg] of Object.entries(ctx.model.segments)) {
      if (!seg.targetDuration || !seg.maxDuration) continue;
      // The spec rounds to the nearest integer, so only a whole second over is
      // a real violation rather than a rounding artefact.
      if (seg.maxDuration <= seg.targetDuration + 0.5) continue;
      findings.push({
        id: "segment-exceeds-target-duration",
        severity: "error",
        title: "A segment is longer than the declared target duration",
        detail:
          "EXT-X-TARGETDURATION is an upper bound, not an average, and players size their buffer " +
          "and reload cadence from it. Segments over it are a spec violation and a common cause " +
          "of stalls on live.",
        evidence: [
          `${id}: longest segment ${seg.maxDuration.toFixed(3)}s against target ${seg.targetDuration}s`,
        ],
        renditions: [id],
      });
    }
    return findings;
  },
};

const shortDvrWindow: Check = {
  id: "live-dvr-window-short",
  applies: (ctx) => ctx.deep && ctx.model.kind === "live",
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const [id, seg] of Object.entries(ctx.model.segments)) {
      if (!seg.targetDuration || seg.totalDuration === 0) continue;
      const segmentsInWindow = seg.totalDuration / seg.targetDuration;
      if (segmentsInWindow >= 3) continue;
      findings.push({
        id: "live-dvr-window-short",
        severity: "warning",
        title: "Live window holds fewer than three segments",
        detail:
          "HLS asks for at least three target durations of media in a live playlist. Below that, " +
          "a client that reloads a moment late finds its next segment already gone and stalls.",
        evidence: [
          `${id}: ${seg.count} segments, ${seg.totalDuration.toFixed(1)}s total, target ${seg.targetDuration}s`,
        ],
        renditions: [id],
      });
    }
    return findings;
  },
};

const vodMissingEndlist: Check = {
  id: "vod-missing-endlist",
  applies: (ctx) => ctx.deep && Object.keys(ctx.model.segments).length > 0,
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const [id, seg] of Object.entries(ctx.model.segments)) {
      if (seg.endList || ctx.model.kind !== "vod") continue;
      findings.push({
        id: "vod-missing-endlist",
        severity: "warning",
        title: "Playlist declares VOD but has no EXT-X-ENDLIST",
        detail:
          "PLAYLIST-TYPE is VOD but the playlist never terminates, so players keep polling for " +
          "segments that will never arrive and the scrub bar never settles.",
        evidence: [`${id}: ${seg.count} segments, no EXT-X-ENDLIST`],
        renditions: [id],
      });
    }
    return findings;
  },
};

const drmConsistency: Check = {
  id: "drm-partial-protection",
  applies: (ctx) => ctx.model.drm.length > 0,
  run: (ctx) => {
    const names = [...new Set(ctx.model.drm.map((d) => d.name ?? d.systemId))];
    const findings: Finding[] = [
      {
        id: "drm-present",
        severity: "info",
        title: `Protected by ${names.join(", ")}`,
        detail:
          "Key identifiers and license URIs below are read from the manifest only. This tool does " +
          "not request a license or attempt decryption.",
        evidence: ctx.model.drm.map(
          (d) =>
            `${d.name ?? "unrecognised"} (${d.systemId})` +
            (d.keyIds.length ? ` keyIds: ${d.keyIds.join(", ")}` : "") +
            (d.uri ? ` uri: ${d.uri}` : ""),
        ),
      },
    ];

    const unrecognised = ctx.model.drm.filter((d) => d.name === null);
    if (unrecognised.length > 0) {
      findings.push({
        id: "drm-unrecognised-system",
        severity: "warning",
        title: "Unrecognised protection system",
        detail:
          "A ContentProtection or KEYFORMAT entry carries a system id this tool does not know. " +
          "Worth confirming it is intentional, since clients that do not know it will skip it too.",
        evidence: unrecognised.map((d) => d.scheme),
      });
    }
    return findings;
  },
};

const dashUpdatePeriod: Check = {
  id: "dash-missing-update-period",
  applies: (ctx) => ctx.model.protocol === "dash" && ctx.model.kind === "live",
  run: (ctx) => {
    if (ctx.model.minimumUpdatePeriod !== undefined) return [];
    return [
      {
        id: "dash-missing-update-period",
        severity: "warning",
        title: "Dynamic MPD declares no minimumUpdatePeriod",
        detail:
          "The MPD is dynamic, so clients must refresh it, but nothing tells them how often. " +
          "Players fall back to their own heuristics, which is how one client sits on a stale " +
          "manifest while another hammers the origin.",
      },
    ];
  },
};

export const CHECKS: Check[] = [
  missingCodecs,
  bitrateOrder,
  resolutionInversion,
  singleRendition,
  noAudio,
  orphanAudioGroup,
  segmentOverTarget,
  shortDvrWindow,
  vodMissingEndlist,
  drmConsistency,
  dashUpdatePeriod,
];

const ORDER = { error: 0, warning: 1, info: 2 } as const;

/** Runs every applicable check and returns findings worst-first. */
export function runChecks(ctx: CheckContext): Finding[] {
  const findings: Finding[] = [];
  for (const check of CHECKS) {
    if (!check.applies(ctx)) continue;
    try {
      findings.push(...check.run(ctx));
    } catch (error) {
      // One bad check must not take the whole diagnosis down. The caller still
      // gets every other finding, plus a note that this one failed.
      findings.push({
        id: "check-failed",
        severity: "info",
        title: `Check "${check.id}" could not run`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
