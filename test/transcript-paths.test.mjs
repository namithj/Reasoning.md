import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, parseTranscript } from '../src/adapters.ts';
import { repository } from '../src/storage.ts';

const sources = {
  'claude-code': cwd => [
    { type: 'user', uuid: 'u1', sessionId: 's1', cwd, message: { content: 'Visible prompt' } },
  ],
  codex: cwd => [
    { type: 'session_meta', payload: { id: 's1', cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Visible prompt' }] } },
  ],
  'copilot-cli': cwd => [
    { id: 'start', type: 'session.start', data: { version: 1, sessionId: 's1', context: { cwd } } },
    { id: 'context', type: 'session.context_changed', data: { cwd } },
    { id: 'u1', type: 'user.message', data: { content: 'Visible prompt' } },
  ],
};

for (const [host, source] of Object.entries(sources)) {
  test(`${host} accepts worktree path aliases without weakening session checks`, t => {
    // Read the existing checkout only; this regression check performs no Git writes.
    const root = repository(fileURLToPath(new URL('../', import.meta.url))).root;
    const temporary = mkdtempSync(join(tmpdir(), 'reasoning-paths-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const alias = join(temporary, 'checkout alias');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    for (const cwd of [root, alias, join(alias, 'src')]) {
      for (const sourcePath of [root, alias]) {
        const data = source(sourcePath).map(row => JSON.stringify(row)).join('\n') + '\n';
        const parsed = parseTranscript(host, ADAPTERS[host].parser, data, 's1', cwd);
        assert.deepEqual(parsed.map(event => event.content), ['Visible prompt']);
        assert.throws(() => parseTranscript(host, ADAPTERS[host].parser, data, 'foreign', cwd), /session/);
      }
    }
  });
}
