package com.app.agnesaimobile

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object AgnesDiagnostics {
  private const val PREFS = "agnes_diagnostics"
  private const val KEY = "events"
  private const val MAX_EVENTS = 500

  @Synchronized
  fun log(context: Context, taskId: String?, stage: String, detail: String = "") {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
    val safe = detail.replace("\n", " ").replace("Bearer ", "Bearer [masked]")
    val line = "[$timestamp] task=${taskId ?: "-"} stage=$stage${if (safe.isBlank()) "" else " detail=$safe"}"
    val lines = prefs.getString(KEY, "").orEmpty().split("\n").filter { it.isNotBlank() }.takeLast(MAX_EVENTS - 1) + line
    prefs.edit().putString(KEY, lines.joinToString("\n")).apply()
    android.util.Log.i("AgnesAI", line)
  }

  fun read(context: Context): String = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "").orEmpty()
  fun clear(context: Context) { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply() }
}
