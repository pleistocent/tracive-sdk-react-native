// The Expo config plugin entry point. `exports` encapsulates the package, so the matching
// "./app.plugin.js" entry in package.json is load-bearing: without it `expo prebuild` cannot
// read this file at all.
export { default } from './lib/module/expo/plugin.js';
