# Share To Thymer - Context

This file is optional. It exists as a short orientation note for humans or coding agents that open the repository without reading every document first.

## Read First

- `PROJECT.md` explains the architecture and current behavior.
- `TODO.md` tracks actionable work.
- `DEVELOPING.md` has build, install, and debugging commands.

## Project Snapshot

Share To Thymer is an Android share-target app backed by a Thymer plugin. The Android share popup currently reuses the browser extension UI inside a WebView, with `android-chrome-polyfill.js` emulating Chrome extension APIs through Kotlin bridge objects.

The most important implementation files are:

- `app/src/main/java/com/example/savetothymer/ShareActivity.kt`
- `app/src/main/java/com/example/savetothymer/MainActivity.kt`
- `app/src/main/assets/popup/popup.js`
- `app/src/main/assets/popup/android-chrome-polyfill.js`
- `thymer-plugin/plugin.js`

Keep `browser-extension/` and `app/src/main/assets/` in sync when changing shared popup or content scripts.
