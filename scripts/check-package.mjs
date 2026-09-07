import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

assert.ok(process.env.npm_execpath, 'Run this check with npm run check:package');
const [pack] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
const paths = pack.files.map(file => file.path);
assert.ok(paths.includes('dist/cli.js') && paths.includes('skills/reasoning-md/SKILL.md'), 'Build the CLI and include the companion skill before packaging');
assert.ok(paths.every(path => !/^(?:docs\/private|\.ai-history|release|\.git)(?:\/|$)/.test(path)), 'Private or local-only files would be published');
console.log(`Package boundary check passed: ${paths.length} files; private documentation and local state excluded.`);
