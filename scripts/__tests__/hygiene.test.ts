import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The hygiene step is a CI gate, and for a while it was a gate that could not close: its
 * forbidden-token rules were read from an untracked `.hygiene-forbidden`, which by definition
 * cannot exist on a clean runner. The category was empty on every CI run while the workflow
 * advertised it as catching internal identifiers.
 *
 * These cases run the real script as a subprocess, because "the check can fail" is a claim about
 * an exit code and nothing smaller than an exit code proves it.
 */
const SCRIPT = join(process.cwd(), 'scripts', 'check-hygiene.js');
const TERMS = join(process.cwd(), 'scripts', 'hygiene-terms.txt');
const CORPUS = join(process.cwd(), 'scripts', 'hygiene-selftest.txt');

/**
 * Probes are read out of the self-test corpus rather than written here, for two reasons: this
 * file would otherwise have to contain the very strings the scanner is supposed to reject, and
 * a probe that lives in one place cannot drift from the rule it exercises.
 */
function probeFor(label: string): string {
  const lines = readFileSync(CORPUS, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.trim() === `# ${label}`);
  if (index === -1) throw new Error(`no probe labelled "${label}" in ${CORPUS}`);
  const probe = lines[index + 1];
  if (probe === undefined || probe.trim() === '') {
    throw new Error(`the probe labelled "${label}" in ${CORPUS} is empty`);
  }
  return `${probe}\n`;
}

function runInTemporaryTree(files: Record<string, string>): { status: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'tracive-hygiene-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(directory, name), contents, 'utf8');
    }
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: directory, encoding: 'utf8' });
    return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the public-hygiene check', () => {
  it('reads its term list from a TRACKED file', () => {
    // The whole defect was that this list lived somewhere a clean checkout could not have.
    expect(existsSync(TERMS)).toBe(true);
    const entries = readFileSync(TERMS, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(entries.length).toBeGreaterThan(0);
  });

  it('passes a clean tree', () => {
    const { status, output } = runInTemporaryTree({ 'readme.md': 'Nothing to see here.\n' });
    expect(output).toContain('clean');
    expect(status).toBe(0);
  });

  it('fails on a backend source path, with no private list present', () => {
    // This is the case that used to pass: no `.hygiene-forbidden` in a fresh directory meant no
    // forbidden-token rules at all.
    const { status, output } = runInTemporaryTree({ 'notes.md': probeFor('backend source path') });
    expect(output).toContain('forbidden_token');
    expect(status).toBe(1);
  });

  it('fails on a server-side function declaration', () => {
    const { status } = runInTemporaryTree({
      'notes.md': probeFor('server-side function declarations'),
    });
    expect(status).toBe(1);
  });

  it('fails on roadmap jargon in another language', () => {
    const { status } = runInTemporaryTree({
      'notes.md': probeFor('non-English roadmap jargon'),
    });
    expect(status).toBe(1);
  });

  it('allows an Android application id and its build variants, but nothing else', () => {
    // Build-variant suffixes are allowed as of the environment-following presence probe:
    // withholding a non-production application id protected nothing, because every authorize host
    // publishes its own — and its signing fingerprints — at /.well-known/assetlinks.json.
    const allowed = 'com.pleistocent.tracive';
    expect(runInTemporaryTree({ 'notes.md': `package ${allowed}\n` }).status).toBe(0);
    expect(runInTemporaryTree({ 'notes.md': `package ${allowed}.${'sandbox'}\n` }).status).toBe(0);

    // The lookahead still does work. A suffix that is not a dotted segment, and an id whose
    // second segment differs, are both still caught — the allowance is not a prefix allowance.
    // Both are assembled rather than written out, because writing either would be a violation in
    // this file, which is exactly what the rule under test says it is.
    const org = allowed.split('.').slice(0, 2).join('.');
    for (const forbidden of [`${allowed}${'x'}`, `${org}.${'other'}`]) {
      const { status, output } = runInTemporaryTree({ 'notes.md': `package ${forbidden}\n` });
      expect(output).toContain('organisation_token');
      expect(status).toBe(1);
    }
  });

  it('scans extension-less files and dotfiles, not only known extensions', () => {
    // LICENSE, .gitignore and .npmrc are all plain text that the walker used to skip, because it
    // keyed on an extension allowlist.
    expect(runInTemporaryTree({ LICENSE: probeFor('backend source path') }).status).toBe(1);
    expect(runInTemporaryTree({ '.npmrc': probeFor('backend source path') }).status).toBe(1);
  });

  it('skips a binary file rather than choking on it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tracive-hygiene-'));
    try {
      writeFileSync(join(directory, 'blob'), Buffer.from([0, 1, 2, 0, 255]));
      const result = spawnSync(process.execPath, [SCRIPT], { cwd: directory, encoding: 'utf8' });
      expect(result.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('still fails on the built-in shape rules', () => {
    const { status } = runInTemporaryTree({ 'notes.md': probeFor('backend_commit_sha') });
    expect(status).toBe(1);
  });
});
