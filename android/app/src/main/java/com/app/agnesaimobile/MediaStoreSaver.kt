package com.app.agnesaimobile

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.net.HttpURLConnection
import java.net.URL

object MediaStoreSaver {
  fun saveFromUrl(context: Context, resultUrl: String, taskId: String, video: Boolean): Uri {
    val resolver = context.contentResolver
    val collection = if (Build.VERSION.SDK_INT >= 29) {
      if (video) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    } else if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    else MediaStore.Images.Media.EXTERNAL_CONTENT_URI

    val extension = if (video) "mp4" else "png"
    val mime = if (video) "video/mp4" else "image/png"
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, "agnes-$taskId.$extension")
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      if (Build.VERSION.SDK_INT >= 29) {
        put(MediaStore.MediaColumns.RELATIVE_PATH, if (video) "${Environment.DIRECTORY_MOVIES}/Agnes-AI" else "${Environment.DIRECTORY_PICTURES}/Agnes-AI")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
    }

    val uri = resolver.insert(collection, values) ?: error("MediaStore insert failed")
    try {
      val connection = URL(resultUrl).openConnection() as HttpURLConnection
      connection.connectTimeout = 30_000
      connection.readTimeout = 120_000
      connection.instanceFollowRedirects = true
      connection.requestMethod = "GET"
      if (connection.responseCode !in 200..299) error("Не удалось скачать результат: HTTP ${connection.responseCode}")
      connection.inputStream.use { input ->
        resolver.openOutputStream(uri, "w")!!.use { output -> input.copyTo(output) }
      }
      connection.disconnect()
      if (Build.VERSION.SDK_INT >= 29) {
        resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
      }
      return uri
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
  }
}
