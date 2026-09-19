import { runChecks } from "./checks/index.js";
import { dedupeDrm } from "./drm.js";
import { isMpd, parseMpd } from "./dash/parse.js";
import { FetchError, fetchText, probeUrl, type FetchOptions } from "./fetch.js";
import { isMaster, parseMaster, parseMedia } from "./hls/parse.js";
import type { Finding, StreamModel } from "./types.js";

/**
 * Fetch, parse, diagnose.
 *
 * `deep` is the important switch. Shallow reads only the top-level document,
 * which is one request and enough for ladder and DRM questions. Deep also
 * fetches media playlists, which is where segment timing and live-window
 * problems live, but costs one request per rendition. A twelve-rendition
 * ladder is twelve requests, so it is opt-in rather than the default.
 */

export interface ProbeOptions extends FetchOptions {
  /** Fetch each rendition's media playlist too. Default false. */
  deep?: boolean;
  /** Cap on media playlists fetched when deep. Default 6. */
  maxRenditions?: number;
}

export interface ProbeResult {
  model: StreamModel;
  findings: Finding[];
  fetch: { status: number; finalUrl: string; elapsedMs: number; contentType?: string };
  /** Renditions whose media playlist could not be read, with the reason. */
  unreadable: Array<{ id: string; reason: string }>;
}

export async function probeStream(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const top = await fetchText(url, options);

  if (top.status >= 400) {
    throw new FetchError(`Manifest returned HTTP ${top.status}`, url, top.status);
  }

  const model = parseTop(top.finalUrl, top.body);
  const unreadable: Array<{ id: string; reason: string }> = [];

  if (options.deep && model.protocol === "hls" && model.multivariant) {
    const limit = options.maxRenditions ?? 6;
    const targets = model.renditions.filter((r) => r.url).slice(0, limit);

    // Sequential rather than parallel: the point of this tool is often a
    // struggling origin, and firing a dozen simultaneous requests at one is
    // both rude and a good way to measure your own thundering herd.
    for (const rendition of targets) {
      try {
        const media = await fetchText(rendition.url!, options);
        if (media.status >= 400) {
          unreadable.push({ id: rendition.id, reason: `HTTP ${media.status}` });
          continue;
        }
        const parsed = parseMedia(media.finalUrl, media.body);
        model.segments[rendition.id] = parsed.segments;
        model.drm.push(...parsed.drm);
        model.adMarkers.push(...parsed.adMarkers);
        // The media playlists decide live versus VOD; the master cannot.
        if (model.kind === "unknown") model.kind = parsed.kind;
      } catch (error) {
        unreadable.push({
          id: rendition.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  model.drm = dedupeDrm(model.drm);

  const findings = runChecks({ model, deep: Boolean(options.deep) });

  if (unreadable.length > 0) {
    findings.unshift({
      id: "rendition-unreadable",
      severity: "error",
      title: `${unreadable.length} rendition playlist(s) could not be read`,
      detail:
        "The master lists these renditions but their playlists did not load. A player that picks " +
        "one of them gets the same failure.",
      evidence: unreadable.map((u) => `${u.id}: ${u.reason}`),
      renditions: unreadable.map((u) => u.id),
    });
  }

  return {
    model,
    findings,
    fetch: {
      status: top.status,
      finalUrl: top.finalUrl,
      elapsedMs: top.elapsedMs,
      contentType: top.headers["content-type"],
    },
    unreadable,
  };
}

/** Sniffs the protocol from the body rather than the extension, which lies. */
export function parseTop(url: string, body: string): StreamModel {
  if (isMpd(body)) return parseMpd(url, body);

  if (body.trimStart().startsWith("#EXTM3U")) {
    if (isMaster(body)) return parseMaster(url, body);
    const media = parseMedia(url, body);
    return {
      url,
      protocol: "hls",
      kind: media.kind,
      multivariant: false,
      renditions: [],
      drm: media.drm,
      adMarkers: media.adMarkers,
      segments: { [url]: media.segments },
      raw: body,
    };
  }

  throw new FetchError(
    "Body is neither an m3u8 playlist nor a DASH MPD. " + `First bytes: ${JSON.stringify(body.slice(0, 80))}`,
    url,
  );
}

/**
 * Checks that segments actually exist.
 *
 * Separate from probeStream because it is the only operation here that touches
 * media URLs, and it is the one an engineer should be able to decline: on a
 * live stream with a short window these requests race the packager.
 */
export async function checkSegments(
  url: string,
  options: ProbeOptions & { sample?: number } = {},
): Promise<{
  checked: number;
  failures: Array<{ url: string; status: number; method: string }>;
  slowest: { url: string; elapsedMs: number } | null;
}> {
  const result = await probeStream(url, { ...options, deep: true, maxRenditions: 1 });
  const first = Object.values(result.model.segments)[0];
  if (!first || first.sampleUrls.length === 0) {
    return { checked: 0, failures: [], slowest: null };
  }

  const sample = Math.max(1, Math.min(options.sample ?? 5, first.sampleUrls.length));
  // The newest segments matter most on live: those are the ones a joining
  // player asks for first, and the ones a packager is most likely to be late on.
  const urls = first.sampleUrls.slice(-sample);

  const failures: Array<{ url: string; status: number; method: string }> = [];
  let slowest: { url: string; elapsedMs: number } | null = null;

  for (const segmentUrl of urls) {
    const probe = await probeUrl(segmentUrl, options);
    if (!probe.ok) failures.push({ url: probe.url, status: probe.status, method: probe.method });
    if (!slowest || probe.elapsedMs > slowest.elapsedMs) {
      slowest = { url: probe.url, elapsedMs: probe.elapsedMs };
    }
  }

  return { checked: urls.length, failures, slowest };
}
