# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] — 2026-11-07

### Added

- `TraciveReports`: `requirements`, `prepare`, `submit`, `status`, `openInTracive`, `dispose`.
- `TraciveReportForm` and `TraciveReportStatus`, Tracive's native screens.
- `ReportDraft`, with `problems()` and the idempotency key that stops a retry filing twice.
- An Expo config plugin.
