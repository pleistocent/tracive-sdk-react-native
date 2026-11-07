import { describe, expect, it } from '@jest/globals';

import {
  addDesugaring,
  addMavenLocal,
  mergeQuerySchemes,
  pinKotlinPlugin,
  requiredGradleProperties,
} from '../expo/plugin';

describe('query schemes', () => {
  it('adds both Tracive builds and keeps the rest', () => {
    expect(mergeQuerySchemes(['other'])).toEqual(['other', 'tracive', 'tracivesandbox']);
  });

  it('adds nothing twice', () => {
    expect(mergeQuerySchemes(['tracive', 'tracivesandbox'])).toEqual(['tracive', 'tracivesandbox']);
  });

  it('starts from nothing', () => {
    expect(mergeQuerySchemes(undefined)).toEqual(['tracive', 'tracivesandbox']);
  });
});

describe('Gradle edits', () => {
  it('turns desugaring on once', () => {
    const once = addDesugaring('android {}\n');
    expect(once).toContain('coreLibraryDesugaringEnabled true');
    expect(once).toContain('coreLibraryDesugaring "com.android.tools:desugar_jdk_libs:');
    expect(addDesugaring(once)).toBe(once);
  });

  it('leaves a host that already desugars alone', () => {
    const host = 'android { compileOptions { coreLibraryDesugaringEnabled true } }\n';
    expect(addDesugaring(host)).toBe(host);
  });

  it('limits Maven Local to one group, once', () => {
    const once = addMavenLocal('apply plugin: "x"\n');
    expect(once).toContain('mavenLocal { content { includeGroup("com.pleistocent") } }');
    expect(addMavenLocal(once)).toBe(once);
  });
});

describe('build floors', () => {
  it('raises an older React Native', () => {
    expect(requiredGradleProperties('compileSdk = "35"\nkotlin = "2.1.20"\n')).toEqual({
      'android.compileSdkVersion': '36',
      'android.kotlinVersion': '2.2.21',
    });
  });

  it('asks only for Kotlin on compileSdk 36', () => {
    expect(requiredGradleProperties('compileSdk = "36"\nkotlin = "2.1.20"\n')).toEqual({
      'android.kotlinVersion': '2.2.21',
    });
  });

  it('leaves one that meets them', () => {
    expect(requiredGradleProperties('compileSdk = "36"\nkotlin = "2.2.0"\n')).toEqual({});
  });

  it('pins the Kotlin plugin the template leaves open', () => {
    expect(
      pinKotlinPlugin("    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')\n", '2.2.21'),
    ).toBe("    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.21')\n");
  });

  it('leaves a Kotlin plugin that already names its version', () => {
    const pinned = "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:2.3.0')";
    expect(pinKotlinPlugin(pinned, '2.2.21')).toBe(pinned);
  });

  it('never lowers a newer one', () => {
    expect(requiredGradleProperties('compileSdk = "38"\nkotlin = "2.10.0"\n')).toEqual({});
  });

  it('raises what it cannot read', () => {
    expect(Object.keys(requiredGradleProperties(''))).toHaveLength(2);
  });
});
