package com.sety.sharetothymer

import java.net.URI

object ThymerWorkspace {
    private val ignoredAutoDetectSubdomains = setOf("login", "www", "auth", "api", "assets", "static")

    data class DetectedWorkspace(
        val url: String,
        val subdomain: String,
    )

    fun normalizeManualInput(rawInput: String): String? {
        val trimmedInput = rawInput.trim()
        if (trimmedInput.isEmpty()) return null

        val urlWithScheme = if (trimmedInput.startsWith("http://") || trimmedInput.startsWith("https://")) {
            trimmedInput
        } else {
            "https://$trimmedInput.thymer.com/"
        }

        val normalizedUrl = urlWithScheme.ensureTrailingSlash()
        val host = runCatching { URI(normalizedUrl).host }.getOrNull() ?: return null
        if (!host.endsWith(".thymer.com")) return null

        return normalizedUrl
    }

    fun detectWorkspaceUrl(urlString: String): DetectedWorkspace? {
        val uri = runCatching { URI(urlString) }.getOrNull() ?: return null
        val host = uri.host ?: return null
        if (!host.endsWith("thymer.com")) return null

        val parts = host.split(".")
        if (parts.size < 3) return null

        val subdomain = parts[parts.size - 3].lowercase()
        if (subdomain in ignoredAutoDetectSubdomains) return null

        val scheme = uri.scheme ?: "https"
        return DetectedWorkspace(
            url = "$scheme://$host/",
            subdomain = subdomain,
        )
    }

    fun isInternalThymerUrl(urlString: String, workspaceUrl: String?): Boolean {
        val uri = runCatching { URI(urlString) }.getOrNull() ?: return false
        val urlHost = uri.host ?: return false

        if (workspaceUrl == null) {
            return urlHost.endsWith("thymer.com")
        }

        val workspaceHost = runCatching { URI(workspaceUrl).host }.getOrNull()
        return if (workspaceHost != null) {
            urlHost.endsWith(workspaceHost) ||
                urlHost.endsWith("thymer.com") ||
                urlString.startsWith(workspaceUrl)
        } else {
            urlString.startsWith(workspaceUrl)
        }
    }

    private fun String.ensureTrailingSlash(): String = if (endsWith("/")) this else "$this/"
}
