package com.app.agnesaimobile

import android.media.MediaMetadataRetriever
import android.net.Uri
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
  fun enqueueGeneration(taskId: String, kind: String, apiKey: String, payloadJson: String, pollIntervalSec: Int, promise: Promise) {
    try {
      require(taskId.isNotBlank()) { "Пустой идентификатор задачи" }
      require(apiKey.isNotBlank()) { "Пустой Agnes AI API key" }
      val input = Data.Builder()
        .putString(GenerationWorker.KEY_TASK_ID, taskId)
        .putString(GenerationWorker.KEY_KIND, kind)
        .putString(GenerationWorker.KEY_API_KEY, apiKey)
        .putString(GenerationWorker.KEY_PAYLOAD, payloadJson)
        .putInt(GenerationWorker.KEY_POLL_INTERVAL_SEC, pollIntervalSec.coerceIn(5, 120))
        .build()
      val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()
      val request = OneTimeWorkRequestBuilder<GenerationWorker>()
        .setInputData(input)
        .setConstraints(constraints)
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .addTag("agnes-generation")
        .addTag("agnes-task-$taskId")
        .build()
      WorkManager.getInstance(reactContext).enqueueUniqueWork("agnes-task-$taskId", ExistingWorkPolicy.KEEP, request)
      promise.resolve(request.id.toString())
    } catch (error: Exception) {
      promise.reject("WORK_ENQUEUE_FAILED", error)
    }
  }

  @ReactMethod
  fun cancelGeneration(taskId: String, promise: Promise) {
    try {
      WorkManager.getInstance(reactContext).cancelUniqueWork("agnes-task-$taskId")
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("WORK_CANCEL_FAILED", error)
    }
  }

  @ReactMethod
  fun saveResultToMediaStore(resultUrl: String, taskId: String, kind: String, promise: Promise) {
    ioExecutor.execute {
      try {
        val uri = MediaStoreSaver.saveFromUrl(reactContext, resultUrl, taskId, kind == "video")
        promise.resolve(uri.toString())
      } catch (error: Exception) {
        promise.reject("MEDIASTORE_SAVE_FAILED", error)
      }
    }
  }

  @ReactMethod
  fun extractLastFrame(videoUri: String, taskId: String, promise: Promise) {
    ioExecutor.execute {
      val retriever = MediaMetadataRetriever()
      var downloadedVideo: File? = null
      try {
        val parsedUri = Uri.parse(videoUri)
        if (parsedUri.scheme == "http" || parsedUri.scheme == "https") {
          downloadedVideo = File(reactContext.cacheDir, "agnes-source-$taskId.mp4")
          val connection = URL(videoUri).openConnection() as HttpURLConnection
          connection.connectTimeout = 30_000
          connection.readTimeout = 120_000
          connection.instanceFollowRedirects = true
          if (connection.responseCode !in 200..299) error("Не удалось скачать видео: HTTP ${connection.responseCode}")
          connection.inputStream.use { input -> FileOutputStream(downloadedVideo).use { output -> input.copyTo(output) } }
          connection.disconnect()
          retriever.setDataSource(downloadedVideo.absolutePath)
        } else {
          retriever.setDataSource(reactContext, parsedUri)
        }
        val frame = retriever.getFrameAtTime(-1, MediaMetadataRetriever.OPTION_CLOSEST)
          ?: throw IllegalStateException("Не удалось извлечь последний кадр видео")
        val output = File(reactContext.cacheDir, "agnes-last-frame-$taskId.png")
        FileOutputStream(output).use { stream ->
          if (!frame.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream)) {
            throw IllegalStateException("Не удалось сохранить последний кадр")
          }
        }
        frame.recycle()
        promise.resolve(Uri.fromFile(output).toString())
      } catch (error: Exception) {
        promise.reject("LAST_FRAME_FAILED", error)
      } finally {
        retriever.release()
        downloadedVideo?.delete()
      }
    }
  }

  @ReactMethod
  fun getGenerationStatus(taskId: String, promise: Promise) {
    ioExecutor.execute {
      try {
        val info = WorkManager.getInstance(reactContext).getWorkInfosForUniqueWork("agnes-task-$taskId").get().firstOrNull()
        val result: WritableMap = Arguments.createMap()
        result.putString("state", info?.state?.name ?: "NOT_FOUND")
        result.putInt("runAttemptCount", info?.runAttemptCount ?: 0)
        result.putInt("progress", info?.progress?.getInt("progress", 0) ?: 0)
        info?.outputData?.getString("localUri")?.let { result.putString("localUri", it) }
        info?.outputData?.getString("resultUrl")?.let { result.putString("resultUrl", it) }
        info?.outputData?.getString("errorMessage")?.let { result.putString("errorMessage", it) }
        promise.resolve(result)
      } catch (error: Exception) {
        promise.reject("WORK_STATUS_FAILED", error)
      }
    }
  }
}
