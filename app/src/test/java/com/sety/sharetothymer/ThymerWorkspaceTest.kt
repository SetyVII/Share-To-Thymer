package com.sety.sharetothymer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThymerWorkspaceTest {
    @Test
    fun normalizeManualInput_buildsWorkspaceUrlFromSubdomain() {
        assertEquals(
            "https://acme.thymer.com/",
            ThymerWorkspace.normalizeManualInput("acme"),
        )
    }

    @Test
    fun normalizeManualInput_keepsValidWorkspaceUrl() {
        assertEquals(
            "https://acme.thymer.com/",
            ThymerWorkspace.normalizeManualInput("https://acme.thymer.com"),
        )
    }

    @Test
    fun normalizeManualInput_rejectsNonThymerUrl() {
        assertNull(ThymerWorkspace.normalizeManualInput("https://example.com"))
    }

    @Test
    fun detectWorkspaceUrl_ignoresLoginDomain() {
        assertNull(ThymerWorkspace.detectWorkspaceUrl("https://login.thymer.com/"))
    }

    @Test
    fun detectWorkspaceUrl_returnsWorkspaceForValidDomain() {
        assertEquals(
            ThymerWorkspace.DetectedWorkspace(
                url = "https://acme.thymer.com/",
                subdomain = "acme",
            ),
            ThymerWorkspace.detectWorkspaceUrl("https://acme.thymer.com/tasks"),
        )
    }

    @Test
    fun isInternalThymerUrl_keepsThymerUrlsInternal() {
        assertTrue(
            ThymerWorkspace.isInternalThymerUrl(
                urlString = "https://assets.thymer.com/app.js",
                workspaceUrl = "https://acme.thymer.com/",
            ),
        )
    }

    @Test
    fun isInternalThymerUrl_rejectsExternalUrls() {
        assertFalse(
            ThymerWorkspace.isInternalThymerUrl(
                urlString = "https://example.com/",
                workspaceUrl = "https://acme.thymer.com/",
            ),
        )
    }
}
