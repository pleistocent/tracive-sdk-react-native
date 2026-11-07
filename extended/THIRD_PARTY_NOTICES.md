# Third-party notices

The Kotlin core embeds these native components. They ship inside your app.

| Component                                                           | Used for                  | Licence                                   |
| ------------------------------------------------------------------- | ------------------------- | ----------------------------------------- |
| [AvifKit](https://github.com/alfikri-rizky/AvifKit) 1.0.0           | Encoding evidence as AVIF | MIT                                       |
| [libavif](https://github.com/AOMediaCodec/libavif), through AvifKit | AVIF container            | BSD 2-Clause                              |
| [libaom](https://aomedia.googlesource.com/aom), through AvifKit     | AV1 encoder               | BSD 2-Clause, with the AOM Patent License |

The version is pinned in `gradle/libs.versions.toml` of the Kotlin SDK, and moves only by a reviewed
change.

Everything else, such as Ktor, kotlinx and AndroidX, is Apache-2.0 and is resolved by your build.
