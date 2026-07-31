// Pinned explicitly rather than inheriting bob's default browserslist target, which can emit
// syntax newer than the Hermes shipped with the oldest React Native version we declare support
// for. `.cjs` because package.json sets `"type": "module"` and Babel's config loader is sync.
module.exports = {
  presets: [['@react-native/babel-preset', { unstable_transformProfile: 'hermes-stable' }]],
};
