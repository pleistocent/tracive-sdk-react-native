package id.tracive.sdk.extended.reactnative

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.common.LifecycleState
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import id.tracive.sdk.extended.AccessTokenProvider
import id.tracive.sdk.extended.PreparedEvidence
import id.tracive.sdk.extended.ReportDraft
import id.tracive.sdk.extended.ReportErrorCode
import id.tracive.sdk.extended.ReportLimits
import id.tracive.sdk.extended.ReportRequirements
import id.tracive.sdk.extended.RequiredTerm
import id.tracive.sdk.extended.SubmitResult
import id.tracive.sdk.extended.TraciveReportException
import id.tracive.sdk.extended.TraciveReports
import id.tracive.sdk.extended.ui.ReportFormOutcome
import id.tracive.sdk.extended.ui.ReportFormRequest
import id.tracive.sdk.extended.ui.ReportPrefill
import id.tracive.sdk.extended.ui.ReportPrefillAttachment
import id.tracive.sdk.extended.ui.ReportStatusOutcome
import id.tracive.sdk.extended.ui.ReportStatusRequest
import id.tracive.sdk.extended.ui.TraciveReportForm
import id.tracive.sdk.extended.ui.TraciveReportScreens
import id.tracive.sdk.extended.ui.TraciveReportStatus
import id.tracive.sdk.extended.ui.TraciveReportTheme
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.datetime.LocalDate

private const val REQUEST_FORM = 0x7452
private const val REQUEST_STATUS = 0x7453
private const val CANCELLED = "CANCELLED"
private const val TOKEN_EVENT = "TraciveReports.accessToken"
private const val PROGRESS_EVENT = "TraciveReports.progress"

// Past JavaScript's own limit, so this only ends a request JavaScript cannot answer, such as during
// a reload.
private const val TOKEN_ANSWER_MILLIS = 35_000L

private const val KEEP_TIMERS_TASK = "TraciveReports.keepTimers"

// Not a product limit, the core has those. It only stops a huge file from running the heap out
// before the core sees it.
private const val MAX_SOURCE_BYTES = 64 * 1024 * 1024

private class Instance(val reports: TraciveReports) {
  val evidence = ConcurrentHashMap<Int, PreparedEvidence>()
  val calls = ConcurrentHashMap<Int, Job>()
}

private class OpenScreen(val requestCode: Int, val promise: Promise)

/**
 * Holds the native core for JavaScript. React Native calls this on its native-modules thread and
 * the coroutines run elsewhere, so everything shared is concurrent.
 */
