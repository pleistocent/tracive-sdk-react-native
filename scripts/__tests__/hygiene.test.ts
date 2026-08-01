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

  it('allows the Android application id but not an id built on top of it', () => {
    // The suffix is assembled rather than written out: a non-production application id appears
    // nowhere in shipping code, so spelling one here would disclose that it exists — which is
    // the very thing this rule is for. The allowance used to be a plain substring, and a
    // substring allowance is also a prefix allowance.
    const allowed = 'com.pleistocent.tracive';
    expect(runInTemporaryTree({ 'notes.md': `package ${allowed}\n` }).status).toBe(0);

    const variant = `${allowed}.${'sandbox'}`;
    const { status, output } = runInTemporaryTree({ 'notes.md': `package ${variant}\n` });
    expect(output).toContain('organisation_token');
    expect(status).toBe(1);
  });

  it('still fails on the built-in shape rules', () => {
    const { status } = runInTemporaryTree({ 'notes.md': probeFor('backend_commit_sha') });
    expect(status).toBe(1);
  });
});
