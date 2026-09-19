import { XMLParser } from "fast-xml-parser";
import { identifyDrm } from "../drm.js";
import type { AdMarker, DrmSystem, Rendition, StreamModel } from "../types.js";

/**
 * DASH parsing.
 *
 * Reads the MPD structure rather than expanding segment templates. Expanding a
 * template means generating every segment URL for the whole window, which for
 * a long DVR is tens of thousands of URLs that nothing here needs: the checks
 * reason about the ladder, the DRM and the timing attributes, all of which the
 * MPD states directly.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // Keeps single children as objects and repeated ones as arrays; `arrayOf`
  // below papers over that so callers never branch on it.
  isArray: () => false,
});

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** ISO 8601 duration, the subset DASH actually uses. */
export function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const seconds =
    (Number(y ?? 0) * 365 + Number(mo ?? 0) * 30 + Number(d ?? 0)) * 86_400 +
    Number(h ?? 0) * 3600 +
    Number(mi ?? 0) * 60 +
    Number(s ?? 0);
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function isMpd(body: string): boolean {
  return /<MPD[\s>]/.test(body);
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function contentTypeOf(mime: string | undefined, contentType: string | undefined): Rendition["contentType"] {
  const hint = (contentType ?? mime ?? "").toLowerCase();
  if (hint.includes("video")) return "video";
  if (hint.includes("audio")) return "audio";
  if (hint.includes("text") || hint.includes("ttml") || hint.includes("vtt")) return "text";
  return "unknown";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drmFrom(node: any): DrmSystem[] {
  const out: DrmSystem[] = [];
  for (const protection of arrayOf(node?.ContentProtection)) {
    const scheme = String(protection["@schemeIdUri"] ?? "");
    // The mp4protection entry declares the encryption scheme (cenc/cbcs), not
    // a DRM system, so its default_KID is the key id the real systems refer to.
    const keyId = protection["@cenc:default_KID"] ?? protection["@default_KID"];
    const system = identifyDrm(scheme, undefined, keyId ? String(keyId) : undefined);
    if (system) out.push(system);
  }
  return out;
}

export function parseMpd(url: string, body: string): StreamModel {
  const doc = parser.parse(body);
  const mpd = doc?.MPD ?? {};

  const type = String(mpd["@type"] ?? "static").toLowerCase();
  const kind: StreamModel["kind"] = type === "dynamic" ? "live" : "vod";

  const renditions: Rendition[] = [];
  const drm: DrmSystem[] = [];
  const adMarkers: AdMarker[] = [];

  const periods = arrayOf(mpd.Period);
  periods.forEach((period, periodIndex) => {
    // More than one Period almost always means an ad break or a content
    // splice, so the boundaries are reported as markers.
    if (periodIndex > 0) {
      adMarkers.push({
        kind: "period-boundary",
        at: parseDuration(String(period["@start"] ?? "")),
        duration: parseDuration(String(period["@duration"] ?? "")),
        raw: `Period id=${period["@id"] ?? periodIndex} start=${period["@start"] ?? "-"}`,
      });
    }

    for (const set of arrayOf(period.AdaptationSet)) {
      drm.push(...drmFrom(set));
      const setMime = set["@mimeType"] as string | undefined;
      const setContentType = set["@contentType"] as string | undefined;
      const setId = String(set["@id"] ?? `set-${renditions.length}`);

      for (const rep of arrayOf(set.Representation)) {
        drm.push(...drmFrom(rep));
        renditions.push({
          id: String(rep["@id"] ?? `${setId}-rep-${renditions.length}`),
          bandwidth: num(rep["@bandwidth"]),
          width: num(rep["@width"] ?? set["@width"]),
          height: num(rep["@height"] ?? set["@height"]),
          frameRate: num(rep["@frameRate"] ?? set["@frameRate"]),
          codecs: (rep["@codecs"] ?? set["@codecs"]) as string | undefined,
          contentType: contentTypeOf((rep["@mimeType"] ?? setMime) as string | undefined, setContentType),
          group: setId,
          language: (set["@lang"] ?? rep["@lang"]) as string | undefined,
        });
      }
    }
  });

  return {
    url,
    protocol: "dash",
    kind,
    multivariant: true,
    renditions,
    drm,
    adMarkers,
    segments: {},
    version: mpd["@profiles"] ? String(mpd["@profiles"]) : undefined,
    minimumUpdatePeriod: parseDuration(mpd["@minimumUpdatePeriod"] as string | undefined),
    suggestedPresentationDelay: parseDuration(mpd["@suggestedPresentationDelay"] as string | undefined),
    raw: body,
  };
}
