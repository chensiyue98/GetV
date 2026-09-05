# GetV for Safari

English | [简体中文](README.zh-CN.md)

GetV is a Safari Web Extension for macOS and iOS. It discovers video and audio resources exposed through media elements, links, Performance Resource Timing, `fetch`, XHR, and MediaSource.

## Installation

Install the macOS app with Homebrew:

```sh
brew tap chensiyue98/tap
brew install --cask get-v
```

## Features

- Detects MP4, M4V, WEBM, FLV, MP3, M4A, AAC, MOV, and HLS/m3u8 resources directly. Media lifecycle events trigger an immediate rescan when a player is created or its source changes; URLs without a file extension are verified in the background using their MIME type and up to 64 KB of file-header data.
- Parses HLS master playlists, selects the highest-quality variant by resolution and bitrate by default, and lets you choose another quality manually.
- Detects separate `EXT-X-MEDIA` audio tracks, selects the language marked `DEFAULT` by default, and lets you switch tracks from the popup.
- Downloads video and audio HLS segments with configurable concurrency (2–12 workers), supports AES-128 decryption, pause/resume, renaming, and partial export. Tasks can be deleted individually or cleared together without deleting files already saved to disk.
- Stores download tasks and segments in the extension's IndexedDB instead of using the limited `browser.storage.local` settings quota. Downloads can resume after the manager page or process closes, and a disk file is created only during assembly.
- Combines fMP4 HLS init and media segments into MP4. Traditional MPEG-TS (H.264/AAC) is transmuxed with the bundled mux.js. For separate audio/video tracks, MP4Box.js rebuilds a dual-track initialization segment and places matching audio and video fragments in the same movie fragment for Safari and QuickTime compatibility.
- Record mode hooks `SourceBuffer.appendBuffer` in the page context, supports pausing, and can save a partial capture.
- Popup settings include download concurrency, automatic saving, cache cleanup after saving, filename source, toolbar badges, and preview filtering.
- Provides English and Simplified Chinese interfaces, selected automatically from Safari's UI language.

## Platform Limitations

- Safari's WebExtension API cannot read MediaSource bytes buffered before the extension was injected. Record mode can capture only newly appended data, so refresh the page and start capture early.
- FairPlay/EME DRM media cannot be decrypted or exported by the extension.
- MPEG-TS transmuxing currently covers common H.264/AAC streams. Unsupported codecs such as HEVC or AC-3 produce an explicit error. A non-split TS download can still fall back to a `.ts` file instead of producing an invalid MP4.
- Record mode is most reliable with a single muxed fMP4 SourceBuffer. DASH players with separate audio and video tracks require an additional MP4 muxer.
- Use GetV only for non-DRM media you are authorized to save, and follow the website's terms and local law.

## Development

1. Open `get-v.xcodeproj` in Xcode and run the `get-v (macOS)` scheme.
2. In Safari, open Settings → Extensions, enable GetV, and allow access to the sites from which you want to download.
3. Play a video on the page and select the toolbar icon.

Run JavaScript syntax checks and unit tests:

```sh
npm run check
npm test
```

Third-party components and their licenses are under `Shared (Extension)/Resources/vendor/`: mux.js (Apache-2.0) and MP4Box.js (BSD-3-Clause).

See [`docs/RELEASING.md`](docs/RELEASING.md) for GitHub Actions release and signing configuration.
