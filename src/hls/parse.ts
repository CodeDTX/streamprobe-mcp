import { resolveUrl } from "../fetch.js";
import { identifyDrm } from "../drm.js";
import type { AdMarker, DrmSystem, Rendition, SegmentInfo, StreamModel } from "../types.js";

/**
 * HLS parsing, to the depth diagnostics need.
 *
 * Not a general m3u8 library. It reads what the checks reason about and keeps
 * the raw line beside every finding, because "your CODECS attribute is wrong"
 * is only useful next to the attribute.
 *
 * Tags are parsed leniently on purpose. A malformed manifest is the normal
 * input here, so the parser records what it found and lets checks judge it,
 * rather than throwing and leaving the engineer with a stack trace instead of
 * a diagnosis.
 */

/** Splits an HLS attribute list, respecting quoted values that contain commas. */
export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = "";
  let value = "";
  let inKey = true;
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inKey) {
      if (ch === "=") inKey = false;
      else key += ch;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out[key.trim()] = value;
      key = "";
      value = "";
      inKey = true;
      continue;
    }
    value += ch;
  }
  if (key.trim()) out[key.trim()] = value;
  return out;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function contentTypeOf(codecs: string | undefined, hasResolution: boolean): Rendition["contentType"] {
  if (hasResolution) return "video";
  if (!codecs) return "unknown";
  const list = codecs.split(",").map((c) => c.trim().toLowerCase());
  const video = list.some((c) => /^(avc|hvc|hev|vp0?9|av01|dvh)/.test(c));
  const audio = list.some((c) => /^(mp4a|ac-3|ec-3|opus|flac)/.test(c));
  if (video) return "video";
  if (audio) return "audio";
  return "unknown";
}

export function isMaster(body: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(body) || /^#EXT-X-MEDIA:/m.test(body);
}

export function parseMaster(url: string, body: string): StreamModel {
  const lines = body.split(/\r?\n/);
  const renditions: Rendition[] = [];
  const drm: DrmSystem[] = [];
  let version: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();

    if (line.startsWith("#EXT-X-VERSION:")) {
      version = line.slice("#EXT-X-VERSION:".length).trim();
      continue;
    }

    if (line.startsWith("#EXT-X-SESSION-KEY:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-SESSION-KEY:".length));
      const system = identifyDrm(attrs["KEYFORMAT"] ?? "identity", attrs["URI"], attrs["KEYID"]);
      if (system) drm.push(system);
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      const type = (attrs["TYPE"] ?? "").toUpperCase();
      const uri = attrs["URI"];
      renditions.push({
        id: uri ? resolveUrl(url, uri) : `${type}:${attrs["NAME"] ?? attrs["GROUP-ID"] ?? "media"}`,
        url: uri ? resolveUrl(url, uri) : undefined,
        contentType: type === "AUDIO" ? "audio" : type === "SUBTITLES" ? "text" : "unknown",
        group: attrs["GROUP-ID"],
        language: attrs["LANGUAGE"],
        codecs: attrs["CODECS"],
      });
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      // The URI is the next line that is neither blank nor a comment.
      let uri: string | undefined;
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j]!.trim();
        if (!candidate || candidate.startsWith("#")) continue;
        uri = candidate;
        break;
      }
      const resolution = attrs["RESOLUTION"];
      const [w, h] = resolution ? resolution.split("x").map((n) => Number(n)) : [undefined, undefined];
      renditions.push({
        id: uri ? resolveUrl(url, uri) : `variant-${renditions.length}`,
        url: uri ? resolveUrl(url, uri) : undefined,
        bandwidth: num(attrs["BANDWIDTH"]),
        averageBandwidth: num(attrs["AVERAGE-BANDWIDTH"]),
        width: Number.isFinite(w) ? w : undefined,
        height: Number.isFinite(h) ? h : undefined,
        frameRate: num(attrs["FRAME-RATE"]),
        codecs: attrs["CODECS"],
        contentType: contentTypeOf(attrs["CODECS"], Boolean(resolution)),
        group: attrs["AUDIO"] ?? attrs["VIDEO"],
      });
    }
  }

  return {
    url,
    protocol: "hls",
    // A master playlist carries no PLAYLIST-TYPE of its own; the media
    // playlists decide, so this stays unknown until one is read.
    kind: "unknown",
    multivariant: true,
    renditions,
    drm,
    adMarkers: [],
    segments: {},
    version,
    raw: body,
  };
}

export function parseMedia(
  url: string,
  body: string,
): { segments: SegmentInfo; drm: DrmSystem[]; adMarkers: AdMarker[]; kind: StreamModel["kind"] } {
  const lines = body.split(/\r?\n/);
  const drm: DrmSystem[] = [];
  const adMarkers: AdMarker[] = [];
  const sampleUrls: string[] = [];

  let count = 0;
  let targetDuration: number | undefined;
  let maxDuration = 0;
  let totalDuration = 0;
  let mediaSequence: number | undefined;
  let discontinuities = 0;
  let endList = false;
  let playlistType: string | undefined;
  let pendingDuration: number | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = num(line.slice("#EXT-X-TARGETDURATION:".length).trim());
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = num(line.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim());
    } else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
      playlistType = line.slice("#EXT-X-PLAYLIST-TYPE:".length).trim().toUpperCase();
    } else if (line === "#EXT-X-ENDLIST") {
      endList = true;
    } else if (line === "#EXT-X-DISCONTINUITY") {
      discontinuities += 1;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
      const system = identifyDrm(attrs["KEYFORMAT"] ?? "identity", attrs["URI"], attrs["KEYID"]);
      if (system) drm.push(system);
    } else if (line.startsWith("#EXT-X-CUE-OUT")) {
      adMarkers.push({
        kind: "cue-out",
        at: totalDuration,
        duration: num(line.split(":")[1] ?? ""),
        raw: line,
      });
    } else if (line.startsWith("#EXT-X-CUE-IN")) {
      adMarkers.push({ kind: "cue-in", at: totalDuration, raw: line });
    } else if (line.startsWith("#EXT-X-DATERANGE:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-DATERANGE:".length));
      const scte = attrs["SCTE35-OUT"] ?? attrs["SCTE35-IN"] ?? attrs["SCTE35-CMD"];
      adMarkers.push({
        kind: scte ? "scte35" : "daterange",
        at: totalDuration,
        duration: num(attrs["DURATION"] ?? attrs["PLANNED-DURATION"]),
        raw: line,
      });
    } else if (line.startsWith("#EXTINF:")) {
      const value = line.slice("#EXTINF:".length).split(",")[0] ?? "";
      pendingDuration = num(value.trim());
    } else if (!line.startsWith("#")) {
      count += 1;
      const duration = pendingDuration ?? 0;
      totalDuration += duration;
      if (duration > maxDuration) maxDuration = duration;
      pendingDuration = undefined;
      if (sampleUrls.length < 200) sampleUrls.push(resolveUrl(url, line));
    }
  }

  const kind: StreamModel["kind"] = endList
    ? "vod"
    : playlistType === "EVENT"
      ? "event"
      : playlistType === "VOD"
        ? "vod"
        : "live";

  return {
    segments: {
      count,
      targetDuration,
      maxDuration: maxDuration || undefined,
      totalDuration,
      mediaSequence,
      discontinuities,
      sampleUrls,
      endList,
    },
    drm,
    adMarkers,
    kind,
  };
}
