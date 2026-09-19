/**
 * One model for both protocols.
 *
 * HLS and DASH describe the same thing in almost incompatible vocabulary: a
 * variant is a Representation, a rendition group is an AdaptationSet, a target
 * duration is a @maxSegmentDuration. Writing a check twice, once per protocol,
 * is how the two copies drift until a bug is fixed in one and not the other.
 *
 * So parsers do the translating and every check works on the shapes below.
 * Where a protocol genuinely has no equivalent the field is optional, and a
 * check that needs it says so rather than guessing a default.
 */

export type Protocol = "hls" | "dash";

export type StreamKind = "live" | "vod" | "event" | "unknown";

/** A DRM system, identified by the UUID both protocols agree on. */
export interface DrmSystem {
  /** Lowercase UUID as it appears in the manifest. */
  systemId: string;
  /** "Widevine", "PlayReady", "FairPlay", "ClearKey", or null when unrecognised. */
  name: string | null;
  /** HLS keyformat or DASH schemeIdUri, kept verbatim for reporting. */
  scheme: string;
  /** Key IDs where the manifest exposes them. */
  keyIds: string[];
  /** License or key URI where present. Not fetched, only reported. */
  uri?: string;
}

/** One playable rendition: an HLS variant or a DASH Representation. */
export interface Rendition {
  /** Stable handle for reporting: the URI for HLS, the id for DASH. */
  id: string;
  /** Absolute URL of the media playlist, when the protocol has one. */
  url?: string;
  /** Declared peak bitrate in bits per second. */
  bandwidth?: number;
  /** Declared average bitrate in bits per second. */
  averageBandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  /** RFC 6381 codec string, exactly as declared. */
  codecs?: string;
  /** "video", "audio", "text", or "unknown" when the manifest does not say. */
  contentType: "video" | "audio" | "text" | "unknown";
  /** HLS AUDIO/SUBTITLES group, or the DASH AdaptationSet id. */
  group?: string;
  language?: string;
}

/** A media playlist's segment list, once fetched. */
export interface SegmentInfo {
  count: number;
  /** Declared target duration in seconds, where the protocol states one. */
  targetDuration?: number;
  /** Longest actual segment duration seen. */
  maxDuration?: number;
  /** Sum of segment durations: the DVR window for live, the asset for VOD. */
  totalDuration: number;
  /** HLS EXT-X-MEDIA-SEQUENCE, absent for DASH. */
  mediaSequence?: number;
  discontinuities: number;
  /** Absolute URLs, capped by the fetcher rather than held in full. */
  sampleUrls: string[];
  endList: boolean;
}

/** Ad insertion signalling found in the manifest. */
export interface AdMarker {
  kind: "cue-out" | "cue-in" | "daterange" | "scte35" | "period-boundary";
  /** Offset in seconds from the start of the playlist, where derivable. */
  at?: number;
  duration?: number;
  /** The raw attribute line or element, for an engineer to read. */
  raw: string;
}

/**
 * Everything a parser could establish without fetching media bytes.
 *
 * Deliberately separate from the findings: this is what the stream *says* about
 * itself, and a caller may want the facts without an opinion attached.
 */
export interface StreamModel {
  url: string;
  protocol: Protocol;
  kind: StreamKind;
  /** True when the top-level document lists renditions rather than segments. */
  multivariant: boolean;
  renditions: Rendition[];
  drm: DrmSystem[];
  adMarkers: AdMarker[];
  /** Populated per rendition id once media playlists are fetched. */
  segments: Record<string, SegmentInfo>;
  /** HLS version, or the DASH profiles attribute. */
  version?: string;
  /** DASH only: the advertised availability window and update cadence. */
  minimumUpdatePeriod?: number;
  suggestedPresentationDelay?: number;
  /** Raw top-level document, retained for reporting excerpts. */
  raw: string;
}

export type Severity = "error" | "warning" | "info";

/**
 * One diagnosis.
 *
 * `evidence` matters more than the message. An engineer reading a finding has
 * to be able to confirm it against the manifest themselves, so every check
 * quotes the line, attribute or number it decided on rather than asserting a
 * conclusion the reader has to trust.
 */
export interface Finding {
  /** Stable kebab-case id, safe to grep for and to suppress on. */
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence?: string[];
  /** Rendition ids the finding applies to, when it is not stream-wide. */
  renditions?: string[];
}

export interface CheckContext {
  model: StreamModel;
  /** False when media playlists were not fetched, so segment checks skip. */
  deep: boolean;
}

export interface Check {
  id: string;
  /** Skipped silently when this returns false, e.g. a VOD-only check on live. */
  applies: (ctx: CheckContext) => boolean;
  run: (ctx: CheckContext) => Finding[];
}
