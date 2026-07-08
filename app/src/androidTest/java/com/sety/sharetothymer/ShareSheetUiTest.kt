package com.sety.sharetothymer

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShareSheetUiTest {

    private lateinit var device: UiDevice
    private val targetPackage = "com.sety.sharetothymer"

    @Before
    fun setUp() {
        // Initialize UiDevice instance
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    }

    @Test
    fun testShareVideoUrlIntent_opensShareActivity() {
        // Start from the home screen to have a clean environment
        device.pressHome()

        // Wait for launcher
        val launcherPackage: String = device.launcherPackageName
        assertNotNull("Launcher package should not be null", launcherPackage)
        device.wait(Until.hasObject(By.pkg(launcherPackage).depth(0)), 5000)

        // Pre-configure the thymer URL in SharedPreferences
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences("SaveToThymerPrefs", Context.MODE_PRIVATE)
        prefs.edit().putString("thymer_url", "https://testworkspace.thymer.com/").commit()

        // Create explicit intent to launch ShareActivity representing a video shared from YouTube/Browser
        val intent = Intent(Intent.ACTION_SEND).apply {
            component = android.content.ComponentName(targetPackage, "$targetPackage.ShareActivity")
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "Check this video: https://www.youtube.com/watch?v=dQw4w9WgXcQ")
            putExtra(Intent.EXTRA_SUBJECT, "Rick Astley - Never Gonna Give You Up")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }

        // Launch the activity
        context.startActivity(intent)

        // Verify ShareActivity starts and package is visible
        assertTrue(
            "ShareActivity did not open or package did not appear",
            device.wait(Until.hasObject(By.pkg(targetPackage).depth(0)), 5000)
        )

        // Verify the WebView loads in ShareActivity
        val webView = device.wait(Until.findObject(By.clazz("android.webkit.WebView")), 10000)
        assertNotNull("WebView did not load in ShareActivity", webView)
    }

    @Test
    fun testShareTextOnlyIntent_opensShareActivity() {
        // Start from home screen
        device.pressHome()

        // Pre-configure thymer URL
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences("SaveToThymerPrefs", Context.MODE_PRIVATE)
        prefs.edit().putString("thymer_url", "https://testworkspace.thymer.com/").commit()

        // Share text representing general content
        val intent = Intent(Intent.ACTION_SEND).apply {
            component = android.content.ComponentName(targetPackage, "$targetPackage.ShareActivity")
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "Some random text to share without URLs")
            putExtra(Intent.EXTRA_SUBJECT, "General Article or Note")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }

        // Launch the activity
        context.startActivity(intent)

        // Verify the package is visible
        assertTrue(
            "ShareActivity did not open or package did not appear for text share",
            device.wait(Until.hasObject(By.pkg(targetPackage).depth(0)), 5000)
        )

        // Verify WebView loads
        val webView = device.wait(Until.findObject(By.clazz("android.webkit.WebView")), 10000)
        assertNotNull("WebView did not load in ShareActivity for text share", webView)
    }
}
