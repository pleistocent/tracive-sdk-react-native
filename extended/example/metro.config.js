const { realpathSync } = require('node:fs');
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, '..');
const baseRoot = realpathSync(
  path.join(projectRoot, 'node_modules/@pleistocent/tracive-sdk-react-native'),
);

const config = getDefaultConfig(projectRoot);

// Both SDKs are links, so an edit to either would otherwise never reach a running bundler.
config.watchFolders = [sdkRoot, baseRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(sdkRoot, 'node_modules'),
];

// Metro resolves a module from the importer's real path, and each SDK's real path has its own
// `react-native` in devDependencies. Two React Natives in a bundle read the native module registry
// from one and initialise it in the other, which fails at runtime and not at build time.
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

module.exports = config;
