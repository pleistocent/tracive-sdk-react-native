package id.tracive.sdk.reactnative

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReportPackageFilesTest {
  private val cacheDir: File = Files.createTempDirectory("tracive-rn-cache").toFile()

  @Test
  fun writesThePackageUnderTheServedFolder() {
    val file = ReportPackageFiles.replace(ReportPackageFiles.directory(cacheDir), "{\"v\":1}", 1L)

    assertEquals(File(cacheDir, "tracive-sdk/report/report-1.tracivereport"), file)
    assertEquals("{\"v\":1}", file.readText())
  }

  @Test
  fun deletesWhatTheEarlierCallLeftBeforeWriting() {
    val directory = ReportPackageFiles.directory(cacheDir)
    val stale = ReportPackageFiles.replace(directory, "first", 1L)
    val strayFolder = File(directory, "stray").apply { mkdirs() }
    File(strayFolder, "leftover").writeText("x")

    val fresh = ReportPackageFiles.replace(directory, "second", 2L)

    assertFalse(stale.exists())
    assertFalse(strayFolder.exists())
    assertTrue(fresh.exists())
    assertEquals(listOf(fresh.name), directory.list()!!.toList())
  }

  @Test
  fun leavesTheRestOfTheCacheAlone() {
    val neighbour = File(cacheDir, "tracive-sdk/other").apply { mkdirs() }

    ReportPackageFiles.replace(ReportPackageFiles.directory(cacheDir), "{}", 1L)

    assertTrue(neighbour.exists())
  }
}