class TraciveExtendedReportsModule(reactContext: ReactApplicationContext) :
  NativeTraciveReportsSpec(reactContext), ActivityEventListener {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val instances = ConcurrentHashMap<Int, Instance>()
  private val tokenWaiters = ConcurrentHashMap<Int, CompletableDeferred<String>>()
  private val nextId = AtomicInteger(1)
  private val openScreen = AtomicReference<OpenScreen?>(null)

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = NAME

  override fun invalidate() {
    reactApplicationContext.removeActivityEventListener(this)
    scope.cancel()
    tokenWaiters.values.forEach { it.cancel() }
    tokenWaiters.clear()
    instances.values.forEach { it.reports.close() }
    instances.clear()
    openScreen.getAndSet(null)?.promise?.reject(CANCELLED, "The call was cancelled.")
    super.invalidate()
  }

  override fun create(baseUrl: String, appUrlScheme: String, promise: Promise) {
    try {
      val handle = nextId.getAndIncrement()
      val reports =
        TraciveReports(
          baseUrl = baseUrl,
          appUrlScheme = appUrlScheme,
          accessToken = JavaScriptTokens(handle),
        )
      instances[handle] = Instance(reports)
      promise.resolve(handle)
    } catch (failure: Exception) {
      promise.fail(failure)
    }
  }

  override fun dispose(reports: Double, promise: Promise) {
    instances.remove(reports.toInt())?.let { instance ->
      instance.calls.values.forEach { it.cancel() }
      instance.reports.close()
    }
    promise.resolve(null)
  }

  override fun idempotencyKey(): String =
    ByteArray(16).also(SecureRandom()::nextBytes).joinToString("") {
      it.toUByte().toString(16).padStart(2, '0')
    }

  override fun requirements(reports: Double, call: Double, promise: Promise) {
    val instance = instance(reports, promise) ?: return
    instance.launchCall(call, promise) { promise.resolve(instance.reports.requirements().toWire()) }
  }

  override fun prepare(reports: Double, call: Double, source: ReadableMap, promise: Promise) {
    val instance = instance(reports, promise) ?: return
    instance.launchCall(call, promise) {
      val prepared = instance.reports.prepare(readFile(source), source.requireString("mimeType"))
      val handle = nextId.getAndIncrement()
      instance.evidence[handle] = prepared
      promise.resolve(
        Arguments.createMap().apply {
          putInt("evidence", handle)
          putString("mimeType", prepared.mimeType)
          putInt("byteCount", prepared.bytes.size)
        }
      )
    }
  }

  override fun releaseEvidence(reports: Double, evidence: Double) {
    instances[reports.toInt()]?.evidence?.remove(evidence.toInt())
  }

  override fun submit(reports: Double, call: Double, draft: ReadableMap, promise: Promise) {
    val instance = instance(reports, promise) ?: return
    val report =
      try {
        instance.draft(draft)
      } catch (failure: Exception) {
        return promise.fail(failure)
      }
    val id = call.toInt()
    instance.launchCall(call, promise) {
      val outcome =
        instance.reports.submit(report) { fraction ->
          emit(
            PROGRESS_EVENT,
            Arguments.createMap().apply {
              putInt("call", id)
              putDouble("fraction", fraction.toDouble())
            },
          )
        }
      when (outcome) {
        is SubmitResult.Submitted ->
          promise.resolve(
            Arguments.createMap().apply {
              putString("outcome", "submitted")
              putString("reportId", outcome.reportId)
              putString("status", outcome.status.name)
            }
          )
        SubmitResult.NeedsConsent ->
          promise.resolve(Arguments.createMap().apply { putString("outcome", "needsConsent") })
        is SubmitResult.Failed -> promise.fail(outcome.error)
      }
    }
  }

  override fun status(reports: Double, call: Double, reportId: String, promise: Promise) {
    val instance = instance(reports, promise) ?: return
    instance.launchCall(call, promise) { promise.resolve(instance.reports.status(reportId).name) }
  }

  override fun cancel(reports: Double, call: Double) {
    instances[reports.toInt()]?.calls?.get(call.toInt())?.cancel()
  }

  override fun openInTracive(reports: Double, reportId: String, promise: Promise) {
    val instance = instance(reports, promise) ?: return
    try {
      promise.resolve(instance.reports.openInTracive(reportId))
    } catch (failure: Exception) {
      promise.fail(failure)
    }
  }

  override fun presentForm(reports: Double, request: ReadableMap, promise: Promise) {
    val instance = instance(reports, promise) ?: return
    if (!claimScreen(REQUEST_FORM, promise)) return
    scope.launch {
      try {
        val form =
          ReportFormRequest(
            ReportPrefill(
              identifiers = request.requireStrings("identifiers"),
              incidentDate = request.stringOrNull("incidentDate")?.let(LocalDate::parse),
              title = request.stringOrNull("title"),
              attachments =
                request.requireMaps("attachments").map { file ->
                  ReportPrefillAttachment(readFile(file), file.requireString("mimeType"))
                },
            ),
            request.theme(),
          )
        withContext(Dispatchers.Main) {
          TraciveReportScreens.configure(instance.reports)
          val activity = requireActivity()
          activity.startActivityForResult(
            TraciveReportForm.Contract().createIntent(activity, form),
            REQUEST_FORM,
          )
        }
      } catch (failure: Exception) {
        openScreen.set(null)
        promise.fail(failure)
      }
    }
  }

  override fun presentStatus(reports: Double, request: ReadableMap, promise: Promise) {
    val instance = instance(reports, promise) ?: return
    if (!claimScreen(REQUEST_STATUS, promise)) return
    scope.launch(Dispatchers.Main) {
      try {
        TraciveReportScreens.configure(instance.reports)
        val activity = requireActivity()
        val status = ReportStatusRequest(request.requireString("reportId"), request.theme())
        activity.startActivityForResult(
          TraciveReportStatus.Contract().createIntent(activity, status),
          REQUEST_STATUS,
        )
      } catch (failure: Exception) {
        openScreen.set(null)
        promise.fail(failure)
      }
    }
  }

  override fun onActivityResult(
    activity: Activity,
    requestCode: Int,
    resultCode: Int,
    data: Intent?,
  ) {
    if (openScreen.get()?.requestCode != requestCode) return
    val screen = openScreen.getAndSet(null) ?: return
    when (requestCode) {
      REQUEST_FORM ->
        screen.promise.resolve(TraciveReportForm.Contract().parseResult(resultCode, data).toWire())
      REQUEST_STATUS ->
        screen.promise.resolve(
          TraciveReportStatus.Contract().parseResult(resultCode, data).toWire()
        )
    }
  }

  override fun onNewIntent(intent: Intent) = Unit

  override fun answerToken(request: Double, token: String) {
    tokenWaiters.remove(request.toInt())?.complete(token)
  }

  override fun failToken(request: Double, failure: ReadableMap) {
    tokenWaiters.remove(request.toInt())?.completeExceptionally(failure.toReportException())
  }

  override fun addListener(eventName: String) = Unit

  override fun removeListeners(count: Double) = Unit

  private fun instance(reports: Double, promise: Promise): Instance? {
    val instance = instances[reports.toInt()]
    if (instance == null) promise.reject(CANCELLED, "This TraciveReports was disposed.")
    return instance
  }

  private fun Instance.launchCall(
    call: Double,
    promise: Promise,
    block: suspend CoroutineScope.() -> Unit,
  ) {
    val id = call.toInt()
    // UNDISPATCHED so the body always starts: a job cancelled before it began would never settle.
    val job =
      scope.launch(start = CoroutineStart.UNDISPATCHED) {
        try {
          block()
        } catch (failure: Exception) {
          promise.fail(failure)
          if (failure is CancellationException) throw failure
        }
      }
    calls[id] = job
    job.invokeOnCompletion { calls.remove(id) }
  }

  private fun Instance.draft(wire: ReadableMap) =
    ReportDraft(
      identifiers = wire.requireStrings("identifiers"),
      title = wire.requireString("title"),
      chronology = wire.requireString("chronology"),
      comment = wire.stringOrNull("comment"),
      incidentDate = wire.requireString("incidentDate"),
      evidence =
        requireNotNull(wire.getArray("evidence")).toArrayList().map {
          evidence[(it as Number).toInt()]
            ?: throw TraciveReportException(
              ReportErrorCode.ATTACHMENT_INVALID,
              "The evidence was released.",
            )
        },
      acceptedTerms =
        wire.requireMaps("terms").map {
          RequiredTerm(
            id = it.requireString("id"),
            version = it.requireString("version"),
            url = it.requireString("url"),
          )
        },
      language = wire.stringOrNull("language"),
      idempotencyKey = wire.requireString("key"),
    )

  private fun claimScreen(requestCode: Int, promise: Promise): Boolean {
    val claimed = openScreen.compareAndSet(null, OpenScreen(requestCode, promise))
    if (!claimed) promise.reject("SERVER", "A Tracive screen is already open.")
    return claimed
  }

  private fun requireActivity(): Activity =
    reactApplicationContext.currentActivity
      ?: throw TraciveReportException(
        ReportErrorCode.SERVER,
        "There is no Activity to open it from.",
      )

  private suspend fun readFile(source: ReadableMap): ByteArray {
    source.stringOrNull("base64")?.let { base64 ->
      return try {
        Base64.decode(base64, Base64.DEFAULT)
      } catch (_: IllegalArgumentException) {
        throw unreadable("The file is not valid base64.")
      }
    }
    val uri = source.requireString("uri")
    return runInterruptible(Dispatchers.IO) { readBounded(uri) }
  }

  private fun readBounded(uri: String): ByteArray =
    try {
      val parsed = Uri.parse(uri)
      val opened =
        if (parsed.scheme == null) File(uri).inputStream()
        else reactApplicationContext.contentResolver.openInputStream(parsed)
      checkNotNull(opened).use { stream ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var read = stream.read(buffer)
        while (read >= 0) {
          output.write(buffer, 0, read)
          if (output.size() > MAX_SOURCE_BYTES) throw unreadable("The file is too large to read.")
          read = stream.read(buffer)
        }
        output.toByteArray()
      }
    } catch (_: IOException) {
      throw unreadable("The file could not be read.")
    } catch (_: SecurityException) {
      throw unreadable("The file could not be read.")
    } catch (_: IllegalStateException) {
      throw unreadable("The file could not be read.")
    } catch (_: OutOfMemoryError) {
      throw unreadable("The file is too large to read.")
    }

  private fun emit(event: String, body: WritableMap) {
    reactApplicationContext.emitDeviceEvent(event, body)
  }

  /** Native never refreshes: a rotating refresh token has one owner, the base SDK in JavaScript. */
  private inner class JavaScriptTokens(private val handle: Int) : AccessTokenProvider {
    override suspend fun accessToken(stale: String?): String {
      val request = nextId.getAndIncrement()
      val answer = CompletableDeferred<String>()
      tokenWaiters[request] = answer
      val keepAlive = keepTimersRunning()
      try {
        emit(
          TOKEN_EVENT,
          Arguments.createMap().apply {
            putInt("request", request)
            putInt("reports", handle)
            if (stale == null) putNull("stale") else putString("stale", stale)
          },
        )
        return withTimeoutOrNull(TOKEN_ANSWER_MILLIS) { answer.await() }
          ?: throw TraciveReportException(ReportErrorCode.NETWORK, "The token call did not answer.")
      } finally {
        tokenWaiters.remove(request)
        keepAlive?.let(::stopKeepingTimers)
      }
    }
  }

  /**
   * React Native stops JavaScript timers while the host Activity is paused, and `fetch` resolves on
   * a timer, so a refresh under one of our screens would never finish. A headless task is what
   * keeps them running.
   */
  private suspend fun keepTimersRunning(): Int? =
    withContext(Dispatchers.Main.immediate) {
      if (reactApplicationContext.lifecycleState == LifecycleState.RESUMED) return@withContext null
      HeadlessJsTaskContext.getInstance(reactApplicationContext)
        .startTask(
          HeadlessJsTaskConfig(KEEP_TIMERS_TASK, Arguments.createMap(), TOKEN_ANSWER_MILLIS, true)
        )
    }

  private fun stopKeepingTimers(task: Int) {
    UiThreadUtil.runOnUiThread {
      val tasks = HeadlessJsTaskContext.getInstance(reactApplicationContext)
      if (tasks.isTaskRunning(task)) tasks.finishTask(task)
    }
  }

  companion object {
    const val NAME = "TraciveExtendedReports"
  }
}

