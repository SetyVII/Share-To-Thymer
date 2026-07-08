# Share To Thymer - Developing

Use this file for local build, install, and debugging commands. Architecture belongs in `PROJECT.md`; open work belongs in `TODO.md`.

## Quick Start

### Build & Install
```bash
# Build APK
./gradlew assembleDebug

# Install on connected device (USB or wireless ADB)
./gradlew installDebug

# Wireless ADB pairing (Android 11+)
# On device: Settings → Developer Options → Wireless Debugging → Pair with code
adb pair <ip>:<port> <6-digit-code>
adb connect <ip>:<connection-port>
```

### Debugging
```bash
# Watch all Kotlin logs
adb logcat -s SaveToThymer:V

# Watch JS console logs (forwarded to logcat via onConsoleMessage)
adb logcat | grep "SaveToThymer:JS"

# Clear log buffer
adb logcat -c

# Chrome DevTools for WebView debugging
# 1. Open chrome://inspect in desktop Chrome
# 2. Find the WebView under "Remote Target"
# 3. Inspect to see console, network, DOM
```

## Logging Conventions

Most logs use the `SaveToThymer` tag. Sub-tags use colon notation:

| Tag | Source | Example |
|---|---|---|
| `SaveToThymer` | Kotlin code | `[OG:Kotlin] Fetching page: ...` |
| `SaveToThymer:JS` | JS console.log/error/warn | `[OG:JS] Dispatching fetchPagePreviewAsync` |
| `SaveToThymer:JS:Bridge` | JS calls to `debugLog()` | `[OG:JS] fetchPagePreviewAsync dispatched` |

Log format: `[Component] message`. Components: `OG:Kotlin`, `OG:JS`, `OG:BG`, `OG:TEMPLATE`, `OG:SAVE`, `OG:WebView`.

Before release, review direct `Log.*` calls in `ShareActivity.kt`; not all of them currently go through `Logger.kt`.

## How OG Debugging Works

```
1. User shares link → popup opens
2. [OG:JS] Dispatching fetchPagePreviewAsync (non-blocking)  ← popup.js
3. [OG:JS→Kotlin] fetchPagePreviewAsync called               ← ShareActivity bridge
4. [OG:Kotlin] Fetching page: https://...                     ← Kotlin fetch starts
5. [OG:Kotlin] HTTP 302 for ...                               ← redirect detected
6. [OG:Kotlin] Redirect 1 → https://...                        ← manual redirect
7. [OG:Kotlin] Final HTTP status 200                          ← final page loaded
8. [OG:Kotlin] Downloaded 93992 bytes, parsing OG tags...     ← HTML received
9. [OG:Kotlin] findMeta(og:title) → Actual Post Title         ← OG tags found
10. [OG:Kotlin] findMeta(og:image) → https://scontent...      ← image URL
11. [OG:Kotlin] SUCCESS title=... image=... domain=...        ← all good
12. [OG:BG] fetch complete, len=N isError=false               ← background thread done
13. [OG:Kotlin→JS] Delivering to onPagePreviewResult          ← sending to JS
14. [OG:JS] onPagePreviewResult received, len=N               ← JS receives
15. [OG:JS] Preview card displayed ✓                          ← card shown in popup
```
