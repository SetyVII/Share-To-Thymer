# Share To Thymer

![Share To Thymer logo](assets/logo/share-to-thymer-logo.png)

Share To Thymer lets you send links and shared files from Android to your Thymer workspace.

It includes an Android share-sheet app and a companion Thymer plugin.

## Download

Download the APK from the [GitHub Releases](https://github.com/SetyVII/Share-To-Thymer/releases) page.

### Play Protect notice

This app is distributed outside Google Play. Android or Play Protect may show a warning because the developer identity and package name have not yet been registered with Android's developer verification system. The source code is public in this repository, so you can inspect it and build the APK yourself if you prefer.

## Build from source

With the Android SDK and Java 17 installed, build a debug APK with:

```bash
./gradlew assembleDebug
```

The APK will be created at:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Thymer Plugin

Install the plugin with Thymer's **Plugins Manager** using this URL:

```text
https://github.com/SetyVII/Share-To-Thymer/tree/main/thymer-plugin
```

You can also copy the plugin files manually from:

```text
thymer-plugin/
```

## Notes

This repo includes extra project notes for agents or contributors who want more context:

- `PROJECT.md`
- `DEVELOPING.md`
- `TODO.md`

## Attribution

This project was built using [zakblf/save-to-thymer](https://github.com/zakblf/save-to-thymer) as a reference for the browser extension and Thymer plugin workflow. That project is MIT licensed.

## License

MIT. See [LICENSE](LICENSE).