private fun unreadable(message: String) =
  TraciveReportException(ReportErrorCode.IMAGE_UNREADABLE, message)

private fun Promise.fail(failure: Throwable) {
  when (failure) {
    is CancellationException -> reject(CANCELLED, "The call was cancelled.")
    is TraciveReportException ->
      reject(
        failure.code.name,
        failure.message,
        Arguments.createMap().apply {
          failure.httpStatus?.let { putInt("httpStatus", it) }
          failure.retryAfterSeconds?.let { putDouble("retryAfterSeconds", it.toDouble()) }
        },
      )
    else -> reject(ReportErrorCode.SERVER.name, "The call failed.")
  }
}

private fun ReadableMap.toReportException() =
  TraciveReportException(
    ReportErrorCode.entries.firstOrNull { it.name == getString("code") } ?: ReportErrorCode.SERVER,
    stringOrNull("message") ?: "The token call failed.",
    httpStatus = if (hasNumber("httpStatus")) getDouble("httpStatus").toInt() else null,
    retryAfterSeconds =
      if (hasNumber("retryAfterSeconds")) getDouble("retryAfterSeconds").toLong() else null,
  )

private fun ReadableMap.hasNumber(name: String) = hasKey(name) && !isNull(name)

private fun ReadableMap.stringOrNull(name: String): String? =
  if (hasKey(name) && !isNull(name)) getString(name) else null

