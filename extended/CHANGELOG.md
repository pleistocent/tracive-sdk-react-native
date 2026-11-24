# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0]

### Changed

- Tracive's form shows a QRIS identifier as `QRIS · <NMID>`.
- Needs `@pleistocent/tracive-sdk-react-native` 0.3.0 or newer, which adds the QRIS query builders.

## [0.2.2] — 2026-11-08

First release.

### Added

- `TraciveReports`: `requirements`, `prepare`, `submit`, `status`, `openInTracive`, `dispose`.
- `TraciveReportForm` and `TraciveReportStatus`, Tracive's native screens.
- `ReportDraft`, with `problems()` and the idempotency key that stops a retry filing twice.
- An Expo config plugin.

[Unreleased]: https://github.com/pleistocent/tracive-sdk-react-native/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/pleistocent/tracive-sdk-react-native/releases/tag/v0.2.2
