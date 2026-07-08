package com.sety.sharetothymer

import android.annotation.SuppressLint
import android.graphics.Color
import android.util.Log
import com.sety.sharetothymer.utils.Logger
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class ShareActivity : ComponentActivity() {

    companion object {
        private const val TAG = "SaveToThymer"
    }

    private lateinit var popupWebView: WebView
    private lateinit var thymerWebView: WebView
    private lateinit var cardLayout: FrameLayout
    
    private var isThymerWebViewLoaded = false
    private val pendingMessages = mutableListOf<Pair<String, String>>() // msgId to messageJson
    private var availableHeightPx = 0
    
    private var filePathCallback: android.webkit.ValueCallback<Array<android.net.Uri>>? = null
    private val FILE_CHOOSER_REQUEST_CODE = 1001

    private var sharedUrl = ""
    private var sharedTitle = ""

    data class SharedFile(
        val name: String,
        val mimeType: String,
        val base64Data: String
    )
    
    private val sharedFiles = ArrayList<SharedFile>()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Read saved URL from preferences
        val prefs = getSharedPreferences(ThymerPreferences.NAME, MODE_PRIVATE)
        val thymerUrl = prefs.getString(ThymerPreferences.WORKSPACE_URL_KEY, null)

        if (thymerUrl == null) {
            android.widget.Toast.makeText(this, "Please open the main app first to set up your Thymer workspace", android.widget.Toast.LENGTH_LONG).show()
            finish()
            return
        }

        // 1. Parse intent
        if (intent?.action == android.content.Intent.ACTION_SEND) {
            // First, try to extract a URL from EXTRA_TEXT regardless of MIME type
            val sharedText = intent.getStringExtra(android.content.Intent.EXTRA_TEXT) ?: ""
            if (sharedText.isNotEmpty()) {
                val urlRegex = Regex("(https?://[^\\s]+)")
                val match = urlRegex.find(sharedText)
                sharedUrl = match?.value ?: ""
                
                val extraTitle = intent.getStringExtra(android.content.Intent.EXTRA_TITLE) ?: ""
                val subject = intent.getStringExtra(android.content.Intent.EXTRA_SUBJECT) ?: ""
                sharedTitle = extraTitle.ifEmpty { subject }.ifEmpty {
                    if (sharedUrl.isNotEmpty()) {
                        sharedText.replace(sharedUrl, "").trim()
                    } else {
                        sharedText
                    }
                }.ifEmpty {
                    "Shared Link"
                }
            }

            // Second, try to extract any attached file/image from EXTRA_STREAM
            val fileUri = intent.getParcelableExtra<android.net.Uri>(android.content.Intent.EXTRA_STREAM)
            if (fileUri != null) {
                getBase64FromUri(fileUri)?.let {
                    sharedFiles.add(it)
                    // If no URL was found in text, use the file URL as fallback
                    if (sharedUrl.isEmpty()) {
                        sharedTitle = it.name
                        sharedUrl = "file://${it.name}"
                    }
                }
            }
        } else if (intent?.action == android.content.Intent.ACTION_SEND_MULTIPLE) {
            val fileUris = intent.getParcelableArrayListExtra<android.net.Uri>(android.content.Intent.EXTRA_STREAM)
            if (fileUris != null) {
                for (uri in fileUris) {
                    getBase64FromUri(uri)?.let {
                        sharedFiles.add(it)
                    }
                }
                if (sharedFiles.isNotEmpty()) {
                    sharedTitle = "Shared ${sharedFiles.size} files"
                    sharedUrl = "file://multiple_files"
                }
            }
        }

        if (sharedUrl.isEmpty() && sharedFiles.isEmpty()) {
            // Nothing to share, close
            finish()
            return
        }

        // 2. Set up WebViews
        popupWebView = WebView(this)
        thymerWebView = WebView(this)

        configureWebView(popupWebView)
        configureWebView(thymerWebView)

        popupWebView.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: android.webkit.ValueCallback<Array<android.net.Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@ShareActivity.filePathCallback?.onReceiveValue(null)
                this@ShareActivity.filePathCallback = filePathCallback

                val intent = android.content.Intent(android.content.Intent.ACTION_GET_CONTENT).apply {
                    addCategory(android.content.Intent.CATEGORY_OPENABLE)
                    type = "image/*"
                }
                startActivityForResult(android.content.Intent.createChooser(intent, "Select Image"), FILE_CHOOSER_REQUEST_CODE)
                return true
            }

            override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage): Boolean {
                val level = when (consoleMessage.messageLevel()) {
                    android.webkit.ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                    android.webkit.ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                    else -> Log.DEBUG
                }
                Log.println(level, "$TAG:JS", "[${consoleMessage.sourceId()}:${consoleMessage.lineNumber()}] ${consoleMessage.message()}")
                return true
            }
        }

        // 3. Setup Javascript interfaces
        popupWebView.addJavascriptInterface(AndroidStorageBridge(), "AndroidStorageBridge")
        popupWebView.addJavascriptInterface(AndroidPageBridge(), "AndroidPageBridge")
        popupWebView.addJavascriptInterface(AndroidThymerBridge(), "AndroidThymerBridge")

        thymerWebView.addJavascriptInterface(AndroidThymerBridge(), "AndroidThymerBridge")

        // 4. Create dialog layout programmatically
        val mainLayout = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#99000000")) // Dim background
            setOnClickListener { finish() } // Close when clicking outside
        }

        // Initialize safe area height
        val metrics = resources.displayMetrics
        val screenWidth = metrics.widthPixels
        val screenHeight = metrics.heightPixels
        availableHeightPx = screenHeight

        // Apply window insets to avoid overlapping with status bar, navigation bars, and soft keyboard
        ViewCompat.setOnApplyWindowInsetsListener(mainLayout) { _, insets ->
            val statusBarInsets = insets.getInsets(WindowInsetsCompat.Type.statusBars())
            val navBarInsets = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
            
            val bottomPadding = if (imeInsets.bottom > 0) imeInsets.bottom else navBarInsets.bottom
            
            mainLayout.setPadding(
                statusBarInsets.left,
                statusBarInsets.top,
                statusBarInsets.right,
                bottomPadding
            )
            
            availableHeightPx = screenHeight - statusBarInsets.top - bottomPadding
            insets
        }

        // Card container with rounded corners and adaptive background matching the plugin's theme mode
        val isDarkMode = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        val cardColor = if (isDarkMode) Color.parseColor("#0f0f0f") else Color.parseColor("#f5f5f7")

        val cornerRadius = dpToPx(12)
        val background = GradientDrawable().apply {
            setColor(cardColor)
            setCornerRadius(cornerRadius.toFloat())
        }
        cardLayout = FrameLayout(this).apply {
            setBackground(background)
            clipToOutline = true
            setOnClickListener { /* no-op, prevent closing when clicking inside */ }
        }
        popupWebView.setBackgroundColor(Color.TRANSPARENT)
        cardLayout.addView(popupWebView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        // Responsive size
        val dialogWidth = minOf(dpToPx(500), (screenWidth * 0.95).toInt())
        val dialogHeight = minOf(dpToPx(650), (screenHeight * 0.85).toInt())

        val cardParams = FrameLayout.LayoutParams(dialogWidth, dialogHeight).apply {
            gravity = Gravity.CENTER
        }
        mainLayout.addView(cardLayout, cardParams)

        // Hidden WebView (1x1 px) attached to the layout so it executes JS
        val hiddenParams = FrameLayout.LayoutParams(1, 1).apply {
            gravity = Gravity.TOP or Gravity.START
        }
        mainLayout.addView(thymerWebView, hiddenParams)

        setContentView(mainLayout)

        // 5. Load URLs
        // Enable WebView debugging only in debug builds
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        thymerWebView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                isThymerWebViewLoaded = false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injectThymerBridge()
            }
        }
        thymerWebView.loadUrl(thymerUrl)

        popupWebView.loadUrl("file:///android_asset/popup/popup.html")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(wv: WebView) {
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowUniversalAccessFromFileURLs = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
    }

    private fun injectThymerBridge() {
        val bridgeScript = try {
            assets.open("content/thymer-bridge-android.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            e.printStackTrace()
            ""
        }
        if (bridgeScript.isNotEmpty()) {
            thymerWebView.evaluateJavascript(bridgeScript) {
                isThymerWebViewLoaded = true
                flushPendingMessages()
            }
        }
    }

    private fun flushPendingMessages() {
        for (pending in pendingMessages) {
            dispatchMessageToThymerWebView(pending.first, pending.second)
        }
        pendingMessages.clear()
    }

    private fun dispatchMessageToThymerWebView(msgId: String, messageJson: String) {
        val base64Json = Base64.encodeToString(messageJson.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        // atob() returns a binary string (1 char per byte), which corrupts multi-byte UTF-8 sequences.
        // TextDecoder('utf-8') correctly reassembles multi-byte chars like ó, é, ñ, etc.
        val script = "window.dispatchEvent(new CustomEvent('message-from-android', { detail: { ...JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(atob('$base64Json'), c => c.charCodeAt(0)))), messageId: '$msgId' } }));"
        thymerWebView.evaluateJavascript(script, null)
    }

    private fun dpToPx(dp: Int): Int {
        val scale = resources.displayMetrics.density
        return (dp * scale + 0.5f).toInt()
    }

    private fun getBase64FromUri(uri: android.net.Uri): SharedFile? {
        try {
            val contentResolver = contentResolver
            val mimeType = contentResolver.getType(uri) ?: "application/octet-stream"
            Logger.d("SaveToThymer", "getBase64FromUri: uri=$uri mimeType=$mimeType")

            var fileName = "shared_file"
            contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (nameIndex != -1 && cursor.moveToFirst()) {
                    val raw = cursor.getString(nameIndex) ?: "shared_file"
                    // Log the raw bytes to diagnose the encoding issue
                    val rawBytes = raw.toByteArray(Charsets.UTF_16BE)
                        .toList().chunked(2)
                        .map { (a, b) -> ((a.toInt() and 0xFF) shl 8) or (b.toInt() and 0xFF) }
                    Logger.d("SaveToThymer", "Raw filename: '$raw'")
                    Logger.d("SaveToThymer", "Raw codepoints: $rawBytes")

                    // Some content providers return UTF-8 bytes misinterpreted as ISO-8859-1.
                    // Try to re-encode; if it produces valid UTF-8 we keep it, otherwise keep raw.
                    fileName = try {
                        val reencoded = String(raw.toByteArray(Charsets.ISO_8859_1), Charsets.UTF_8)
                        Logger.d("SaveToThymer", "Re-encoded filename: '$reencoded'")
                        Logger.d("SaveToThymer", "Contains replacement char: ${reencoded.contains('\uFFFD')}, equals raw: ${reencoded == raw}")
                        if (reencoded.contains('\uFFFD') || reencoded == raw) raw else reencoded
                    } catch (e: Exception) {
                        Logger.e("SaveToThymer", "Re-encoding failed", e)
                        raw
                    }
                    Logger.d("SaveToThymer", "Final fileName: '$fileName'")
                }
            }

            val inputStream = contentResolver.openInputStream(uri) ?: return null
            val bytes = inputStream.readBytes()
            inputStream.close()
            
            val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
            val dataUrl = "data:$mimeType;base64,$base64"
            
            return SharedFile(fileName, mimeType, dataUrl)
        } catch (e: Exception) {
            Logger.e("SaveToThymer", "Error reading Uri: $uri", e)
            return null
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  Page Preview — Open Graph Scraper
    // ═══════════════════════════════════════════════════════════════
    //
    //  Fetches a URL and extracts OG metadata (title, image, description).
    //  Strategy:
    //    1. Reddit → vxreddit proxy (bypasses Cloudflare)
    //    2. All others → direct HTTP with open-graph-scraper User-Agent
    //       (Facebook requires this specific UA to serve OG tags)
    //    3. Manual redirect following (HttpURLConnection strips headers on auto-redirect)
    //    4. Cookie management (Facebook sets cookies during redirect chain)
    //
    //  Key finding: Facebook ONLY serves OG tags to the open-graph-scraper UA,
    //  NOT to Chrome's UA. This is why the Node.js library works but curl didn't.
    // ═══════════════════════════════════════════════════════════════

    /**
     * Fetches a URL and extracts Open Graph metadata.
     * Returns JSON: {"title":..., "description":..., "image":..., "url":..., "domain":...}
     * Returns "{}" on failure.
     */
    private fun fetchPagePreview(url: String): String {
        if (url.isEmpty()) {
            Log.d(TAG, "[OG:Kotlin] fetchPagePreview called with empty URL")
            return "{}"
        }

        val isReddit = url.contains("reddit.com")

        return try {
            // Enable cookie management — Facebook requires cookies from redirects
            if (java.net.CookieHandler.getDefault() == null) {
                val cookieManager = java.net.CookieManager()
                cookieManager.setCookiePolicy(java.net.CookiePolicy.ACCEPT_ALL)
                java.net.CookieHandler.setDefault(cookieManager)
            }

            // Build browser-mimicking headers (same as open-graph-scraper Node.js library)
            val headers = mapOf(
                "User-Agent" to "Mozilla/5.0 (compatible; open-graph-scraper/6.0.0; +https://www.npmjs.com/package/open-graph-scraper)",
                "Accept" to "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language" to "en-US",
                "Cache-Control" to "max-age=0",
                "Sec-Fetch-Dest" to "document",
                "Sec-Fetch-Mode" to "navigate",
                "Sec-Fetch-Site" to "none",
                "Sec-Fetch-User" to "?1",
                "Upgrade-Insecure-Requests" to "1",
                "sec-ch-ua" to "\"Google Chrome\";v=\"125\", \"Chromium\";v=\"125\", \"Not.A/Brand\";v=\"24\"",
                "sec-ch-ua-mobile" to "?1",
                "sec-ch-ua-platform" to "\"Android\""
            )

            // Manual redirect loop — HttpURLConnection's auto-redirect strips custom headers and cookies
            Log.d(TAG, "[OG:Kotlin] Fetching page: $url")
            val resolved = fetchWithRedirects(url, headers)
            val ogData = if (isReddit) {
                fetchRedditPreview(resolved)
            } else {
                Log.d(TAG, "[OG:Kotlin] Downloaded ${resolved.body.length} bytes, parsing OG tags...")
                parseOpenGraph(resolved.body, resolved.finalUrl)
            }

            ogData.toPreviewJson(if (isReddit) resolved.finalUrl else url).also {
                Log.d(TAG, "[OG:Kotlin] SUCCESS title=${ogData.title.take(60)} image=${ogData.image.take(60)} domain=${ogData.domain}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "[OG:Kotlin] FAILED: ${e.javaClass.simpleName}: ${e.message}")
            "{}"
        }
    }

    private fun fetchRedditPreview(resolved: FetchResult): OgData {
        Log.d(TAG, "[OG:Kotlin] Parsing Reddit fallback base from ${resolved.finalUrl}")
        val direct = parseOpenGraph(resolved.body, resolved.finalUrl)

        // Fallback 1: vxreddit in embed mode. Normal browser-like requests can redirect
        // to Reddit verification, but bot preview user-agents receive OG image tags.
        val vx = fetchVxRedditPreview(resolved.finalUrl)
        val withVx = direct.mergeCandidate(vx)
        if (withVx.image.isNotBlank()) return withVx

        // Fallback 2: Arctic Shift public archive. This is used only when vxreddit/direct
        // did not provide an image.
        val archive = fetchRedditArchivePreview(resolved.finalUrl)
        return withVx.mergeCandidate(archive)
    }

    private fun fetchVxRedditPreview(redditUrl: String): OgData? {
        val vxUrl = toVxRedditUrl(redditUrl)
        return try {
            Log.d(TAG, "[OG:Kotlin] Fetching Reddit fallback vxreddit: $vxUrl")
            val fetched = fetchWithRedirects(vxUrl, redditEmbedHeaders())
            val data = parseOpenGraph(fetched.body, redditUrl)
            if (data.image.isBlank()) {
                Log.d(TAG, "[OG:Kotlin] vxreddit returned no image for $redditUrl")
            }
            data
        } catch (e: Exception) {
            Log.e(TAG, "[OG:Kotlin] vxreddit fetch failed: ${e.javaClass.simpleName}: ${e.message}")
            null
        }
    }

    private fun redditEmbedHeaders(): Map<String, String> {
        return mapOf(
            "User-Agent" to "Discordbot/2.0",
            "Accept" to "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language" to "en-US",
            "Cache-Control" to "max-age=0"
        )
    }

    private fun toVxRedditUrl(redditUrl: String): String {
        return try {
            val uri = java.net.URI(redditUrl)
            val host = uri.host ?: return redditUrl.replace("reddit.com", "vxreddit.com")
            val vxHost = when {
                host == "reddit.com" -> "vxreddit.com"
                host == "www.reddit.com" -> "www.vxreddit.com"
                host.endsWith(".reddit.com") -> host.replace("reddit.com", "vxreddit.com")
                else -> host
            }
            java.net.URI("https", vxHost, uri.path, uri.query, uri.fragment).toString()
        } catch (e: Exception) {
            redditUrl.replace("reddit.com", "vxreddit.com")
        }
    }

    /** Manually follows HTTP redirects (up to 5 hops), preserving cookies and headers at each hop. */
    private data class FetchResult(val body: String, val finalUrl: String)

    private fun fetchWithRedirects(startUrl: String, headers: Map<String, String>): FetchResult {
        var connection = java.net.URL(startUrl).openConnection() as java.net.HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 8000
        connection.readTimeout = 8000
        connection.instanceFollowRedirects = false
        headers.forEach { (k, v) -> connection.setRequestProperty(k, v) }
        connection.connect()

        var currentUrl = startUrl
        for (hop in 1..5) {
            val sc = connection.responseCode
            Log.d(TAG, "[OG:Kotlin] HTTP $sc for $currentUrl")
            if (sc in 300..399) {
                val location = connection.getHeaderField("Location") ?: break
                currentUrl = java.net.URI(currentUrl).resolve(location).toString()
                Log.d(TAG, "[OG:Kotlin] Redirect $hop → $currentUrl")
                val nextConn = java.net.URL(currentUrl).openConnection() as java.net.HttpURLConnection
                headers.forEach { (k, v) -> nextConn.setRequestProperty(k, v) }
                nextConn.connectTimeout = 8000
                nextConn.readTimeout = 8000
                nextConn.instanceFollowRedirects = false
                connection = nextConn
                connection.connect()
            } else {
                break
            }
        }

        val finalCode = connection.responseCode
        if (finalCode !in 200..299) {
            throw Exception("HTTP $finalCode")
        }
        return FetchResult(
            body = connection.inputStream.bufferedReader().use { it.readText() },
            finalUrl = currentUrl
        )
    }

    /** Parsed Open Graph data from an HTML page. */
    private data class OgData(val title: String, val description: String, val image: String, val domain: String)

    private fun OgData.toPreviewJson(pageUrl: String): String {
        return org.json.JSONObject().apply {
            put("title", title)
            put("description", description.take(300))
            put("image", image)
            put("url", pageUrl)
            put("domain", domain)
        }.toString()
    }

    private fun OgData.mergeCandidate(candidate: OgData?): OgData {
        if (candidate == null) return this
        return OgData(
            title = if (!isBlockedTitle(candidate.title)) candidate.title else title,
            description = candidate.description.ifBlank { description },
            image = candidate.image.ifBlank { image },
            domain = candidate.domain.ifBlank { domain }
        )
    }

    private fun fetchRedditArchivePreview(redditUrl: String): OgData? {
        val postId = redditPostId(redditUrl) ?: return null
        val archiveUrl = "https://arctic-shift.photon-reddit.com/api/posts/ids?ids=$postId"
        return try {
            Log.d(TAG, "[OG:Kotlin] Fetching Reddit archive: $archiveUrl")
            val connection = java.net.URL(archiveUrl).openConnection() as java.net.HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "SaveToThymer/1.0 Android")
            connection.connect()

            val code = connection.responseCode
            Log.d(TAG, "[OG:Kotlin] Reddit archive HTTP $code")
            if (code !in 200..299) return null

            val text = connection.inputStream.bufferedReader().use { it.readText() }
            val post = org.json.JSONObject(text)
                .optJSONArray("data")
                ?.optJSONObject(0)
                ?: return null

            val title = post.optString("title").trim()
            if (isBlockedTitle(title)) return null

            val description = post.optString("selftext").trim()
            val image = redditImageUrl(post)
            if (image.isBlank()) {
                Log.d(TAG, "[OG:Kotlin] Reddit archive returned no image for $postId")
            }
            Log.d(TAG, "[OG:Kotlin] Arctic Shift returned title=${title.take(60)} image=${image.take(60)}")
            OgData(title, description, image, "reddit.com")
        } catch (e: Exception) {
            Log.e(TAG, "[OG:Kotlin] Arctic Shift failed: ${e.javaClass.simpleName}: ${e.message}")
            null
        }
    }

    private fun redditPostId(redditUrl: String): String? {
        return try {
            val segments = java.net.URI(redditUrl).path
                ?.split("/")
                ?.filter { it.isNotBlank() }
                .orEmpty()
            val commentsIndex = segments.indexOf("comments")
            if (commentsIndex < 0 || segments.size <= commentsIndex + 1) return null
            segments[commentsIndex + 1].takeIf { it.matches(Regex("""[A-Za-z0-9_]+""")) }
        } catch (e: Exception) {
            null
        }
    }

    private fun redditImageUrl(post: org.json.JSONObject): String {
        fun clean(url: String): String {
            return url.replace("&amp;", "&").trim()
        }

        fun isImage(url: String): Boolean {
            val normalized = url.lowercase()
            return normalized.contains("i.redd.it") ||
                normalized.contains("preview.redd.it") ||
                normalized.endsWith(".jpg") ||
                normalized.endsWith(".jpeg") ||
                normalized.endsWith(".png") ||
                normalized.endsWith(".webp") ||
                normalized.endsWith(".gif")
        }

        val direct = clean(post.optString("url_overridden_by_dest"))
        if (direct.isNotEmpty() && isImage(direct)) return direct

        val url = clean(post.optString("url"))
        if (url.isNotEmpty() && isImage(url)) return url

        val outbound = post.optJSONObject("outbound_link")
            ?.optString("url")
            ?.let(::clean)
            .orEmpty()
        if (outbound.isNotEmpty() && isImage(outbound)) return outbound

        val preview = post.optJSONObject("preview")
            ?.optJSONArray("images")
            ?.optJSONObject(0)
            ?.optJSONObject("source")
            ?.optString("url")
            ?.let(::clean)
            .orEmpty()
        if (preview.isNotEmpty()) return preview

        val thumbnail = clean(post.optString("thumbnail"))
        return if (thumbnail.startsWith("http")) thumbnail else ""
    }

    private fun isBlockedTitle(title: String): Boolean {
        val normalized = title.trim().lowercase()
        return normalized.isEmpty() ||
            normalized == "shared link" ||
            normalized == "reddit" ||
            normalized == "instagram" ||
            normalized == "facebook" ||
            normalized.contains("please wait for verification") ||
            normalized.contains("cloudflare") ||
            normalized.contains("attention required") ||
            normalized.contains("internal server error") ||
            normalized.contains("500 internal") ||
            normalized.contains("404 not found") ||
            normalized.contains("login") ||
            normalized.contains("log in") ||
            normalized.contains("error")
    }

    private fun cleanSharedTitle(title: String): String {
        return title
            .replace(Regex("""^Check out this post on Reddit:\s*""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""^Check out this post on Facebook:\s*""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""\s*-\s*$"""), "")
            .trim()
    }

    private fun titleFromUrlSlug(url: String): String {
        return try {
            val uri = java.net.URI(url)
            val segments = uri.path
                ?.split("/")
                ?.filter { it.isNotBlank() }
                .orEmpty()
            val commentsIndex = segments.indexOf("comments")
            val slug = if (commentsIndex >= 0 && segments.size > commentsIndex + 2) {
                segments[commentsIndex + 2]
            } else {
                segments.lastOrNull { segment ->
                    segment.contains("-") || segment.contains("_") || (segment.length > 8 && segment.any { it.isLetter() })
                } ?: segments.lastOrNull()
            } ?: ""

            val decoded = java.net.URLDecoder.decode(slug, Charsets.UTF_8.name())
            decoded
                .replace(Regex("""[-_]+"""), " ")
                .trim()
                .replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
        } catch (e: Exception) {
            ""
        }
    }

    /** Extracts OG metadata from HTML using regex (order-independent two-pass approach). */
    private fun parseOpenGraph(html: String, pageUrl: String): OgData {
        fun decodeEntities(text: String): String {
            return android.text.Html.fromHtml(text, android.text.Html.FROM_HTML_MODE_LEGACY).toString()
        }

        fun findMeta(prop: String): String? {
            // Two-pass approach: find <meta> tag with target property/name, then extract content.
            // Works regardless of attribute order (e.g., content before property).
            val tagPattern = Regex(
                """<meta\s[^>]*?(?:property|name)=["']$prop["'][^>]*?>""",
                RegexOption.IGNORE_CASE
            )
            val tagMatch = tagPattern.find(html) ?: return null
            val contentPattern = Regex("""content=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
            val content = contentPattern.find(tagMatch.value)?.groupValues?.get(1)?.trim()
            Log.d(TAG, "[OG:Kotlin] findMeta($prop) → ${content?.take(80)}")
            return content
        }

        val extractedTitle = decodeEntities(
            findMeta("og:title")
                ?: findMeta("twitter:title")
                ?: Regex("""<title[^>]*>([^<]+)</title>""", RegexOption.IGNORE_CASE)
                    .find(html)?.groupValues?.get(1)?.trim()
                ?: sharedTitle
        ).trim()

        val sharedFallback = cleanSharedTitle(sharedTitle)
        val title = when {
            !isBlockedTitle(extractedTitle) -> extractedTitle
            sharedFallback.isNotEmpty() && !isBlockedTitle(sharedFallback) -> sharedFallback
            else -> titleFromUrlSlug(pageUrl).ifEmpty { "Shared Link" }
        }

        val description = decodeEntities(
            findMeta("og:description")
                ?: findMeta("twitter:description")
                ?: findMeta("description")
                ?: ""
        )

        var image = decodeEntities(findMeta("og:image") ?: findMeta("twitter:image") ?: "")
        if (image.isNotEmpty()) {
            image = try {
                java.net.URI(pageUrl).resolve(image).toString()
            } catch (e: Exception) { image }
        }

        val domain = try {
            java.net.URI(pageUrl).host?.removePrefix("www.") ?: ""
        } catch (e: Exception) { "" }

        return OgData(title, description, image, domain)
    }

    // ── Bridges ──

    inner class AndroidStorageBridge {
        private val prefs = getSharedPreferences(ThymerPreferences.NAME, MODE_PRIVATE)

        @JavascriptInterface
        fun getLocal(key: String): String? {
            return prefs.getString(key, null)
        }

        @JavascriptInterface
        fun setLocal(key: String, value: String) {
            prefs.edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun removeLocal(key: String) {
            prefs.edit().remove(key).apply()
        }
    }

    inner class AndroidPageBridge {
        @JavascriptInterface
        fun getSharedUrl(): String = sharedUrl

        @JavascriptInterface
        fun getSharedTitle(): String = sharedTitle

        @JavascriptInterface
        fun getPagePreviewJson(): String {
            Log.d(TAG, "[OG:JS→Kotlin] getPagePreviewJson (sync) called, url=$sharedUrl")
            val result = fetchPagePreview(sharedUrl)
            Log.d(TAG, "[OG:Kotlin→JS] getPagePreviewJson returning, len=${result.length}")
            return result
        }

        @JavascriptInterface
        fun fetchPagePreviewAsync() {
            Log.d(TAG, "[OG:JS→Kotlin] fetchPagePreviewAsync called, url=$sharedUrl")
            Thread {
                val result = fetchPagePreview(sharedUrl)
                Log.d(TAG, "[OG:BG] fetch complete, len=${result.length} isError=${result == "{}"}")
                runOnUiThread {
                    Log.d(TAG, "[OG:Kotlin→JS] Delivering to onPagePreviewResult")
                    // Escape for safe JS string literal — wrap in single quotes
                    val escapedResult = result
                        .replace("\\", "\\\\")
                        .replace("'", "\\'")
                    popupWebView.evaluateJavascript(
                        "if(window.onPagePreviewResult)window.onPagePreviewResult('$escapedResult');else console.error('[OG] onPagePreviewResult not defined!')",
                        null
                    )
                }
            }.start()
        }

        @JavascriptInterface
        fun debugLog(level: String, msg: String) {
            val logLevel = when (level.lowercase()) {
                "error", "e" -> Log.ERROR
                "warn", "w" -> Log.WARN
                else -> Log.DEBUG
            }
            Log.println(logLevel, "$TAG:JS:Bridge", msg)
        }

        @JavascriptInterface
        fun getSharedFilesJson(): String {
            val array = org.json.JSONArray()
            for (f in sharedFiles) {
                val obj = org.json.JSONObject()
                obj.put("name", f.name)
                obj.put("mimeType", f.mimeType)
                obj.put("dataUrl", f.base64Data)
                array.put(obj)
            }
            return array.toString()
        }

        @JavascriptInterface
        fun closeApp() {
            runOnUiThread {
                finish()
            }
        }

        @JavascriptInterface
        fun triggerHapticFeedback() {
            runOnUiThread {
                cardLayout.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
            }
        }

        @JavascriptInterface
        fun updateHeight(heightDp: Int) {
            runOnUiThread {
                val metrics = resources.displayMetrics
                val density = metrics.density
                
                // Calculate dynamic maximum height based on the safe area availableHeightPx
                val maxAllowedHeightPx = (availableHeightPx * 0.85).toInt()
                val maxAllowedHeightDp = (maxAllowedHeightPx / density).toInt()
                
                val targetHeightDp = maxOf(150, minOf(heightDp, maxAllowedHeightDp))
                val targetHeightPx = (targetHeightDp * density + 0.5f).toInt()

                val params = cardLayout.layoutParams as FrameLayout.LayoutParams
                if (params.height != targetHeightPx) {
                    params.height = targetHeightPx
                    cardLayout.layoutParams = params
                }
            }
        }
    }

    inner class AndroidThymerBridge {
        @JavascriptInterface
        fun sendMessageToThymer(msgId: String, messageJson: String) {
            runOnUiThread {
                if (isThymerWebViewLoaded) {
                    dispatchMessageToThymerWebView(msgId, messageJson)
                } else {
                    pendingMessages.add(Pair(msgId, messageJson))
                }
            }
        }

        @JavascriptInterface
        fun postResponseToApp(msgId: String, responseJson: String) {
            runOnUiThread {
                val base64Json = Base64.encodeToString(responseJson.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                // Same fix: use TextDecoder so non-ASCII chars in responses are preserved correctly.
                popupWebView.evaluateJavascript("window.receiveResponseFromThymer('$msgId', new TextDecoder('utf-8').decode(Uint8Array.from(atob('$base64Json'), c => c.charCodeAt(0))))", null)
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (filePathCallback == null) return
            val results = if (resultCode == RESULT_OK && data != null) {
                val dataString = data.dataString
                val clipData = data.clipData
                if (clipData != null) {
                    Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
                } else if (dataString != null) {
                    arrayOf(android.net.Uri.parse(dataString))
                } else {
                    null
                }
            } else {
                null
            }
            filePathCallback?.onReceiveValue(results)
            filePathCallback = null
        }
    }
}
