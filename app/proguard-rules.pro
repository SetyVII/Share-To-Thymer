# Keep methods exposed to WebView JavaScript bridges.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

