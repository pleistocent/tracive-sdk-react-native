// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path');

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// The SDK is a `file:..` dependency, so npm links it and Metro follows the symlink to the repo
// root. Both the sources and the two shared fixtures live outside this project, so they have to
// be watched from here or an edit to the SDK never reaches a running bundler.
config.watchFolders = [sdkRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(sdkRoot, 'node_modules'),
];

/**
 * `react` and `react-native` are pinned to THIS project's copies.
 *
 * Metro resolves a module from the importer's real path, and the SDK's real path is the repo
 * root — which has its own `react-native` in devDependencies, at a different version. Three of the
 * SDK's files import `Linking` from `react-native`, so without this the bundle carries two React
 * Natives: the native module registry is initialised in one and read from the other, and
 * `Linking.addEventListener` returns a subscription on a bridge nothing is speaking to. It fails
 * at runtime, not at build time, which is why it is worth pinning rather than hoping.
 */
const forced = new Set(['react', 'react-native']);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (forced.has(moduleName)) {
    return {
      type: 'sourceFile',
      filePath: require.resolve(moduleName, { paths: [projectRoot] }),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

/**
 * One of the two vendored anti-drift fixtures lives in a `__tests__` directory
 * (`src/query/__tests__/phone-normalization-vectors.json`), and Expo's default `blockList` hides
 * every such directory from Metro — from resolution AND from the file map, so a custom resolver
 * alone is not enough: the bundle then fails with "Failed to get the SHA-1 for".
 *
 * The fixture is deliberately NOT copied into this project. A second copy of a file whose whole job
 * is to be byte-identical across four SDK repositories is exactly the drift it exists to prevent,
 * so the block list gives way instead — for this one path, and nothing else.
 *
 * Each default pattern is rewritten to `^(?!<this file>$)(?:.*?(?:<original>))`. Anchoring at `^`
 * is what makes the lookahead binding: without it the engine simply retries at offset 1, where `^`
 * no longer holds, and the exemption evaporates. Rewriting rather than editing the pattern text
 * means this does not depend on how Expo happens to spell `__tests__` — which is not idle
 * caution: SDK 57 carried it as one alternative inside a larger group and SDK 55 as a pattern of
 * its own, and a version-specific edit silently stopped applying on the move between them.
 *
 * The assertion below is the whole reason that was a two-minute fix rather than a mystery: a
 * bundle that cannot see the fixture fails somewhere else entirely.
 */
const PHONE_VECTORS = path.resolve(sdkRoot, 'src/query/__tests__/phone-normalization-vectors.json');
const escaped = PHONE_VECTORS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const blockList = Array.isArray(config.resolver.blockList)
  ? config.resolver.blockList
  : [config.resolver.blockList];
config.resolver.blockList = blockList.map(
  (pattern) => new RegExp(`^(?!${escaped}$)(?:.*?(?:${pattern.source}))`, pattern.flags),
);
if (config.resolver.blockList.some((pattern) => pattern.test(PHONE_VECTORS))) {
  throw new Error(`Metro still blocks ${PHONE_VECTORS}; the exemption in metro.config.js failed.`);
}
// Proves the exemption did not simply unblock everything: a sibling under the same `__tests__`
// directory must still be blocked. Without this the check above passes just as happily against an
// empty block list.
const SIBLING = path.resolve(sdkRoot, 'src/query/__tests__/queryGrammar.test.ts');
if (!config.resolver.blockList.some((pattern) => pattern.test(SIBLING))) {
  throw new Error(`Metro no longer blocks ${SIBLING}; the exemption is wider than one file.`);
}

module.exports = config;