private fun ReadableMap.requireString(name: String): String =
  requireNotNull(stringOrNull(name)) { "Missing argument: $name" }

private fun ReadableMap.requireStrings(name: String): List<String> =
  requireNotNull(getArray(name)) { "Missing argument: $name" }.toArrayList().map { it as String }

private fun ReadableMap.requireMaps(name: String): List<ReadableMap> {
  val array = requireNotNull(getArray(name)) { "Missing argument: $name" }
  return List(array.size()) { requireNotNull(array.getMap(it)) }
}

private fun ReadableMap.theme() =
  TraciveReportTheme(
    primaryColor =
      if (hasNumber("primaryColor")) getDouble("primaryColor").toLong().toInt() else null,
    cornerRadius = if (hasNumber("cornerRadius")) getDouble("cornerRadius").toInt() else null,
  )

private fun ReportRequirements.toWire(): WritableMap =
  Arguments.createMap().apply {
    putBoolean("enabled", enabled)
    putInt("remainingToday", remainingToday)
    putMap("limits", limits.toWire())
    putArray(
      "terms",
      Arguments.createArray().also { array ->
        terms.forEach { term ->
          array.pushMap(
            Arguments.createMap().apply {
              putString("id", term.id)
              putString("version", term.version)
              putString("url", term.url)
            }
          )
        }
      },
    )
  }

