package id.tracive.sdk.reactnative

import java.io.File
import java.io.IOException

/** The one folder the SDK's FileProvider serves, and the single package file kept in it. */
internal object ReportPackageFiles {
  // Must match the cache-path in res/xml/tracive_rn_report_paths.xml.
  const val FOLDER = "tracive-sdk/report"

  fun directory(cacheDir: File): File = File(cacheDir, FOLDER)

  /**
   * Deletes what an earlier call left, then writes [contents]. Only the newest package is ever on
   * disk: the Tracive app copies it out the moment it receives it.
   */
  fun replace(directory: File, contents: String, nowMs: Long = System.currentTimeMillis()): File {
    clear(directory)
    if (!directory.isDirectory && !directory.mkdirs()) {
      throw IOException("The report folder could not be created.")
    }
    val file = File(directory, "report-$nowMs.tracivereport")
    file.writeText(contents, Charsets.UTF_8)
    return file
  }

  fun clear(directory: File) {
    directory.listFiles()?.forEach { it.deleteRecursively() }
  }
}
