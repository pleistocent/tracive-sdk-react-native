#!/usr/bin/env node
// Pins the shared grammar fixture by content hash.
//
// The same file is vendored byte-identically into the Tracive SDKs for Kotlin, Flutter and Swift.
// It is the anti-drift contract between them, so an edit in one repository must fail loudly here
// rather than quietly teaching one SDK a different grammar from the other three.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FIXTURE = 'test/fixtures/query-grammar-vectors.json';
const EXPECTED_SHA256 = '102d8fd83ae0bcb343e44b691090d2409b6b195b61ae9a911cc0bac96563dd07';
const EXPECTED_BYTES = 20075;

let bytes;
try {
  bytes = readFileSync(FIXTURE);
} catch (error) {
  console.error(`verify-fixture: cannot read ${FIXTURE}: ${error.message}`);
  process.exit(1);
}

const actual = createHash('sha256').update(bytes).digest('hex');
const problems = [];
if (actual !== EXPECTED_SHA256) {
  problems.push(`sha256 is ${actual}, expected ${EXPECTED_SHA256}`);
}
if (bytes.length !== EXPECTED_BYTES) {
  problems.push(`size is ${bytes.length} bytes, expected ${EXPECTED_BYTES}`);
}

if (problems.length > 0) {
  console.error('verify-fixture: the shared grammar fixture has been modified.');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nThis file must never be edited in one SDK alone. If the grammar genuinely changed, the\n' +
      'change belongs in the Tracive API first and then lands in all four SDKs together.',
  );
  process.exit(1);
}

console.log(`verify-fixture: ${FIXTURE} matches the pinned hash (${EXPECTED_BYTES} bytes).`);