private fun ReportLimits.toWire(): WritableMap =
  Arguments.createMap().apply {
    putInt("titleMaxLength", titleMaxLength)
    putInt("chronologyMinLength", chronologyMinLength)
    putInt("chronologyMaxLength", chronologyMaxLength)
    putInt("commentMaxLength", commentMaxLength)
    putInt("maxIdentifiers", maxIdentifiers)
    putInt("attachmentsPerIdentifier", attachmentsPerIdentifier)
    putInt("extraAttachmentsWithPhone", extraAttachmentsWithPhone)
    putInt("maxAttachmentBytes", maxAttachmentBytes)
    putArray("attachmentTypes", Arguments.fromList(attachmentTypes))
  }

private fun ReportFormOutcome.toWire(): WritableMap =
  Arguments.createMap().apply {
    when (val outcome = this@toWire) {
      is ReportFormOutcome.Submitted -> {
        putString("type", "submitted")
        putString("reportId", outcome.reportId)
        putString("status", outcome.status.name)
      }
      ReportFormOutcome.NeedsConsent -> putString("type", "needsConsent")
      ReportFormOutcome.Cancelled -> putString("type", "cancelled")
    }
  }

private fun ReportStatusOutcome.toWire(): String =
  when (this) {
    ReportStatusOutcome.Closed -> "closed"
    ReportStatusOutcome.NeedsConsent -> "needsConsent"
  }
