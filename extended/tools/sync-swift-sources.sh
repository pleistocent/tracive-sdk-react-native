#!/bin/bash
# Copies the Swift overlay and screens into this package's pod, so tracive-sdk-swift stays the one
# source. It reads a checkout of that repository beside this one, or TRACIVE_SWIFT_SOURCES.
#
#   tools/sync-swift-sources.sh          writes the copies
#   tools/sync-swift-sources.sh --check  fails when the copies differ from tracive-sdk-swift/Sources
#
# The pod is one module, so an import of a sibling target has no meaning there, and the base Swift
# SDK is not in it at all. Those two imports are the only lines changed. What they brought in is in
# ios/BaseTypes.swift.
set -euo pipefail

package_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="${TRACIVE_SWIFT_SOURCES:-$package_dir/../../tracive-sdk-swift/Sources}"
pod_dir="$package_dir/ios"

if [[ ! -d $source_dir/TraciveSDKExtended || ! -d $source_dir/TraciveSDKExtendedUI ]]; then
  echo "error: no Swift sources in $source_dir." >&2
  echo "Check out tracive-sdk-swift beside this repository, or set TRACIVE_SWIFT_SOURCES." >&2
  exit 1
fi

copy_swift() {
  local from=$1 to=$2 file
  mkdir -p "$to"
  for file in "$from"/*.swift; do
    {
      echo "// Copied from tracive-sdk-swift/Sources by extended/tools/sync-swift-sources.sh. Edit it there."
      grep -vE '^import TraciveSDK(Extended)?$' "$file"
    } >"$to/$(basename "$file")"
  done
}

generate() {
  local out=$1
  copy_swift "$source_dir/TraciveSDKExtended" "$out/Synced/Overlay"
  copy_swift "$source_dir/TraciveSDKExtendedUI" "$out/Synced/Screens"
  mkdir -p "$out/Resources/Privacy" "$out/Resources/Strings"
  cp "$source_dir/TraciveSDKExtended/PrivacyInfo.xcprivacy" "$out/Resources/Privacy/"
  cp -R "$source_dir/TraciveSDKExtendedUI/Resources/"*.lproj "$out/Resources/Strings/"
}

if [[ ${1:-} == --check ]]; then
  expected=$(mktemp -d)
  trap 'rm -rf "$expected"' EXIT
  generate "$expected"
  for path in Synced Resources; do
    if ! diff -r "$expected/$path" "$pod_dir/$path"; then
      echo "error: the pod's copies differ from $source_dir. Run tools/sync-swift-sources.sh" >&2
      exit 1
    fi
  done
  echo "ok: the pod's copies match $source_dir"
else
  rm -rf "$pod_dir/Synced" "$pod_dir/Resources"
  generate "$pod_dir"
fi
