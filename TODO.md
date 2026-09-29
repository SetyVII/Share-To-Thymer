# Share To Thymer - TODO

This file tracks actionable work. Long-form architecture notes live in `PROJECT.md`; development commands and log conventions live in `DEVELOPING.md`.

## Current State

- Android share flow is implemented in `ShareActivity.kt`.
- The popup UI is still the browser extension UI (`popup.html`, `popup.css`, `popup.js`) running inside an Android WebView.
- Chrome extension APIs are polyfilled by `android-chrome-polyfill.js`.
- Thymer communication goes through a hidden workspace WebView and the bundled Thymer plugin bridge.
- Kotlin Open Graph scraping is the primary preview path; the JS/polyfill fetch path is a fallback and merge source.
- Reddit preview extraction currently tries direct OG parsing, then `vxreddit`, then the Arctic Shift archive fallback.
- Templates, recent saves, auto-tag rules, URL field mapping, and tag restrictions are managed through the Thymer plugin configuration.

## Priority

- [ ] Validate OG scraping on device for Facebook, Instagram, X/Twitter, Reddit, YouTube, and generic pages after each scraper change.
- [ ] Add focused tests for `fetchRedditPreview` behavior: canonical URLs, `/s/` links, `vxreddit` failures, and Arctic Shift JSON image selection.
- [ ] Add tests for `parseOpenGraph`: attribute order, HTML entities, relative `og:image`, blocked titles, and URL slug fallback.
- [ ] Decide whether direct `Log.d` calls in `ShareActivity.kt` should be routed through `Logger.kt` so release behavior is consistent.
- [ ] Review WebView security before release: `allowUniversalAccessFromFileURLs`, file access, JavaScript interfaces, and loaded origins.
- [ ] Replace `com.example.savetothymer` package/application id before any public release.
- [ ] Define release signing through ignored local files (`keystore.properties`, `.jks`, etc.) and document the expected local setup.

## Android App Backlog

- [ ] Consider replacing `file://` asset loading with `WebViewAssetLoader` from `androidx.webkit`.
- [ ] Decide whether Compose stubs (`Navigation.kt`, `NavigationKeys.kt`, `DataRepository.kt`) should be completed or removed until needed.
- [ ] Improve workspace auto-detection resilience in `MainActivity.checkAndSaveWorkspaceUrl()`.
- [ ] Add user-visible retry/error states when the hidden Thymer WebView cannot connect or authenticate.
- [ ] Make shared file handling more visible in the popup when images, videos, or PDFs are attached.
- [ ] Add instrumentation coverage for the Android share sheet paths: text link, image, video, PDF, and multiple files.

## Popup and Extension Backlog

- [ ] Establish a sync process between `browser-extension/` and `app/src/main/assets/` so shared popup code does not drift.
- [ ] Keep template migration from local storage to Thymer plugin config covered by a regression test or manual checklist.
- [ ] Re-check offline queue behavior when Thymer is unavailable and when connectivity returns.
- [ ] Improve mobile ergonomics for template selection, field editing, and banner image selection.
- [ ] Validate auto-tag rule editing and tag restrictions from both the popup and Thymer plugin panel.

## Future Features

- [ ] Native screenshot capture for pages/posts without useful OG tags.
  - User taps "Capture Screenshot" in the popup.
  - Popup hides and a floating capture control appears.
  - User captures the visible source app screen.
  - Captured image returns as the banner/attachment candidate.
- [ ] Native Compose popup to reduce Kotlin/JS bridge complexity.
  - Better touch UX.
  - Native keyboard handling.
  - Easier Android-specific error states.
  - Less reliance on browser extension assumptions.

## Known Limitations

| Area | Limitation | Current handling |
|---|---|---|
| Instagram | Some posts do not expose useful OG tags in fetched HTML. | Video poster extraction + manual edit fallback. Banners downloaded & stored as native Thymer blobs to prevent 403 CDN expirations. |
| Reddit | Reddit blocks or degrades many non-browser fetches. | Direct parse, `vxreddit`, then Arctic Shift fallback. Banners stored permanently in Thymer. |
| Facebook | OG tags depend on specific request headers and cookies. | Kotlin fetch uses the open-graph-scraper user agent, cookies, and manual redirects. Banners stored permanently in Thymer. |
| WebView assets | `file://` plus universal access is convenient but broad. | Keep loaded content limited to bundled app assets; review before release. |
| Shared code | Browser extension and Android asset copies can drift. | Needs an explicit sync/build step. |
