# Share To Thymer - Project Documentation

## Overview

Share To Thymer lets Android users share links and files from any app into a Thymer workspace. The Android app reuses the browser extension popup UI inside a WebView and replaces Chrome extension APIs with Kotlin-backed Android bridges.

Main user flow:

1. The user shares a URL, image, video, PDF, or mixed content through the Android share sheet.
2. `ShareActivity` opens a dialog-style popup WebView.
3. The app extracts page metadata and shared files.
4. The popup loads templates from the Thymer plugin configuration.
5. The user selects a template, edits fields if needed, and saves a record to Thymer.

## Domain Terms

| Term | Meaning |
|---|---|
| Workspace | A user's private Thymer space, hosted on a Thymer subdomain. |
| Workspace URL | Full workspace URL, for example `https://example.thymer.com/`. |
| Template | Popup-side mapping from shared content fields to a Thymer collection. |
| Collection | Thymer data collection selected by a template. |
| Record | The saved Thymer item created from a shared URL or file. |
| Bridge | JavaScript/Kotlin or popup/Thymer message path used to emulate extension behavior on Android. |

## Repository Layout

| Path | Purpose |
|---|---|
| `app/` | Android app. Contains Kotlin code, resources, tests, and WebView assets. |
| `app/src/main/assets/popup/` | Android copy of the extension popup UI and Android Chrome API polyfill. |
| `app/src/main/assets/content/` | Content extraction scripts and Android Thymer bridge script. |
| `browser-extension/` | Browser extension source. It should stay in sync with the shared popup/content assets. |
| `thymer-plugin/` | Thymer plugin that receives popup messages and performs collection/template operations. |
| `gradle/`, `gradlew`, `*.gradle.kts` | Gradle wrapper and build configuration. |
| `PROJECT.md` | Architecture and system behavior. |
| `TODO.md` | Actionable backlog. |
| `DEVELOPING.md` | Local build, install, and debugging commands. |

## Architecture

```text
Android share sheet
  -> ShareActivity
       -> parses shared text/files
       -> creates popup WebView from app assets
       -> creates hidden Thymer workspace WebView
       -> starts Kotlin Open Graph preview fetch

popup WebView
  -> popup.html / popup.css / popup.js
  -> android-chrome-polyfill.js
       -> chrome.storage.* -> AndroidStorageBridge
       -> chrome.tabs.* / chrome.scripting.* -> AndroidPageBridge
       -> chrome.tabs.sendMessage(THYMER_*) -> AndroidThymerBridge

hidden Thymer WebView
  -> loads configured workspace URL
  -> injects thymer-bridge-android.js
  -> forwards popup requests into the Thymer plugin

Thymer plugin
  -> reads/writes templates and plugin config
  -> reads collections and fields
  -> creates records
  -> tracks recent saves and tag configuration
```

The key design tradeoff is that the popup remains extension-first. This keeps the browser extension and Android UI close, but it makes Android behavior depend on WebView loading, JavaScript interfaces, and message ordering.

## Android App

### `MainActivity`

`MainActivity` is the launcher and workspace setup surface.

- Stores the workspace URL in `SharedPreferences` through `ThymerPreferences`.
- Lets the user enter a workspace manually.
- Can load `https://login.thymer.com/` and auto-detect the final `*.thymer.com` workspace URL.
- Shows the Thymer workspace in a full-screen WebView after setup.

Workspace auto-detection is intentionally conservative: `ThymerWorkspace.detectWorkspaceUrl()` ignores generic subdomains like `login`, `www`, `auth`, `api`, `assets`, and `static`.

### `ShareActivity`

`ShareActivity` handles Android `SEND` and `SEND_MULTIPLE` intents.

- Extracts shared URL/title from `Intent.EXTRA_TEXT` and related extras.
- Reads shared files into data URLs for popup consumption.
- Opens a dialog layout with a popup WebView and hidden Thymer WebView.
- Injects Android bridge objects into both WebViews.
- Fetches link previews on a background thread.
- Delivers preview results back to the popup through `window.onPagePreviewResult`.

Supported share MIME filters are declared in `AndroidManifest.xml`: `text/plain`, `image/*`, `video/*`, and `application/pdf`.

## JavaScript Bridges

| Bridge | Injected into | Main responsibility |
|---|---|---|
| `AndroidStorageBridge` | popup WebView | Back `chrome.storage.local/sync` with Android `SharedPreferences`. |
| `AndroidPageBridge` | popup WebView | Provide shared URL/title/files, run preview fetching, close popup, haptics, height updates, debug logs. |
| `AndroidThymerBridge` | popup and Thymer WebViews | Carry popup messages to the hidden Thymer WebView and return responses. |

Popup-to-Thymer message flow:

