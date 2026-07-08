package com.sety.sharetothymer

object ThymerJavascriptPatcher {
    private const val ORIGINAL_TIME_REGEX =
        """/\b(?<hours>\d{1,2})(?::(?<minutes>\d{2})\s*(?<ampm>am|pm|a|p)?|\s*(?<ampm>am|pm|a|p))\b/i"""
    private const val PATCHED_TIME_REGEX =
        """/\b(?<hours>\d{1,2})(?=(?::\d{2})|\s*(?:am|pm|a|p))(?::(?<minutes>\d{2}))?\s*(?<ampm>am|pm|a|p)?\b/i"""

    private const val ORIGINAL_ACTION_KEY_REGEX =
        """/^(?:"(?<action>[^"]*)"|'(?<action>[^']*)')\s*:\s*(?:"(?<key>[^"]*)"|'(?<key>[^']*)')\s*,?/"""
    private const val PATCHED_ACTION_KEY_REGEX =
        """/^(?:(["'])(?<action>(?:(?!\1).)*)\1)\s*:\s*(?:(["'])(?<key>(?:(?!\3).)*)\3)\s*,?/"""

    data class Result(
        val content: String,
        val appliedPatches: List<String>,
    ) {
        val wasModified: Boolean = appliedPatches.isNotEmpty()
    }

    fun patch(content: String): Result {
        var patchedContent = content
        val patches = mutableListOf<String>()

        if (patchedContent.contains(ORIGINAL_TIME_REGEX)) {
            patchedContent = patchedContent.replace(ORIGINAL_TIME_REGEX, PATCHED_TIME_REGEX)
            patches += "hours/minutes/ampm"
        }

        if (patchedContent.contains(ORIGINAL_ACTION_KEY_REGEX)) {
            patchedContent = patchedContent.replace(ORIGINAL_ACTION_KEY_REGEX, PATCHED_ACTION_KEY_REGEX)
            patches += "action/key"
        }

        return Result(patchedContent, patches)
    }
}
