import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = {};
const files = [
  'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts',
  'README.md', 'Dockerfile', 'compose.yaml', '.dockerignore', '.env.example', '.gitignore',
  'docs/design.md', 'docs/verification.md',
];
const directories = ['src', 'server', 'shared', 'scripts', 'tests', 'deploy', 'public'];
const date = new Date('2026-01-01T00:00:00Z');

async function add(file) {
  const path = relative(root, file).split(sep).join('/');
  entries[`livelens/${path}`] = [await readFile(file), { mtime: date }];
}

async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink() || item.name === 'livelens-source.zip' || item.name.startsWith('.')) continue;
    const path = resolve(directory, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.isFile()) await add(path);
  }
}

await mkdir(resolve(root, 'public'), { recursive: true });
for (const file of files) await add(resolve(root, file));
for (const directory of directories) await walk(resolve(root, directory));
const archive = zipSync(entries, { level: 6 });
await writeFile(resolve(root, 'public/livelens-source.zip'), archive);
console.log(`Mã nguồn: ${Object.keys(entries).length} tệp, ${archive.byteLength} byte.`);
