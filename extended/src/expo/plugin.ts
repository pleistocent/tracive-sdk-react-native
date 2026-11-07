import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  withAppBuildGradle,
  withGradleProperties,
  withInfoPlist,
  withProjectBuildGradle,
  type ConfigPlugin,
} from '@expo/config-plugins';

const PACKAGE = '@pleistocent/tracive-sdk-extended-react-native';

// The Tracive AARs are built with Kotlin 2.3, and a compiler reads metadata one minor version ahead.
// They declare 36 as the lowest compileSdk that may consume them.
const MINIMUM_KOTLIN = '2.2.0';
const SET_KOTLIN = '2.2.21';
const MINIMUM_COMPILE_SDK = 36;

const DESUGAR = 'com.android.tools:desugar_jdk_libs:2.1.5';
const TRACIVE_SCHEMES = ['tracive', 'tracivesandbox'];

export interface TraciveReportsPluginProps {
  /**
   * Adds Maven Local, for the Tracive SDKs only, to build against versions published there rather
   * than on Maven Central. For development.
   */
  mavenLocal?: boolean;
}

/** Keeps what is listed, so another library's `canOpenURL` goes on working. */
export function mergeQuerySchemes(existing: string[] | undefined): string[] {
  const schemes = existing ?? [];
  for (const scheme of TRACIVE_SCHEMES) {
    if (!schemes.includes(scheme)) schemes.push(scheme);
  }
  return schemes;
}

function block(tag: string, body: string): string {
  return `\n// @generated begin ${tag}, by ${PACKAGE}\n${body}\n// @generated end ${tag}\n`;
}

/** Appended, not spliced in: Gradle merges a second `android` block, and no anchor can go stale. */
export function addDesugaring(gradle: string): string {
  if (gradle.includes('coreLibraryDesugaringEnabled true')) return gradle;
  return (
    gradle +
    block(
      'tracive-desugaring',
      [
        '// Dates in the Tracive SDK read java.time, which API 24 and 25 do not have without this.',
        'android { compileOptions { coreLibraryDesugaringEnabled true } }',
        `dependencies { coreLibraryDesugaring "${DESUGAR}" }`,
      ].join('\n'),
    )
  );
}

export function addMavenLocal(gradle: string): string {
  if (gradle.includes('includeGroup("com.pleistocent")')) return gradle;
  return (
    gradle +
    block(
      'tracive-maven-local',
      'allprojects { repositories { mavenLocal { content { includeGroup("com.pleistocent") } } } }',
    )
  );
}

/** The Gradle property sets the Kotlin that Expo compiles with, not the plugin Gradle loads. */
export function pinKotlinPlugin(gradle: string, version: string): string {
  return gradle.replace(
    /classpath\((['"])org\.jetbrains\.kotlin:kotlin-gradle-plugin\1\)/,
    `classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:${version}')`,
  );
}

function versionAtLeast(version: string, minimum: string): boolean {
  const have = version.split('.').map(Number);
  const need = minimum.split('.').map(Number);
  for (let i = 0; i < need.length; i++) {
    const difference = (have[i] ?? 0) - (need[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** The Gradle properties to set so the build meets the floors. Never lowers a version. */
export function requiredGradleProperties(catalog: string): Record<string, string> {
  const read = (name: string) => new RegExp(`^${name} = "([^"]+)"`, 'm').exec(catalog)?.[1];
  const required: Record<string, string> = {};
  const compileSdk = read('compileSdk');
  if (compileSdk === undefined || Number(compileSdk) < MINIMUM_COMPILE_SDK) {
    required['android.compileSdkVersion'] = String(MINIMUM_COMPILE_SDK);
  }
  const kotlin = read('kotlin');
  if (kotlin === undefined || !versionAtLeast(kotlin, MINIMUM_KOTLIN)) {
    required['android.kotlinVersion'] = SET_KOTLIN;
  }
  return required;
}

function reactNativeCatalog(projectRoot: string): string {
  const require = createRequire(join(projectRoot, 'package.json'));
  const root = dirname(require.resolve('react-native/package.json'));
  return readFileSync(join(root, 'gradle/libs.versions.toml'), 'utf8');
}

const withTraciveReports: ConfigPlugin<TraciveReportsPluginProps | void> = (config, props) => {
  config = withInfoPlist(config, (modConfig) => {
    modConfig.modResults.LSApplicationQueriesSchemes = mergeQuerySchemes(
      modConfig.modResults.LSApplicationQueriesSchemes as string[] | undefined,
    );
    return modConfig;
  });

  config = withGradleProperties(config, (modConfig) => {
    const required = requiredGradleProperties(reactNativeCatalog(modConfig.modRequest.projectRoot));
    for (const [key, value] of Object.entries(required)) {
      const declared = modConfig.modResults.some(
        (item) => item.type === 'property' && item.key === key,
      );
      if (!declared) modConfig.modResults.push({ type: 'property', key, value });
    }
    return modConfig;
  });

  config = withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = addDesugaring(modConfig.modResults.contents);
    return modConfig;
  });

  config = withProjectBuildGradle(config, (modConfig) => {
    const required = requiredGradleProperties(reactNativeCatalog(modConfig.modRequest.projectRoot));
    let gradle = modConfig.modResults.contents;
    const kotlin = required['android.kotlinVersion'];
    if (kotlin !== undefined) gradle = pinKotlinPlugin(gradle, kotlin);
    if (props?.mavenLocal === true) gradle = addMavenLocal(gradle);
    modConfig.modResults.contents = gradle;
    return modConfig;
  });

  return config;
};

export default withTraciveReports;
