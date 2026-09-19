# streamprobe-mcp

An MCP server that tells you why an HLS or DASH stream is broken.

Point it at a manifest URL and ask. It reads the playlist or MPD, checks the
rendition ladder, the segment timing, the live window and the protection, and
reports what is wrong with the evidence it judged on.

**No ffmpeg.** Manifest and delivery problems are HTTP and text, not pixels, so
this runs from `npx` with nothing else installed. That is the difference between
this and the media-processing MCP servers: they transcode, this diagnoses.

## Install

Claude Code:

```bash
claude mcp add streamprobe -- npx -y streamprobe-mcp
```

Claude Desktop, Cursor, or anything else that speaks MCP over stdio:

```json
{
  "mcpServers": {
    "streamprobe": {
      "command": "npx",
      "args": ["-y", "streamprobe-mcp"]
    }
  }
}
```

Node 20 or newer. No other dependencies.

## Ask it things

> Why is https://cdn.example.com/live/master.m3u8 stalling for some viewers?

> What DRM is on this stream, and which key IDs?

> Compare the ladder on our staging manifest against production.

## Tools

| Tool              | What it answers                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagnose_stream` | What is wrong with this stream, worst first. Pass `deep: true` to read the media playlists too, which is needed for segment timing and live window checks. |
| `describe_stream` | What _is_ this stream: protocol, live or VOD, the ladder, codecs, audio and subtitle tracks, protection, ad markers. No opinions.                          |
| `inspect_drm`     | Which systems protect it, with key IDs and license URIs. Reads the manifest only; never requests a license or attempts decryption.                         |
| `check_segments`  | Are the segments actually there. Requests the newest few and reports failures and timings.                                                                 |

All four accept a `headers` object, for CDN tokens or a `Referer` your origin
requires.

## What it checks

Ladder shape: missing `CODECS`, duplicate bitrates, a rendition higher up the
ladder with a smaller picture, single-rendition ladders, missing audio, and HLS
variants pointing at an `AUDIO` group that has no `EXT-X-MEDIA` entry.

Delivery: segments longer than the declared `EXT-X-TARGETDURATION`, live windows
holding fewer than three target durations, VOD playlists with no
`EXT-X-ENDLIST`, renditions whose playlists do not load, and dynamic MPDs with
no `minimumUpdatePeriod`.

Protection: Widevine, PlayReady, FairPlay, ClearKey and AES-128, identified by
the UUID both protocols agree on, plus a warning for a system it does not
recognise rather than silently reporting "no DRM".

Every finding quotes the line, attribute or number it decided on. A diagnosis
you cannot verify against your own manifest is one you should not trust.

## Example

```
$ npx streamprobe-mcp   # or: pnpm example <url> --deep

Protocol:    HLS (6)
Type:        vod
Structure:   multivariant
Renditions:  24 video, 3 audio, 1 text
Protection:  none declared

Video ladder:
  480x270     541 kbps     avc1.640015,mp4a.40.2
  640x360     902 kbps     avc1.64001e,mp4a.40.2
  1920x1080   6208 kbps    avc1.640028,mp4a.40.2

0 errors, 0 warnings, 0 notes
No problems found.
```

## What it does not do

It does not transcode, download, or decrypt. It does not request DRM licenses.
It does not measure real playback quality, because that needs a player and a
viewer; this reads what the manifest claims and checks whether the delivery
matches. For encoding and transcoding work, use one of the ffmpeg MCP servers,
which is a different job.

It reads media bytes in exactly one place: `check_segments` requests the first
two bytes of a segment to see whether it exists.

## Use it without MCP

The diagnostics are a plain library, and importing it does not pull in the MCP
SDK:

```ts
import { probeStream } from "streamprobe-mcp";

const { model, findings } = await probeStream(url, { deep: true });
for (const f of findings) console.log(f.severity, f.title, f.evidence);
```

Useful in CI, or in a monitoring job that should fail on a regression in the
ladder.

## Contributing

Checks are the interesting part, and they are deliberately easy to add: a
`Check` is an `id`, an `applies` predicate and a `run` that returns findings.
See `src/checks/index.ts`. A new check needs a test proving it fires, and the
existing "finds nothing wrong with a healthy ladder" test must still pass. That
test exists because a diagnostic tool that cries wolf on a correct manifest is
worse than no tool.

```bash
pnpm install
pnpm check      # format, typecheck, test, build, pack
pnpm example <manifest-url> --deep
```

## Licence

MIT. Built by [CodeDTX](https://codedtx.com), who build OTT and Android TV
products and got tired of reading manifests by eye.
