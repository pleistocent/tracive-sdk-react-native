package id.tracive.sdk.reactnative

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

/**
 * Rejections carry fixed messages and no cause. An exception thrown around an intent prints the
 * intent, and its data URI carries the identifier, which must not reach JavaScript logs.
 */
class TraciveReportFormModule(reactContext: ReactApplicationContext) :
  NativeTraciveReportFormSpec(reactContext) {

  override fun getName(): String = NAME

  override fun isAppInstalled(androidPackage: String, promise: Promise) {
    val packageManager = reactApplicationContext.packageManager
    val installed =
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          packageManager.getPackageInfo(androidPackage, PackageManager.PackageInfoFlags.of(0))
        } else {
          @Suppress("DEPRECATION") packageManager.getPackageInfo(androidPackage, 0)
        }
        true
      } catch (_: PackageManager.NameNotFoundException) {
        false
      }
    promise.resolve(installed)
  }

  override fun deliverPackage(
    packageJson: String,
    androidPackage: String,
    mimeType: String,
    promise: Promise,
  ) {
    try {
      val context = reactApplicationContext
      val file =
        ReportPackageFiles.replace(ReportPackageFiles.directory(context.cacheDir), packageJson)
      val uri =
        FileProvider.getUriForFile(context, TraciveReportFileProvider.authority(context), file)
      val intent =
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, mimeType)
          .setPackage(androidPackage)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      if (intent.resolveActivity(context.packageManager) == null) {
        file.delete()
        promise.resolve(false)
        return
      }
      start(intent)
      promise.resolve(true)
    } catch (_: Exception) {
      promise.reject(ERROR_CODE, "The report package could not be handed to the Tracive app.")
    }
  }

  override fun openLink(url: String, androidPackage: String, promise: Promise) {
    try {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(androidPackage)
      if (intent.resolveActivity(reactApplicationContext.packageManager) == null) {
        promise.resolve(false)
        return
      }
      start(intent)
      promise.resolve(true)
    } catch (_: Exception) {
      promise.resolve(false)
    }
  }

  override fun presentPackage(
    packageJson: String,
    fileName: String,
    anchorTag: Double,
    promise: Promise,
  ) {
    promise.reject(ERROR_CODE, "presentPackage is iOS only.")
  }

  private fun start(intent: Intent) {
    val activity = reactApplicationContext.currentActivity
    if (activity != null) {
      activity.startActivity(intent)
    } else {
      reactApplicationContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  companion object {
    const val NAME = NativeTraciveReportFormSpec.NAME
    private const val ERROR_CODE = "E_TRACIVE_REPORT_FORM"
  }
}
