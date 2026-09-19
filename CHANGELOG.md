# Changelog

## 0.1.0

First release.

- `diagnose_stream`, `describe_stream`, `inspect_drm` and `check_segments` over MCP stdio
- HLS master and media playlist parsing, DASH MPD parsing, into one shared model
- Eleven checks covering ladder shape, codec declarations, segment timing, live
  window health and protection, each carrying the evidence it judged on
- DRM identification for Widevine, PlayReady, FairPlay, ClearKey and AES-128
- No ffmpeg dependency: everything is HTTP plus manifest parsing
