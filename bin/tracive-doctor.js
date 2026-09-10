#!/usr/bin/env node
// Static host-configuration checker. It reads the Android manifest, the iOS Info.plist and
// entitlements, and app.json, then prints exactly what is missing along with the block to paste.
//
// The point of doing this at build time is that the defects it finds are silent at runtime: a
// missing declaration does not crash and does not log, it just routes every user to an install
// page. Exit code 1 on any hard finding.
import { parseArgv, runDoctor } from '../lib/module/doctor/run.js';

const report = runDoctor(parseArgv(process.argv.slice(2)));
process.stdout.write(`${report.text}\n`);
process.exit(report.exitCode);
