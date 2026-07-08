package com.sety.sharetothymer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThymerJavascriptPatcherTest {
    @Test
    fun patch_replacesKnownRegexes() {
        val originalContent = """
            const time = /\b(?<hours>\d{1,2})(?::(?<minutes>\d{2})\s*(?<ampm>am|pm|a|p)?|\s*(?<ampm>am|pm|a|p))\b/i;
            const shortcut = /^(?:"(?<action>[^"]*)"|'(?<action>[^']*)')\s*:\s*(?:"(?<key>[^"]*)"|'(?<key>[^']*)')\s*,?/;
        """.trimIndent()

        val result = ThymerJavascriptPatcher.patch(originalContent)

        assertTrue(result.wasModified)
        assertEquals(listOf("hours/minutes/ampm", "action/key"), result.appliedPatches)
        assertTrue(result.content.contains("""(?=(?::\d{2})|\s*(?:am|pm|a|p))"""))
        assertTrue(result.content.contains("""(?:(["'])(?<action>(?:(?!\1).)*)\1)"""))
    }

    @Test
    fun patch_returnsOriginalContentWhenNothingMatches() {
        val originalContent = "const untouched = true;"

        val result = ThymerJavascriptPatcher.patch(originalContent)

        assertFalse(result.wasModified)
        assertEquals(originalContent, result.content)
    }
}
