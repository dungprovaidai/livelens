import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let shuttingDown = false;

function run(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  children.push(child);
  child.once('exit', (code) => {
    if (!shuttingDown) shutdown(code ?? 1);
  });
  child.once('error', (error) => { console.error(error.message); shutdown(1); });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 3000);
  timer.unref();
  Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
    .then(() => process.exit(code));
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
if (process.env.SITES_MANAGED_LINUX_CONTAINER !== '1') {
  run(['--env-file-if-exists=.env', 'server/index.mjs'], { HOST: '127.0.0.1', PORT: '3001' });
}
run(['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], {});
