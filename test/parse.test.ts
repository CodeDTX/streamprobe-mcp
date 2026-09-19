import { describe, expect, it } from "vitest";
import { parseAttributes, parseMaster, parseMedia } from "../src/hls/parse.js";
import { parseDuration, parseMpd } from "../src/dash/parse.js";
import { identifyDrm, dedupeDrm } from "../src/drm.js";
import { parseTop } from "../src/probe.js";
import { runChecks } from "../src/checks/index.js";

const BASE = "https://cdn.example.com/out/v1/master.m3u8";

/** A ladder with nothing wrong with it. The baseline for false positives. */
const HEALTHY_MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aac"
v0/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"
v1/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"
v2/index.m3u8
`;

describe("parseAttributes", () => {
  it("keeps commas that sit inside a quoted value", () => {
    // The classic HLS parsing bug: CODECS always contains a comma.
    const attrs = parseAttributes('BANDWIDTH=2000000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720');
    expect(attrs["CODECS"]).toBe("avc1.64001f,mp4a.40.2");
    expect(attrs["BANDWIDTH"]).toBe("2000000");
    expect(attrs["RESOLUTION"]).toBe("1280x720");
  });

  it("survives a trailing attribute with no comma after it", () => {
    expect(parseAttributes('TYPE=AUDIO,GROUP-ID="aac"')["GROUP-ID"]).toBe("aac");
  });
});

describe("HLS master", () => {
  it("reads the ladder and resolves relative URIs", () => {
    const model = parseMaster(BASE, HEALTHY_MASTER);
    const video = model.renditions.filter((r) => r.contentType === "video");
    expect(video).toHaveLength(3);
    expect(video[0]!.url).toBe("https://cdn.example.com/out/v1/v0/index.m3u8");
    expect(video[2]!.height).toBe(1080);
    expect(video[2]!.bandwidth).toBe(5000000);
    expect(model.renditions.find((r) => r.contentType === "audio")?.language).toBe("en");
  });

  it("classifies an audio-only variant from its codec string", () => {
    const model = parseMaster(
      BASE,
      `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8\n`,
    );
    expect(model.renditions[0]!.contentType).toBe("audio");
  });
});

describe("HLS media playlist", () => {
  it("totals durations, and reads target duration and endlist", () => {
    const media = parseMedia(
      "https://cdn.example.com/out/v1/v0/index.m3u8",
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:42
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.0,
seg1.ts
#EXTINF:6.0,
seg2.ts
#EXT-X-DISCONTINUITY
#EXTINF:5.0,
seg3.ts
#EXT-X-ENDLIST
`,
    );
    expect(media.segments.count).toBe(3);
    expect(media.segments.totalDuration).toBeCloseTo(17);
    expect(media.segments.targetDuration).toBe(6);
    expect(media.segments.mediaSequence).toBe(42);
    expect(media.segments.discontinuities).toBe(1);
    expect(media.segments.endList).toBe(true);
    expect(media.kind).toBe("vod");
    expect(media.segments.sampleUrls[0]).toBe("https://cdn.example.com/out/v1/v0/seg1.ts");
  });

  it("treats a playlist with no endlist as live", () => {
    const media = parseMedia(BASE, `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\na.ts\n`);
    expect(media.kind).toBe("live");
  });

  it("finds SCTE-35 and cue markers", () => {
    const media = parseMedia(
      BASE,
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
a.ts
#EXT-X-CUE-OUT:30.000
#EXTINF:6.0,
b.ts
#EXT-X-CUE-IN
#EXT-X-DATERANGE:ID="ad1",START-DATE="2026-01-01T00:00:00Z",SCTE35-OUT=0xFC30
`,
    );
    expect(media.adMarkers.map((m) => m.kind)).toEqual(["cue-out", "cue-in", "scte35"]);
    expect(media.adMarkers[0]!.duration).toBe(30);
  });
});

describe("DRM", () => {
  it("names Widevine and PlayReady from their UUIDs in either protocol's spelling", () => {
    expect(identifyDrm("urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")?.name).toBe("Widevine");
    expect(identifyDrm("urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95")?.name).toBe("PlayReady");
  });

  it("treats identity with a URI as AES-128, and without one as no encryption", () => {
    expect(identifyDrm("identity", "https://keys.example.com/k1")?.name).toBe("AES-128 (identity)");
    expect(identifyDrm("identity")).toBeNull();
  });

  it("reports an unknown system rather than dropping it", () => {
    const system = identifyDrm("urn:uuid:11111111-2222-3333-4444-555555555555");
    expect(system).not.toBeNull();
    expect(system!.name).toBeNull();
  });

  it("merges duplicates and unions their key ids", () => {
    const merged = dedupeDrm([
      identifyDrm("urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", undefined, "kid1")!,
      identifyDrm("urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", undefined, "kid2")!,
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.keyIds.sort()).toEqual(["kid1", "kid2"]);
  });
});

describe("DASH", () => {
  const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period id="p0">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="abc-123"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v0" bandwidth="800000" width="640" height="360" codecs="avc1.64001e"/>
      <Representation id="v1" bandwidth="2400000" width="1280" height="720" codecs="avc1.64001f"/>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="a0" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  it("reads renditions, type and protection", () => {
    const model = parseMpd("https://cdn.example.com/m.mpd", MPD);
    expect(model.protocol).toBe("dash");
    expect(model.kind).toBe("live");
    expect(model.minimumUpdatePeriod).toBe(2);
    expect(model.renditions.filter((r) => r.contentType === "video")).toHaveLength(2);
    expect(model.renditions.find((r) => r.contentType === "audio")?.language).toBe("en");
    expect(dedupeDrm(model.drm).some((d) => d.name === "Widevine")).toBe(true);
  });

  it("parses ISO 8601 durations", () => {
    expect(parseDuration("PT2S")).toBe(2);
    expect(parseDuration("PT1M30S")).toBe(90);
    expect(parseDuration("PT1H2M3S")).toBe(3723);
    expect(parseDuration("nonsense")).toBeUndefined();
  });
});

describe("protocol sniffing", () => {
  it("picks the protocol from the body, not the extension", () => {
    expect(parseTop("https://x/whatever.txt", HEALTHY_MASTER).protocol).toBe("hls");
    expect(
      parseTop("https://x/whatever.txt", '<?xml version="1.0"?><MPD type="static"></MPD>').protocol,
    ).toBe("dash");
  });

  it("refuses a body that is neither, and says what it saw", () => {
    expect(() => parseTop("https://x/a.m3u8", "<html><body>404</body></html>")).toThrow(/neither/i);
  });
});

describe("checks", () => {
  it("finds nothing wrong with a healthy ladder", () => {
    // The most important test here. A diagnostic tool that cries wolf on a
    // correct manifest is worse than no tool, because it trains people to
    // ignore it.
    const findings = runChecks({ model: parseMaster(BASE, HEALTHY_MASTER), deep: false });
    expect(findings.filter((f) => f.severity !== "info")).toEqual([]);
  });

  it("does not flag an EXT-X-MEDIA entry for omitting CODECS", () => {
    // The referencing variant declares the codec for the group, so the media
    // entry is allowed to leave it out. Regression test for a false positive.
    const model = parseMaster(BASE, HEALTHY_MASTER);
    const audio = model.renditions.find((r) => r.contentType === "audio");
    expect(audio?.codecs).toBeUndefined();
    expect(runChecks({ model, deep: false }).map((f) => f.id)).not.toContain("ladder-missing-codecs");
  });

  it("catches a missing codec declaration", () => {
    const model = parseMaster(
      BASE,
      `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nb.m3u8\n`,
    );
    const ids = runChecks({ model, deep: false }).map((f) => f.id);
    expect(ids).toContain("ladder-missing-codecs");
  });

  it("catches a variant pointing at an audio group that does not exist", () => {
    const model = parseMaster(
      BASE,
      `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e",AUDIO="missing"\na.m3u8\n`,
    );
    const ids = runChecks({ model, deep: false }).map((f) => f.id);
    expect(ids).toContain("hls-audio-group-unresolved");
  });

  it("catches a resolution inversion in the ladder", () => {
    const model = parseMaster(
      BASE,
      `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.64001f"
a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=640x360,CODECS="avc1.64001e"
b.m3u8
`,
    );
    const ids = runChecks({ model, deep: false }).map((f) => f.id);
    expect(ids).toContain("ladder-resolution-inversion");
  });

  it("catches a segment longer than the declared target duration", () => {
    const model = parseMaster(BASE, HEALTHY_MASTER);
    model.segments["v0"] = {
      count: 2,
      targetDuration: 6,
      maxDuration: 9.5,
      totalDuration: 15.5,
      discontinuities: 0,
      sampleUrls: [],
      endList: true,
    };
    const findings = runChecks({ model, deep: true });
    const hit = findings.find((f) => f.id === "segment-exceeds-target-duration");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.evidence?.[0]).toContain("9.500");
  });

  it("does not fire segment checks on a shallow read", () => {
    const model = parseMaster(BASE, HEALTHY_MASTER);
    model.segments["v0"] = {
      count: 2,
      targetDuration: 6,
      maxDuration: 9.5,
      totalDuration: 15.5,
      discontinuities: 0,
      sampleUrls: [],
      endList: true,
    };
    const ids = runChecks({ model, deep: false }).map((f) => f.id);
    expect(ids).not.toContain("segment-exceeds-target-duration");
  });

  it("orders findings worst first", () => {
    const model = parseMaster(
      BASE,
      `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="missing"\na.m3u8\n`,
    );
    const severities = runChecks({ model, deep: false }).map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === "error" ? -1 : b === "error" ? 1 : 0)));
    expect(severities[0]).toBe("error");
  });
});
