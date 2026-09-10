package com.app.agnesaimobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class GenerationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
  companion object {
    const val KEY_TASK_ID = "taskId"
    const val KEY_KIND = "kind"
    const val KEY_API_KEY = "apiKey"
    const val KEY_PAYLOAD = "payloadJson"
    const val KEY_POLL_INTERVAL_SEC = "pollIntervalSec"
    private const val CHANNEL_ID = "agnes_progress"
    private const val COMPLETE_CHANNEL_ID = "agnes_completed"
    private const val ERROR_CHANNEL_ID = "agnes_errors"
    private const val NOTIFICATION_ID = 4711
  }

  override suspend fun doWork(): Result {
    val taskId = inputData.getString(KEY_TASK_ID) ?: return failure("Не указан идентификатор задачи")
    val kind = inputData.getString(KEY_KIND) ?: "video"
    val key = inputData.getString(KEY_API_KEY) ?: return failure("Не указан Agnes AI API key")
    val payload = inputData.getString(KEY_PAYLOAD) ?: return failure("Пустой payload задачи")
    val pollIntervalSec = inputData.getInt(KEY_POLL_INTERVAL_SEC, 15).coerceIn(5, 120)

    return try {
      setForeground(foregroundInfo("Подготовка задачи", 5, taskId))
      val submitPath = if (kind == "image") "/v1/images/generations" else "/v1/videos"
      val submitted = requestJson("https://apihub.agnes-ai.com$submitPath", key, payload)
      if (kind == "image") {
        val first = submitted.optJSONArray("data")?.optJSONObject(0)
        val resultUrl = first?.optString("url").orEmpty().ifBlank { first?.optString("image_url").orEmpty() }
          .ifBlank { submitted.optString("url") }
        if (resultUrl.isBlank()) return failure("API не вернул ссылку на изображение")
        val uri = MediaStoreSaver.saveFromUrl(applicationContext, resultUrl, taskId, false)
        notifyCompleted(uri, "Фото готово", "Изображение сохранено в Pictures/Agnes-AI")
        setProgress(Data.Builder().putInt("progress", 100).build())
        setForeground(foregroundInfo("Изображение готово", 100, taskId))
        return Result.success(Data.Builder().putString("localUri", uri.toString()).putString("resultUrl", resultUrl).build())
      }

      val videoId = submitted.optString("video_id").ifBlank { submitted.optString("id") }
      val modelName = JSONObject(payload).optString("model")
      if (videoId.isBlank()) return failure("API не вернул video_id")
      var resultUrl: String? = null
      for (attempt in 0 until 240) {
        if (isStopped) return failure("Задача остановлена пользователем")
        delay(pollIntervalSec * 1000L)
        val pollUrl = "https://apihub.agnes-ai.com/agnesapi?video_id=${Uri.encode(videoId)}" +
          if (modelName.isNotBlank()) "&model_name=${Uri.encode(modelName)}" else ""
        val poll = requestJson(pollUrl, key, null)
        resultUrl = poll.optJSONObject("metadata")?.optString("url").orEmpty()
          .ifBlank { poll.optString("url") }
          .ifBlank { poll.optString("video_url") }
        val status = poll.optString("status", "processing").lowercase()
        if (status == "failed" || status == "error") return failure(poll.optString("error", "Сервер сообщил об ошибке видео"))
        if (!resultUrl.isNullOrBlank() && status != "processing") break
        if (status == "completed" || status == "success" || status == "finished") break
        val progress = minOf(95, 40 + (attempt + 1) * 55 / 240)
        setProgress(Data.Builder().putInt("progress", progress).build())
        setForeground(foregroundInfo("Рендеринг видео · опрос ${attempt + 1}", progress, taskId))
      }
      if (resultUrl.isNullOrBlank()) return failure("Истекло время ожидания готового видео")
      val finalResultUrl = resultUrl ?: return failure("Истекло время ожидания готового видео")
      val uri = MediaStoreSaver.saveFromUrl(applicationContext, finalResultUrl, taskId, true)
      notifyCompleted(uri, "Видео готово", "Видео сохранено в Movies/Agnes-AI")
      setProgress(Data.Builder().putInt("progress", 100).build())
      setForeground(foregroundInfo("Видео сохранено", 100, taskId))
      Result.success(Data.Builder().putString("localUri", uri.toString()).putString("resultUrl", finalResultUrl).build())
    } catch (error: RetryableHttpException) {
      retryOrFailure(error.message ?: "Временная ошибка API")
    } catch (error: IOException) {
      Result.retry()
    } catch (error: Exception) {
      failure(error.message ?: "Ошибка native Worker")
    }
  }

  private fun retryOrFailure(message: String): Result {
    return if (runAttemptCount < 4) Result.retry() else failure(message)
  }

  private fun failure(message: String): Result = Result.failure(Data.Builder().putString("errorMessage", message).build())

  private fun requestJson(url: String, apiKey: String, body: String?): JSONObject {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = if (body == null) "GET" else "POST"
      connection.connectTimeout = 30_000
      connection.readTimeout = 120_000
      connection.instanceFollowRedirects = true
      connection.setRequestProperty("Authorization", "Bearer $apiKey")
      connection.setRequestProperty("Content-Type", "application/json")
      if (body != null) {
        connection.doOutput = true
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      }
      val status = connection.responseCode
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
      if (status !in 200..299) {
        val retryable = status == 408 || status == 425 || status == 429 || status in 500..599
        if (retryable) throw RetryableHttpException("Agnes API HTTP $status: ${text.take(500)}")
        error("Agnes API HTTP $status: ${text.take(500)}")
      }
      return JSONObject(text)
    } finally {
      connection.disconnect()
    }
  }

  private fun foregroundInfo(text: String, progress: Int, taskId: String): ForegroundInfo {
    createChannels()
    val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Agnes AI Studio")
      .setContentText(text)
      .setProgress(100, progress.coerceIn(0, 100), false)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()
    return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else ForegroundInfo(NOTIFICATION_ID, notification)
  }

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Прогресс Agnes AI", NotificationManager.IMPORTANCE_LOW))
    manager.createNotificationChannel(NotificationChannel(COMPLETE_CHANNEL_ID, "Готовые результаты", NotificationManager.IMPORTANCE_HIGH))
    manager.createNotificationChannel(NotificationChannel(ERROR_CHANNEL_ID, "Ошибки Agnes AI", NotificationManager.IMPORTANCE_DEFAULT))
  }

  private fun notifyCompleted(uri: Uri, title: String, text: String) {
    createChannels()
    val openIntent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    val pending = android.app.PendingIntent.getActivity(applicationContext, uri.hashCode(), openIntent, android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE)
    (applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(uri.hashCode(), NotificationCompat.Builder(applicationContext, COMPLETE_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentTitle(title)
      .setContentText(text)
      .setAutoCancel(true)
      .setContentIntent(pending)
      .build())
  }

  private class RetryableHttpException(message: String) : IOException(message)
}
