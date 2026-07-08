package com.sety.sharetothymer.utils

import android.util.Log
import com.sety.sharetothymer.BuildConfig

object Logger {
    fun d(tag: String, msg: String) {
        if (BuildConfig.DEBUG) {
            Log.d(tag, msg)
        }
    }

    fun e(tag: String, msg: String) {
        if (BuildConfig.DEBUG) {
            Log.e(tag, msg)
        }
    }

    fun e(tag: String, msg: String, tr: Throwable) {
        if (BuildConfig.DEBUG) {
            Log.e(tag, msg, tr)
        }
    }
}
