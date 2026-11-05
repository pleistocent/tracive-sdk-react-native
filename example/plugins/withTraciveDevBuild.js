// The example's own config plugin, for QA against the Tracive dev build. The SDK's plugin covers
// production and sandbox only, because a shipping app never targets the dev build; this adds the
// entries that `ReportFormTarget.custom(...)` in src/ReportScammer.tsx needs to reach it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

const DEV_PACKAGE = 'com.pleistocent.tracive.dev';
const DEV_SCHEMES = ['tracivedev', 'tracivedev-report'];

module.exports = function withTraciveDevBuild(config) {
  config = withInfoPlist(config, (modConfig) => {
    const schemes = modConfig.modResults.LSApplicationQueriesSchemes ?? [];
    for (const scheme of DEV_SCHEMES) {
      if (!schemes.includes(scheme)) schemes.push(scheme);
    }
    modConfig.modResults.LSApplicationQueriesSchemes = schemes;
    return modConfig;
  });

  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;
    const queries = manifest.queries ?? [{}];
    const target = queries[0];
    const packages = target.package ?? [];
    if (!packages.some((entry) => entry.$?.['android:name'] === DEV_PACKAGE)) {
      packages.push({ $: { 'android:name': DEV_PACKAGE } });
    }
    target.package = packages;
    manifest.queries = queries;
    return modConfig;
  });
};