```text
popup.js sends THYMER_* message
  -> android-chrome-polyfill.js
  -> AndroidThymerBridge.sendMessageToThymer(...)
  -> ShareActivity dispatches CustomEvent("message-from-android")
  -> thymer-bridge-android.js forwards to the Thymer page/plugin
  -> plugin handles request
  -> thymer-bridge-android.js calls postResponseToApp(...)
  -> ShareActivity calls window.receiveResponseFromThymer(...)
  -> popup promise resolves
```

UTF-8 data crossing the bridge is base64-encoded by Kotlin and decoded in JavaScript with `TextDecoder("utf-8")`. This avoids the common `atob()` binary-string corruption for non-ASCII text.

## Open Graph Preview Extraction

There are two preview paths.

### Primary: Kotlin Fetch

`ShareActivity.fetchPagePreview()` performs direct HTTP fetching off the UI thread.

Current strategy:

1. Enable a process-wide `CookieManager` if none exists.
2. Fetch the original URL with headers modeled after `open-graph-scraper`.
3. Follow redirects manually so custom headers and cookies are preserved.
4. Parse `og:*`, `twitter:*`, normal description, and `<title>` metadata.
5. Resolve relative image URLs against the final page URL.
6. Filter blocked titles such as login pages, Cloudflare pages, generic social names, and error pages.

Reddit receives extra handling:

1. Parse the direct fetch result first.
2. Try `vxreddit` using a Discord-style embed user agent.
3. If image data is still missing, try Arctic Shift archive JSON.

Facebook currently depends on the open-graph-scraper user agent plus cookies and manual redirects. Some social platforms can still return incomplete metadata depending on the specific post and server response.

### Secondary: JS/Polyfill Fetch

The popup calls `chrome.tabs.sendMessage({ type: "GET_PAGE_DATA" })`. On Android, the polyfill intercepts that request and fetches the shared URL from the popup WebView.

This path:

- Uses `content.js` and `extractPageDataFromHtml`.
- Provides fallback metadata when Kotlin returns late or empty.
- Resolves Reddit short links before attempting `vxreddit`.
- Returns shared files from `AndroidPageBridge.getSharedFilesJson()`.

The popup merges both paths carefully. Kotlin data sets `_kotlinUpdated` when it contains useful metadata, and `_ogCardHasRealData` prevents weaker fallback cards from replacing better preview data.

## Popup and Plugin Behavior

The popup is responsible for:

- Template list, search, editing, deletion, and ordering.
- Collection field mapping.
- Banner image selection.
- Save flow and duplicate/error display.
- Local recent saves display.
- Offline queue handling with `saveQueue`.
- Auto-tag configuration UI.

The Thymer plugin is responsible for:

- Reading collections and fields.
- Saving records.
- Persisting templates in plugin configuration.
- Persisting plugin settings such as `autoTagRules`, `urlFieldMap`, `tagRestrictions`, `recentSaves`, and `sidebarRecentCount`.
- Exposing a Thymer-side configuration panel.

## Build Configuration

Current Android build highlights:

| Setting | Value |
|---|---|
| `compileSdk` | 36 |
| `minSdk` | 30 |
| `targetSdk` | 36 |
| JVM toolchain | 17 |
| UI deps | Compose and Material 3 are available, though the share popup is WebView-based. |
| WebView deps | `androidx.webkit` is present; `WebViewAssetLoader` is not currently used. |

Common commands are in `DEVELOPING.md`.

## Security Notes

- `WebView.setWebContentsDebuggingEnabled` is gated on `BuildConfig.DEBUG`.
- The popup WebView loads bundled assets from `file:///android_asset/...`.
- `allowUniversalAccessFromFileURLs = true` is enabled so the polyfill fetch path can request shared URLs. This is broad and should be reviewed before release.
- JavaScript interfaces are exposed only to the popup WebView and hidden Thymer WebView created by the app.
- `AndroidManifest.xml` sets `android:allowBackup="false"`.
- Release signing material must stay outside Git; `.gitignore` ignores common keystore and signing config files.
- `Logger.kt` gates logs on `BuildConfig.DEBUG`, but `ShareActivity.kt` still contains direct `Log.*` calls that should be reviewed before release.

## Known Gotchas

- `HttpURLConnection` automatic redirects can drop headers; this project uses manual redirects for preview fetching.
- Android may not install a default `CookieHandler`; the preview fetch path creates one when needed.
- Some content providers expose filenames with broken encoding; `getBase64FromUri` includes defensive filename re-encoding.
- `content.js` is loaded directly by `popup.html` on Android so `window.extractPageDataFromHtml` is available to the polyfill.
- Browser extension assets and Android assets are duplicated today; changes should be kept in sync intentionally.
- Compose navigation/data stubs exist, but the current app flow is mostly direct Android views plus WebViews.

## Documentation Map

- Use `PROJECT.md` for architecture and behavior.
- Use `TODO.md` for work that still needs doing.
- Use `DEVELOPING.md` for commands, log filters, and debugging steps.
- `CONTEXT.md` is not required for normal project documentation; its useful domain terms are covered here.
