package com.sety.sharetothymer

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import com.sety.sharetothymer.utils.Logger
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.view.GestureDetector
import android.view.MotionEvent
import kotlin.math.abs

class MainActivity : ComponentActivity() {

    private lateinit var container: FrameLayout
    private lateinit var webView: WebView
    private var thymerUrl: String? = null
    private lateinit var gestureDetector: GestureDetector

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (intent.action == ACTION_TOGGLE_GESTURES) {
            toggleGestures()
            finish()
            return
        }

        // Set up ServiceWorkerClient to intercept service worker resource requests
        try {
            ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
                override fun shouldInterceptRequest(request: WebResourceRequest?): WebResourceResponse? {
                    if (request == null) return null
                    return patchJavascriptResource(request.url.toString(), request.requestHeaders)
                }
            })
        } catch (e: Exception) {
            Logger.e("SaveToThymer", "Error setting ServiceWorkerClient: ${e.message}", e)
        }

        container = FrameLayout(this)
        setContentView(container)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::webView.isInitialized && webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        })

        // Adjust padding to avoid overlapping with status bar, navigation bars, and soft keyboard
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val statusBarInsets = insets.getInsets(WindowInsetsCompat.Type.statusBars())
            val navBarInsets = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
            
            val bottomPadding = if (imeInsets.bottom > 0) imeInsets.bottom else navBarInsets.bottom
            
            view.setPadding(
                statusBarInsets.left,
                statusBarInsets.top,
                statusBarInsets.right,
                bottomPadding
            )
            insets
        }

        // Initialize gesture detector for left-to-right swiping to open sidebar
        gestureDetector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            private val SWIPE_THRESHOLD = 100
            private val SWIPE_VELOCITY_THRESHOLD = 150

            override fun onFling(
                e1: MotionEvent?,
                e2: MotionEvent,
                velocityX: Float,
                velocityY: Float
            ): Boolean {
                Logger.d("SaveToThymer", "onFling detected: velocityX=$velocityX, velocityY=$velocityY")
                if (e1 == null) {
                    Logger.d("SaveToThymer", "onFling failed: e1 is null")
                    return false
                }
                val diffY = e2.y - e1.y
                val diffX = e2.x - e1.x
                Logger.d("SaveToThymer", "onFling metrics: diffX=$diffX, diffY=$diffY")
                if (abs(diffX) > abs(diffY)) {
                    if (abs(diffX) > SWIPE_THRESHOLD && abs(velocityX) > SWIPE_VELOCITY_THRESHOLD) {
                        if (diffX > 0) {
                            Logger.d("SaveToThymer", "onFling MATCHED: Swipe right triggered!")
                            triggerSidebarOpen()
                            return true
                        } else {
                            Logger.d("SaveToThymer", "onFling MATCHED: Swipe left triggered!")
                            triggerSidebarClose()
                            return true
                        }
                    }
                }
                return false
            }
        })

        // Read saved URL from preferences
        val prefs = getSharedPreferences(ThymerPreferences.NAME, Context.MODE_PRIVATE)
        thymerUrl = prefs.getString(ThymerPreferences.WORKSPACE_URL_KEY, null)
        updateGestureShortcut()

        if (thymerUrl == null) {
            showSetupScreen()
        } else {
            showWebView(thymerUrl!!)
        }
    }

    private fun showSetupScreen() {
        container.removeAllViews()

        val context = this
        val layout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dpToPx(24), dpToPx(24), dpToPx(24), dpToPx(24))
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        }

        val isDarkMode = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

        val title = TextView(context).apply {
            text = "Save to Thymer"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            setTextColor(if (isDarkMode) android.graphics.Color.WHITE else ColorHex("#1e293b"))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dpToPx(16))
        }

        val desc = TextView(context).apply {
            text = "Connect your Thymer workspace to save links and content. Log in to auto-detect your workspace, or enter it manually below:"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(if (isDarkMode) ColorHex("#94a3b8") else ColorHex("#64748b"))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dpToPx(24))
        }

        val autoLoginBtn = Button(context).apply {
            text = "Log In & Auto-Detect Workspace"
            setBackgroundColor(ColorHex("#059669")) // Emerald Green
            setTextColor(android.graphics.Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dpToPx(8)
            }
        }

        autoLoginBtn.setOnClickListener {
            showWebView("https://login.thymer.com/")
        }

        val separator = TextView(context).apply {
            text = "— OR ENTER MANUALLY —"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setTextColor(if (isDarkMode) ColorHex("#475569") else ColorHex("#94a3b8"))
            gravity = Gravity.CENTER
            setPadding(0, dpToPx(16), 0, dpToPx(16))
        }

        val input = EditText(context).apply {
            hint = "workspace-name"
            setSingleLine(true)
            setPadding(dpToPx(12), dpToPx(12), dpToPx(12), dpToPx(12))
            setTextColor(if (isDarkMode) android.graphics.Color.WHITE else android.graphics.Color.BLACK)
            setHintTextColor(if (isDarkMode) ColorHex("#64748b") else ColorHex("#94a3b8"))
        }

        // Add suffix text helper
        val suffixDesc = TextView(context).apply {
            text = "It will connect to: https://[your-subdomain].thymer.com/"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setTextColor(if (isDarkMode) ColorHex("#64748b") else ColorHex("#94a3b8"))
            gravity = Gravity.CENTER
            setPadding(0, dpToPx(4), 0, dpToPx(24))
        }

        val connectBtn = Button(context).apply {
            text = "Connect Workspace"
            setBackgroundColor(ColorHex("#2563eb"))
            setTextColor(android.graphics.Color.WHITE)
        }

        connectBtn.setOnClickListener {
            val rawInput = input.text.toString().trim()
            if (rawInput.isEmpty()) {
                Toast.makeText(context, "Please enter a subdomain or URL", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            val targetUrl = ThymerWorkspace.normalizeManualInput(rawInput)
            if (targetUrl == null) {
                Toast.makeText(context, "Only Thymer workspaces (*.thymer.com) are allowed", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            // Save to preferences
            val prefs = getSharedPreferences(ThymerPreferences.NAME, Context.MODE_PRIVATE)
            prefs.edit().putString(ThymerPreferences.WORKSPACE_URL_KEY, targetUrl).apply()
            thymerUrl = targetUrl

            showWebView(targetUrl)
            invalidateOptionsMenu() // Show the menu to reset workspace
        }

        layout.addView(title)
        layout.addView(desc)
        layout.addView(autoLoginBtn)
        layout.addView(separator)
        layout.addView(input)
        layout.addView(suffixDesc)
        layout.addView(connectBtn)

        container.addView(layout)
    }

    private fun checkAndSaveWorkspaceUrl(urlString: String): Boolean {
        if (thymerUrl != null) return false
        val workspace = ThymerWorkspace.detectWorkspaceUrl(urlString) ?: return false

        val prefs = getSharedPreferences(ThymerPreferences.NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(ThymerPreferences.WORKSPACE_URL_KEY, workspace.url).apply()
        thymerUrl = workspace.url

        runOnUiThread {
            Toast.makeText(this, "Workspace connected: ${workspace.subdomain}", Toast.LENGTH_LONG).show()
            invalidateOptionsMenu()
        }
        return true
    }

    private fun patchJavascriptResource(urlString: String, requestHeaders: Map<String, String>): WebResourceResponse? {
        if (urlString.contains(".thymer.com") && 
            (urlString.contains("/js/frontend/app-") || urlString.contains("/js/backend/worker-")) && 
            urlString.endsWith(".js")) {
            try {
                val connection = URL(urlString).openConnection() as HttpURLConnection
                connection.requestMethod = "GET"
                connection.useCaches = false
                connection.defaultUseCaches = false
                connection.setRequestProperty("Cache-Control", "no-cache")
                connection.setRequestProperty("Pragma", "no-cache")
                
                requestHeaders.forEach { (key, value) ->
                    val lowerKey = key.lowercase()
                    if (lowerKey != "if-none-match" && lowerKey != "if-modified-since") {
                        connection.setRequestProperty(key, value)
                    }
                }
                connection.connect()

                if (connection.responseCode == 200) {
                    val mimeType = connection.contentType?.split(";")?.firstOrNull()?.trim() ?: "application/javascript"
                    val encoding = connection.contentEncoding ?: "UTF-8"
                    val content = connection.inputStream.bufferedReader().use { it.readText() }

                    val patchResult = ThymerJavascriptPatcher.patch(content)
                    patchResult.appliedPatches.forEach { patchName ->
                        Logger.d("SaveToThymer", "Patched regex ($patchName)")
                    }

                    if (patchResult.wasModified) {
                        val dataStream = ByteArrayInputStream(patchResult.content.toByteArray(charset(encoding)))
                        return WebResourceResponse(mimeType, encoding, dataStream)
                    }
                }
            } catch (e: Exception) {
                Logger.e("SaveToThymer", "Error intercepting/patching request: ${e.message}", e)
            }
        }
        return null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebView(url: String) {
        container.removeAllViews()

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        }
        container.addView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (url != null) {
                    checkAndSaveWorkspaceUrl(url)
                }
            }

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                if (request == null) return null
                val response = patchJavascriptResource(request.url.toString(), request.requestHeaders)
                if (response != null) return response
                return super.shouldInterceptRequest(view, request)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: android.webkit.WebResourceRequest
            ): Boolean {
                val url = request.url
                val urlString = url.toString()

                // Check if this URL is a workspace domain during auto-detection
                if (thymerUrl == null) {
                    if (checkAndSaveWorkspaceUrl(urlString)) {
                        return false // Let WebView load it internally
                    }
                }

                // Handle non-http/https schemes (like mailto:, tel:, intents)
                val scheme = url.scheme
                if (scheme != "http" && scheme != "https") {
                    try {
                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, url)
                        view.context.startActivity(intent)
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                    return true
                }

                val isInternal = ThymerWorkspace.isInternalThymerUrl(urlString, thymerUrl)

                if (isInternal) {
                    // Let WebView load the URL internally
                    return false
                } else {
                    // Open in external browser/app
                    try {
                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, url)
                        view.context.startActivity(intent)
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                    return true
                }
            }
        }

        webView.loadUrl(url)
    }

    override fun onCreateOptionsMenu(menu: Menu?): Boolean {
        if (thymerUrl != null) {
            menu?.add(0, 1, 0, "Reset Workspace")
        }
        return super.onCreateOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == 1) {
            val prefs = getSharedPreferences(ThymerPreferences.NAME, Context.MODE_PRIVATE)
            prefs.edit().remove(ThymerPreferences.WORKSPACE_URL_KEY).apply()
            thymerUrl = null
            showSetupScreen()
            invalidateOptionsMenu()
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    private fun dpToPx(dp: Int): Int {
        val scale = resources.displayMetrics.density
        return (dp * scale + 0.5f).toInt()
    }

    private fun ColorHex(hex: String): Int {
        return android.graphics.Color.parseColor(hex)
    }

    private fun triggerSidebarOpen() {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(
            """
            (function() {
                // 1. Check if sidebar is already open on mobile
                const isOpen = !!document.querySelector('.sidebar.mobile-open');
                if (isOpen) return 'already_open';

                // 2. Try to click the hamburger toggle button
                const hamburger = document.querySelector('[event="onToggleMobileSidebar"]') || 
                                  document.querySelector('.panel-bar--hamburger') || 
                                  document.querySelector('.ti-menu-2');
                if (hamburger) {
                    hamburger.click();
                    return 'clicked_hamburger';
                }
                return 'not_found';
            })();
            """.trimIndent()
        ) { result ->
            Logger.d("SaveToThymer", "OPEN RESULT: $result")
        }
    }

    private fun triggerSidebarClose() {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(
            """
            (function() {
                // 1. Check if sidebar is open
                const isOpen = !!document.querySelector('.sidebar.mobile-open');
                if (!isOpen) return 'already_closed';

                // 2. Click the hamburger button to toggle it closed
                const hamburger = document.querySelector('[event="onToggleMobileSidebar"]') || 
                                  document.querySelector('.panel-bar--hamburger') || 
                                  document.querySelector('.ti-menu-2');
                if (hamburger) {
                    hamburger.click();
                    return 'clicked_hamburger_close';
                }
                return 'not_found';
            })();
            """.trimIndent()
        ) { result ->
            Logger.d("SaveToThymer", "CLOSE RESULT: $result")
        }
    }

    override fun dispatchTouchEvent(ev: MotionEvent?): Boolean {
        if (ev != null && ev.action != MotionEvent.ACTION_MOVE) {
            Logger.d("SaveToThymer", "dispatchTouchEvent: ACTION=${ev.action}, x=${ev.x}, y=${ev.y}")
        }
        if (ev != null && ::gestureDetector.isInitialized && areGesturesEnabled()) {
            gestureDetector.onTouchEvent(ev)
        }
        return super.dispatchTouchEvent(ev)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ACTION_TOGGLE_GESTURES) {
            setIntent(intent)
            toggleGestures()
        }
    }

    private fun areGesturesEnabled(): Boolean =
        getSharedPreferences(ThymerPreferences.NAME, Context.MODE_PRIVATE)
            .getBoolean(ThymerPreferences.GESTURES_ENABLED_KEY, true)

    private fun toggleGestures() {
        val enabled = !areGesturesEnabled()
        getSharedPreferences(ThymerPreferences.NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(ThymerPreferences.GESTURES_ENABLED_KEY, enabled)
            .apply()
        updateGestureShortcut(enabled)
        Toast.makeText(
            this,
            if (enabled) R.string.gestures_enabled else R.string.gestures_disabled,
            Toast.LENGTH_SHORT
        ).show()
    }

    private fun updateGestureShortcut(gesturesEnabled: Boolean = areGesturesEnabled()) {
        val shortcut = ShortcutInfo.Builder(this, GESTURE_SHORTCUT_ID)
            .setShortLabel(
                getString(
                    if (gesturesEnabled) R.string.shortcut_disable_gestures
                    else R.string.shortcut_enable_gestures
                )
            )
            .setLongLabel(
                getString(
                    if (gesturesEnabled) R.string.shortcut_disable_gestures
                    else R.string.shortcut_enable_gestures
                )
            )
            .setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher))
            .setIntent(Intent(this, MainActivity::class.java).setAction(ACTION_TOGGLE_GESTURES))
            .build()
        getSystemService(ShortcutManager::class.java).dynamicShortcuts = listOf(shortcut)
    }

    companion object {
        private const val ACTION_TOGGLE_GESTURES = "com.sety.sharetothymer.action.TOGGLE_GESTURES"
        private const val GESTURE_SHORTCUT_ID = "toggle_gestures"
    }
}
