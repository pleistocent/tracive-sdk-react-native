#!/usr/bin/env node
// Pins the shared fixtures by content hash.
//
// Three fixtures, pinned the same way. The grammar one is the contract between the four SDKs and the
// server's key normalizer; the phone one is the contract between the four SDKs and the Tracive app's
// own normalizer, which is what keeps app and SDK folding one person to one record key. The bank-code
// table is the server's own translation of a national bank code or BIC to a bankCode, and the SDK
// embeds it (src/query/bankCodesJson.ts, which a test keeps identical to this file).
//
// Each file is vendored byte-identically into the Tracive SDKs for Kotlin, Flutter and Swift, so an
// edit in one repository must fail loudly here rather than quietly teaching one SDK a different
// contract from the other three.
//
// The phone fixture shipped on 2 August 2026 with no pin in any repository, and an audit then found
// the four SDKs disagreeing on a digit joined to a variation selector — the exact drift a pinned
// shared fixture exists to make impossible.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FIXTURES = [
  {
    path: 'test/fixtures/query-grammar-vectors.json',
    sha256: 'e63439047455e20e0952d75ad438ec8c7b2f80e8b1872c5e6c47628daab89bfe',
    bytes: 27423,
    name: 'grammar',
  },
  {
    path: 'test/fixtures/bank-codes.json',
    sha256: '77eda1e45ec5d2894d9a676452f98470fa2c337d6ea12ab628ff176e62e740d5',
    bytes: 22663,
    name: 'bank-code',
  },
  {
    path: 'src/query/__tests__/phone-normalization-vectors.json',
    sha256: 'de39974af93c6d466043708e0c1aa1f4e9d9aa6e426d458c5a29a1ac015323f1',
    bytes: 44023,
    name: 'phone-normalization',
  },
];

let failed = false;
for (const fixture of FIXTURES) {
  let bytes;
  try {
    bytes = readFileSync(fixture.path);
  } catch (error) {
    console.error(`verify-fixture: cannot read ${fixture.path}: ${error.message}`);
    failed = true;
    continue;
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  const problems = [];
  if (actual !== fixture.sha256) {
    problems.push(`sha256 is ${actual}, expected ${fixture.sha256}`);
  }
  if (bytes.length !== fixture.bytes) {
    problems.push(`size is ${bytes.length} bytes, expected ${fixture.bytes}`);
  }

  if (problems.length > 0) {
    console.error(`verify-fixture: the shared ${fixture.name} fixture has been modified.`);
    for (const problem of problems) console.error(`  - ${problem}`);
    failed = true;
    continue;
  }

  console.log(`verify-fixture: ${fixture.path} matches the pinned hash (${fixture.bytes} bytes).`);
}

if (failed) {
  console.error(
    '\nA shared fixture must never be edited in one SDK alone. If the contract genuinely changed,\n' +
      'the change belongs upstream and then lands in all four SDKs together.',
  );
  process.exit(1);
}
