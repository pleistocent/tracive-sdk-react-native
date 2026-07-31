#!/usr/bin/env node
// Public-hygiene check.
//
// This repository is published. Nothing in it — code, comments, docs, test names, error strings
// or commit messages — may name an internal repository, an internal design document, a backend
// commit, a backend source path or symbol, a server-side function name, the backend's database
// product, an internal collection path, or non-English roadmap phase jargon. Say "the Tracive
// API", "the server", "record key", "phase 1 / phase 2".
//
// A note on how this script is written, because it is not obvious: it checks CATEGORIES and
// SHAPES rather than embedding the literal internal names. Writing those names into a public
// repository's tooling would leak exactly what the rule exists to protect — the denylist would
// become the disclosure. The infrastructure-vendor list below deliberately names many vendors,
// so it asserts nothing about which one is real.
//
// The internal literal list is applied by supplying it out of band: create an untracked
// `.hygiene-forbidden` file, one case-insensitive token or /regex/ per line, and this script
// picks it up. That keeps the private list private and still fails the build.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SELF = 'scripts/check-hygiene.js';

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'lib', 'coverage', 'android', 'ios']);
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.xml',
  '.plist',
  '.sh',
]);

// The one allowed exception, and the only permitted matches for the org token.
const ALLOWED_PLEISTOCENT_LITERALS = [
  'com.pleistocent.tracive.dev',
  'com.pleistocent.tracive',
  'github.com/pleistocent/tracive-sdk-react-native',
  'pleistocent/tracive-sdk-react-native',
];

const RULES = [
  {
    code: 'backend_commit_sha',
    // A 40-character hex run is a git object id. Nothing legitimate in this repository is one:
    // the fixture hash is 64 characters and lives in an allowlisted line.
    pattern: /\b[0-9a-f]{40}\b/g,
    message: 'looks like a backend commit id',
  },
  {
    code: 'infrastructure_vendor',
    // Backend infrastructure naming, of any flavour, does not belong in a public client SDK.
    pattern:
      /\b(firestore|firebase|cloudfunctions|cloud function|dynamodb|bigtable|cosmosdb|mongodb|supabase|planetscale|rds\.amazonaws)\b/gi,
    message: 'names backend infrastructure; say "the Tracive API" or "the server"',
  },
  {
    code: 'internal_collection_path',
    pattern: /\b(collection|doc)\(\s*['"`][a-z_/-]+['"`]\s*\)/gi,
    message: 'looks like an internal database collection path',
  },
  {
    code: 'internal_document_reference',
    pattern: /\b(internal design doc|design doc:|RFC-INT|internal spec)\b/gi,
    message: 'references an internal document',
  },
];

function loadExternalRules() {
  const path = join(ROOT, '.hygiene-forbidden');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const asRegex = /^\/(.*)\/([a-z]*)$/.exec(line);
      return {
        code: 'forbidden_token',
        pattern: asRegex
          ? new RegExp(asRegex[1], asRegex[2].includes('g') ? asRegex[2] : `${asRegex[2]}g`)
          : new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        message: 'matches a forbidden internal token',
      };
    });
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walk(path, files);
    } else {
      const dot = entry.lastIndexOf('.');
      if (dot !== -1 && TEXT_EXTENSIONS.has(entry.slice(dot))) files.push(path);
    }
  }
  return files;
}

function checkPleistocent(line) {
  let remaining = line;
  for (const allowed of ALLOWED_PLEISTOCENT_LITERALS) {
    remaining = remaining.split(allowed).join('');
  }
  return /pleistocent/i.test(remaining);
}

const rules = [...RULES, ...loadExternalRules()];
const violations = [];

for (const path of walk(ROOT)) {
  const relativePath = relative(ROOT, path);
  if (relativePath === SELF) continue; // this file quotes the patterns in order to state them

  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      const match = rule.pattern.exec(line);
      if (match !== null) {
        violations.push({
          path: relativePath,
          line: index + 1,
          code: rule.code,
          detail: `${match[0]} — ${rule.message}`,
        });
      }
    }
    if (checkPleistocent(line)) {
      violations.push({
        path: relativePath,
        line: index + 1,
        code: 'organisation_token',
        detail:
          'the organisation token appears outside its allowed literals ' +
          `(${ALLOWED_PLEISTOCENT_LITERALS.join(', ')})`,
      });
    }
  });
}

if (violations.length > 0) {
  console.error('check-hygiene: public-hygiene violations found.\n');
  for (const violation of violations) {
    console.error(`  ${violation.path}:${violation.line}  [${violation.code}] ${violation.detail}`);
  }
  console.error(
    '\nUse "the Tracive API", "the server", "record key", "phase 1" / "phase 2" instead.',
  );
  process.exit(1);
}

console.log('check-hygiene: clean.');
