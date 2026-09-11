package com.app.agnesaimobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class GenerationForegroundService : Service() {
  companion object {
    const val ACTION_START = "com.app.agnesaimobile.action.START"
    const val ACTION_CANCEL = "com.app.agnesaimobile.action.CANCEL"
    const val EXTRA_TASK_ID = "taskId"
    const val EXTRA_KIND = "kind"
    const val EXTRA_API_KEY = "apiKey"
    const val EXTRA_PROFILE_ID = "profileId"
    const val EXTRA_PAYLOAD_PATH = "payloadPath"
    const val EXTRA_POLL_INTERVAL = "pollIntervalSec"
    private const val CHANNEL_ID = "agnes_generation_service"
    private const val NOTIFICATION_ID = 4760
    const val PREFS = "agnes_service_tasks"
    private const val MAX_RUNTIME_MS = 2 * 60 * 60 * 1000L
    private const val MAX_POLL_BACKOFF_MS = 5 * 60 * 1000L
    private const val MAX_SUBMIT_NETWORK_RETRIES = 5
    private const val MAX_SUBMIT_BACKOFF_MS = 60_000L
    private const val PROFILE_REQUEST_SPACING_MS = 4_000L
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val jobs = mutableMapOf<String, Job>()
  private val profileNextRequestAt = mutableMapOf<String, Long>()

  override fun onCreate() {
    super.onCreate()
    createChannel()
    AgnesDiagnostics.log(this, null, "service_create")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    if (action == ACTION_CANCEL) {
      val taskId = intent.getStringExtra(EXTRA_TASK_ID).orEmpty()
      AgnesDiagnostics.log(this, taskId, "cancel_requested")
      jobs.remove(taskId)?.cancel()
      save(taskId, JSONObject().put("taskId", taskId).put("state", "CANCELLED").put("errorMessage", "Отменено пользователем"))
      stopIfIdle()
      return START_NOT_STICKY
    }
    if (action != ACTION_START) return START_NOT_STICKY

    val taskId = intent.getStringExtra(EXTRA_TASK_ID).orEmpty()
    val kind = intent.getStringExtra(EXTRA_KIND).orEmpty()
    val apiKey = intent.getStringExtra(EXTRA_API_KEY).orEmpty()
    val profileId = intent.getStringExtra(EXTRA_PROFILE_ID).orEmpty().ifBlank { "default" }
    val payloadPath = intent.getStringExtra(EXTRA_PAYLOAD_PATH).orEmpty()
    val pollInterval = intent.getIntExtra(EXTRA_POLL_INTERVAL, 15).coerceIn(5, 120)
    if (taskId.isBlank() || apiKey.isBlank() || payloadPath.isBlank()) {
      AgnesDiagnostics.log(this, taskId, "start_rejected", "missing task/api/payload_path")
      return START_NOT_STICKY
    }

    try {
      startForeground(NOTIFICATION_ID, notification("Подготовка задачи", 5))
      AgnesDiagnostics.log(this, taskId, "foreground_started")
    } catch (error: Exception) {
      AgnesDiagnostics.log(this, taskId, "foreground_failed", error.message ?: error.javaClass.simpleName)
      save(taskId, JSONObject().put("taskId", taskId).put("state", "FAILED").put("errorMessage", error.message ?: "Не удалось запустить foreground service"))
      return START_NOT_STICKY
    }

    jobs[taskId]?.cancel()
    jobs[taskId] = scope.launch {
      runTask(taskId, kind, apiKey, profileId, payloadPath, pollInterval)
    }
    return START_NOT_STICKY
  }

  private suspend fun runTask(taskId: String, kind: String, apiKey: String, profileId: String, payloadPath: String, pollInterval: Int) {
    val startedAt = System.currentTimeMillis()
    try {
      val payloadFile = File(Uri.parse(payloadPath).path ?: payloadPath)
      if (!payloadFile.exists()) throw IllegalStateException("Файл параметров задачи не найден")
      val payload = payloadFile.readText(Charsets.UTF_8)
      val payloadJson = JSONObject(payload)
      AgnesDiagnostics.log(this, taskId, "payload_prepared", "profile_id=$profileId kind=$kind model=${payloadJson.optString("model")} mode=${payloadJson.optString("mode")} seconds=${payloadJson.optString("seconds", payloadJson.optString("num_frames"))} size=${payloadJson.optString("size")} payload_bytes=${payload.toByteArray(Charsets.UTF_8).size} poll_interval=$pollInterval")
      save(taskId, JSONObject().put("taskId", taskId).put("state", "SUBMITTING").put("progress", 5).put("startedAt", startedAt))
      updateNotification("Отправка запроса", 10)
      val submitPath = if (kind == "image") "/v1/images/generations" else "/v1/videos"
      val submitUrl = "https://apihub.agnes-ai.com$submitPath"
      var submitAttempt = 0
      var submitted: JSONObject
      AgnesDiagnostics.log(this, taskId, "api_submit_started", "profile_id=$profileId kind=$kind")
      while (true) {
        try {
          awaitProfileSlot(profileId)
          submitted = requestJson(submitUrl, apiKey, payload)
          break
        } catch (error: IOException) {
          val retryable = error !is ApiHttpException || error.status == 429 || error.status in 500..599
          if (!retryable || submitAttempt >= MAX_SUBMIT_NETWORK_RETRIES) throw error
          submitAttempt += 1
          val retryIn = minOf(MAX_SUBMIT_BACKOFF_MS, 5000L * (1L shl minOf(submitAttempt - 1, 4)))
          val state = if (error is ApiHttpException && error.status == 429) "RATE_LIMITED" else "RETRY_WAIT"
          save(taskId, JSONObject().put("taskId", taskId).put("state", state).put("progress", 10).put("startedAt", startedAt).put("submitRetryInMs", retryIn).put("submitAttempt", submitAttempt).put("errorCode", (error as? ApiHttpException)?.status ?: 0).put("errorMessage", error.message ?: "Сетевая ошибка"))
          AgnesDiagnostics.log(this, taskId, "submit_retry", "status=${(error as? ApiHttpException)?.status ?: "network"} retry_in_ms=$retryIn attempt=$submitAttempt detail=${error.message?.take(160)}")
          updateNotification(if (state == "RATE_LIMITED") "Лимит API, повтор через ${retryIn / 1000} сек" else "Нет сети, повтор через ${retryIn / 1000} сек", 10)
          delay(retryIn)
          continue
        }
      }
      payloadFile.delete()
      AgnesDiagnostics.log(this, taskId, "api_submit_success", "kind=$kind")
      val submittedAt = System.currentTimeMillis()
      if (kind == "image") {
        val first = submitted.optJSONArray("data")?.optJSONObject(0)
        val resultUrl = first?.optString("url").orEmpty().ifBlank { first?.optString("image_url").orEmpty() }.ifBlank { submitted.optString("url") }
        if (resultUrl.isBlank()) throw IllegalStateException("API не вернул ссылку на изображение")
        complete(taskId, resultUrl, kind, startedAt)
        return
      }

      val videoId = submitted.optString("video_id").ifBlank { submitted.optString("id") }
      val model = JSONObject(payload).optString("model")
      if (videoId.isBlank()) throw IllegalStateException("API не вернул video_id")
      save(taskId, JSONObject().put("taskId", taskId).put("state", "PROCESSING").put("serverId", videoId).put("progress", 20).put("startedAt", startedAt).put("submittedAt", submittedAt))
      var resultUrl = ""
      var attempt = 0
      var pollRateLimits = 0
      var pollRequestDurationMs = 0L
      while (resultUrl.isBlank() && attempt < 240) {
        if (System.currentTimeMillis() - startedAt > MAX_RUNTIME_MS) throw IllegalStateException("Превышено максимальное время выполнения задачи")
        val waitMs = if (pollRateLimits == 0) pollInterval * 1000L else minOf(MAX_POLL_BACKOFF_MS, pollInterval * 1000L * (1L shl minOf(pollRateLimits, 5)))
        delay(waitMs)
        attempt += 1
        val pollUrl = "https://apihub.agnes-ai.com/agnesapi?video_id=${Uri.encode(videoId)}" + if (model.isNotBlank()) "&model_name=${Uri.encode(model)}" else ""
        val poll = try {
          awaitProfileSlot(profileId)
          val pollStartedAt = System.currentTimeMillis()
          AgnesDiagnostics.log(this, taskId, "poll_started", "attempt=$attempt")
          requestJson(pollUrl, apiKey, null, connectTimeoutMs = 15_000, readTimeoutMs = 30_000).also {
            val requestDuration = System.currentTimeMillis() - pollStartedAt
            pollRequestDurationMs += requestDuration
            AgnesDiagnostics.log(this, taskId, "poll_response", "attempt=$attempt duration_ms=$requestDuration total_poll_request_ms=$pollRequestDurationMs")
          }
        } catch (error: ApiHttpException) {
          if (error.status == 429 || error.status in 500..599) {
            pollRateLimits = minOf(5, pollRateLimits + 1)
            val retryIn = minOf(MAX_POLL_BACKOFF_MS, pollInterval * 1000L * (1L shl pollRateLimits))
            save(taskId, JSONObject().put("taskId", taskId).put("state", "PROCESSING").put("serverId", videoId).put("progress", minOf(95, 20 + attempt * 75 / 240)).put("startedAt", startedAt).put("pollRetryInMs", retryIn).put("pollErrorCode", error.status))
            AgnesDiagnostics.log(this, taskId, "poll_rate_limited", "status=${error.status} retry_in_ms=$retryIn attempt=$attempt")
            continue
          }
          throw error
        } catch (error: IOException) {
          pollRateLimits = minOf(5, pollRateLimits + 1)
          val retryIn = minOf(MAX_POLL_BACKOFF_MS, pollInterval * 1000L * (1L shl pollRateLimits))
          save(taskId, JSONObject().put("taskId", taskId).put("state", "PROCESSING").put("serverId", videoId).put("progress", minOf(95, 20 + attempt * 75 / 240)).put("startedAt", startedAt).put("pollRetryInMs", retryIn))
          AgnesDiagnostics.log(this, taskId, "poll_network_retry", "retry_in_ms=$retryIn attempt=$attempt")
          continue
        }
        pollRateLimits = 0
        val status = poll.optString("status", "processing").lowercase()
        val candidateUrl = poll.optJSONObject("metadata")?.optString("url").orEmpty().ifBlank { poll.optString("url") }.ifBlank { poll.optString("video_url") }
        if (status == "failed" || status == "error") throw IllegalStateException(poll.optString("error", "Сервер сообщил об ошибке видео"))
        val isCompleted = status == "completed" || status == "succeeded" || status == "success" || status == "done"
        resultUrl = if (isCompleted) candidateUrl else ""
        val progress = minOf(95, 20 + attempt * 75 / 240)
        save(taskId, JSONObject().put("taskId", taskId).put("state", if (resultUrl.isBlank()) "PROCESSING" else "SERVER_READY").put("serverId", videoId).put("resultUrl", resultUrl).put("progress", if (isCompleted) 100 else progress).put("startedAt", startedAt).put("submittedAt", submittedAt).put("pollingDurationMs", pollRequestDurationMs))
        updateNotification("Рендеринг видео · опрос $attempt", progress)
        AgnesDiagnostics.log(this, taskId, "poll", "attempt=$attempt status=$status candidate_url=${candidateUrl.isNotBlank()} completed=$isCompleted")
      }
      if (resultUrl.isBlank()) throw IllegalStateException("Истекло время ожидания готового видео")
      complete(taskId, resultUrl, kind, startedAt, submittedAt, pollRequestDurationMs)
    } catch (_: CancellationException) {
      AgnesDiagnostics.log(this, taskId, "cancelled")
    } catch (error: Exception) {
      File(Uri.parse(payloadPath).path ?: payloadPath).delete()
      AgnesDiagnostics.log(this, taskId, "task_failed", error.message ?: error.javaClass.simpleName)
      save(taskId, JSONObject().put("taskId", taskId).put("state", "FAILED").put("errorCode", (error as? ApiHttpException)?.status ?: 0).put("errorMessage", error.message ?: "Ошибка foreground service").put("startedAt", startedAt))
      updateNotification("Ошибка генерации", 0)
    } finally {
      jobs.remove(taskId)
      stopIfIdle()
    }
  }

  private suspend fun awaitProfileSlot(profileId: String) {
    val waitMs = synchronized(profileNextRequestAt) {
      val now = System.currentTimeMillis()
      val wait = (profileNextRequestAt[profileId] ?: now) - now
      profileNextRequestAt[profileId] = now + wait.coerceAtLeast(0L) + PROFILE_REQUEST_SPACING_MS
      wait.coerceAtLeast(0L)
    }
    if (waitMs > 0) delay(waitMs)
  }

  private fun complete(taskId: String, resultUrl: String, kind: String, startedAt: Long, submittedAt: Long? = null, pollingDurationMs: Long = 0L) {
    val value = JSONObject().put("taskId", taskId).put("state", "SERVER_READY").put("progress", 100).put("resultUrl", resultUrl).put("startedAt", startedAt)
    if (submittedAt != null) value.put("submittedAt", submittedAt)
    if (pollingDurationMs > 0) value.put("pollingDurationMs", pollingDurationMs)
    save(taskId, value)
    AgnesDiagnostics.log(this, taskId, "server_ready", "url_received=true")
    updateNotification("Результат готов · откройте приложение", 100)
  }

  private fun requestJson(url: String, apiKey: String, body: String?, connectTimeoutMs: Int = 30_000, readTimeoutMs: Int = 120_000): JSONObject {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = if (body == null) "GET" else "POST"
      connection.connectTimeout = connectTimeoutMs
      connection.readTimeout = readTimeoutMs
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
      if (status !in 200..299) throw ApiHttpException(status, "Agnes API HTTP $status: ${text.take(500)}")
      return JSONObject(text)
    } finally { connection.disconnect() }
  }

  class ApiHttpException(val status: Int, message: String) : IOException(message)

  private fun save(taskId: String, value: JSONObject) {
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(taskId, value.toString()).apply()
  }

  private fun stopIfIdle() {
    if (jobs.isEmpty()) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= 26) {
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Генерации Agnes AI", NotificationManager.IMPORTANCE_LOW))
    }
  }

  private fun notification(text: String, progress: Int): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val pending = launch?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Agnes AI Studio")
      .setContentText(text)
      .setProgress(100, progress.coerceIn(0, 100), progress <= 0)
      .setOngoing(true)
      .setContentIntent(pending)
      .build()
  }

  private fun updateNotification(text: String, progress: Int) {
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification(text, progress))
  }

  override fun onDestroy() { scope.cancel(); AgnesDiagnostics.log(this, null, "service_destroy"); super.onDestroy() }
  override fun onBind(intent: Intent?): IBinder? = null
}
