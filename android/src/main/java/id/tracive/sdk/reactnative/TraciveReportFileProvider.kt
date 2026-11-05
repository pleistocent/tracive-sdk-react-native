package id.tracive.sdk.reactnative

import android.content.Context
import androidx.core.content.FileProvider

/**
 * A subclass, so the manifest merger keeps it apart from a host's own FileProvider entry instead of
 * merging the two into one provider with one set of paths.
 */
class TraciveReportFileProvider : FileProvider() {
  internal companion object {
    fun authority(context: Context): String = "${context.packageName}.tracive-rn-files"
  }
}
