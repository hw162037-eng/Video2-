package com.app.agnesaimobile

import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class AgnesWorkManagerPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext) = listOf(AgnesWorkManagerModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class AgnesWorkManagerModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  private val ioExecutor = Executors.newCachedThreadPool()
  override fun getName() = "AgnesWorkManager"

  @ReactMethod
  fun startGeneration(taskId: String, kind: String, apiKey: String, payloadPath: String, pollIntervalSec: Int, promise: Promise) {
    try {
      require(taskId.isNotBlank() && apiKey.isNotBlank() && payloadPath.isNotBlank()) { "Пустые параметры native генерации" }
      val intent = Intent(reactContext, GenerationForegroundService::class.java).apply {
        action = GenerationForegroundService.ACTION_START
        putExtra(GenerationForegroundService.EXTRA_TASK_ID, taskId)
        putExtra(GenerationForegroundService.EXTRA_KIND, kind)
        putExtra(GenerationForegroundService.EXTRA_API_KEY, apiKey)
        putExtra(GenerationForegroundService.EXTRA_PAYLOAD_PATH, payloadPath)
        putExtra(GenerationForegroundService.EXTRA_POLL_INTERVAL, pollIntervalSec.coerceIn(5, 120))
      }
      AgnesDiagnostics.log(reactContext, taskId, "start_requested", "foreground_service")
      ContextCompat.startForegroundService(reactContext, intent)
      promise.resolve(true)
    } catch (error: Exception) {
      AgnesDiagnostics.log(reactContext, taskId, "start_request_failed", error.message ?: error.javaClass.simpleName)
      promise.reject("FOREGROUND_START_FAILED", error)
    }
  }

  @ReactMethod
  fun cancelGeneration(taskId: String, promise: Promise) {
    try {
      val intent = Intent(reactContext, GenerationForegroundService::class.java).apply {
        action = GenerationForegroundService.ACTION_CANCEL
        putExtra(GenerationForegroundService.EXTRA_TASK_ID, taskId)
      }
      reactContext.startService(intent)
      WorkManager.getInstance(reactContext).cancelUniqueWork("agnes-task-$taskId")
      AgnesDiagnostics.log(reactContext, taskId, "cancel_sent")
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("CANCEL_FAILED", error)
    }
  }

  @ReactMethod
  fun getGenerationStatus(taskId: String, promise: Promise) {
    try {
      val raw = reactContext.getSharedPreferences(GenerationForegroundService.PREFS, 0).getString(taskId, null)
      val result: WritableMap = Arguments.createMap()
      if (raw == null) { result.putString("state", "NOT_FOUND"); result.putInt("runAttemptCount", 0); promise.resolve(result); return }
      val json = org.json.JSONObject(raw)
      result.putString("state", json.optString("state", "NOT_FOUND"))
      result.putInt("runAttemptCount", 0)
      if (json.has("startedAt")) result.putDouble("startedAt", json.optLong("startedAt").toDouble())
      result.putInt("progress", json.optInt("progress", 0))
      result.putString("serverId", json.optString("serverId").takeIf { it.isNotBlank() })
      result.putString("resultUrl", json.optString("resultUrl").takeIf { it.isNotBlank() })
      result.putString("errorMessage", json.optString("errorMessage").takeIf { it.isNotBlank() })
      if (json.has("errorCode")) result.putInt("errorCode", json.optInt("errorCode"))
      promise.resolve(result)
    } catch (error: Exception) { promise.reject("STATUS_FAILED", error) }
  }

  @ReactMethod
  fun getDiagnosticLog(promise: Promise) { promise.resolve(AgnesDiagnostics.read(reactContext)) }

  @ReactMethod
  fun clearDiagnosticLog(promise: Promise) { AgnesDiagnostics.clear(reactContext); promise.resolve(true) }

  @ReactMethod
  fun saveResultToMediaStore(resultUrl: String, taskId: String, kind: String, promise: Promise) {
    ioExecutor.execute {
      try { promise.resolve(MediaStoreSaver.saveFromUrl(reactContext, resultUrl, taskId, kind == "video").toString()) }
      catch (error: Exception) { promise.reject("MEDIASTORE_SAVE_FAILED", error) }
    }
  }

  @ReactMethod
  fun extractFrameAtTime(videoUri: String, taskId: String, seconds: Double, promise: Promise) {
    ioExecutor.execute {
      val retriever = MediaMetadataRetriever(); var downloadedVideo: File? = null
      try {
        val parsed = Uri.parse(videoUri)
        if (parsed.scheme == "http" || parsed.scheme == "https") {
          downloadedVideo = File(reactContext.cacheDir, "agnes-source-$taskId.mp4")
          val connection = URL(videoUri).openConnection() as HttpURLConnection
          connection.connectTimeout = 30_000; connection.readTimeout = 120_000
          connection.inputStream.use { input -> FileOutputStream(downloadedVideo).use { output -> input.copyTo(output) } }
          connection.disconnect(); retriever.setDataSource(downloadedVideo.absolutePath)
        } else retriever.setDataSource(reactContext, parsed)
        val frame = retriever.getFrameAtTime((seconds.coerceAtLeast(0.0) * 1_000_000L).toLong(), MediaMetadataRetriever.OPTION_CLOSEST)
          ?: throw IllegalStateException("Не удалось извлечь кадр")
        val output = File(reactContext.cacheDir, "agnes-frame-$taskId-${System.currentTimeMillis()}.png")
        FileOutputStream(output).use { if (!frame.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)) throw IllegalStateException("Не удалось сохранить кадр") }
        frame.recycle(); promise.resolve(Uri.fromFile(output).toString())
      } catch (error: Exception) { promise.reject("FRAME_FAILED", error) }
      finally { retriever.release(); downloadedVideo?.delete() }
    }
  }

  @ReactMethod
  fun extractLastFrame(videoUri: String, taskId: String, promise: Promise) = extractFrameAtTime(videoUri, taskId, 3600.0, promise)

  @ReactMethod
  fun enqueueGeneration(taskId: String, kind: String, apiKey: String, payloadJson: String, pollIntervalSec: Int, promise: Promise) {
    try {
      val input = Data.Builder().putString(GenerationWorker.KEY_TASK_ID, taskId).putString(GenerationWorker.KEY_KIND, kind).putString(GenerationWorker.KEY_API_KEY, apiKey).putString(GenerationWorker.KEY_PAYLOAD, payloadJson).putInt(GenerationWorker.KEY_POLL_INTERVAL_SEC, pollIntervalSec.coerceIn(5, 120)).build()
      val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
      val request = OneTimeWorkRequestBuilder<GenerationWorker>().setInputData(input).setConstraints(constraints).setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag("agnes-generation").addTag("agnes-task-$taskId").build()
      WorkManager.getInstance(reactContext).enqueueUniqueWork("agnes-task-$taskId", ExistingWorkPolicy.KEEP, request); promise.resolve(request.id.toString())
    } catch (error: Exception) { promise.reject("WORK_ENQUEUE_FAILED", error) }
  }

  @ReactMethod
  fun saveLegacyResultToMediaStore(resultUrl: String, taskId: String, kind: String, promise: Promise) = saveResultToMediaStore(resultUrl, taskId, kind, promise)
}
