import { mkdir, readdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });
for (const file of await readdir(new URL('src/', root))) {
  if (!file.endsWith('.ts')) continue;
  const source = await readFile(new URL(`src/${file}`, root), 'utf8');
  const js = stripTypeScriptTypes(source).replace(/(from\s+'\.\/[^']+)\.ts'/g, "$1.js'");
  await writeFile(new URL(`dist/${file.replace(/\.ts$/, '.js')}`, root), js);
}
await chmod(new URL('dist/cli.js', root), 0o755);
