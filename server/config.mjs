import { isIPv4 } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));

export function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]' || (isIPv4(host) && host.startsWith('127.'));
}

export function loadConfig(env = process.env) {
  const host = !env.HOST || env.HOST === 'localhost' ? '127.0.0.1' : env.HOST;
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT phải là số nguyên từ 1 đến 65535.');
  }

  const local = isLoopback(host);
  const appToken = env.APP_TOKEN?.trim() || '';
  if (!local && !appToken) throw new Error('Cần APP_TOKEN khi máy chủ nhận kết nối từ xa.');

  const allowedOrigins = new Set();
  for (const value of (env.ALLOWED_ORIGINS ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    let origin;
    try {
      origin = new URL(value);
    } catch {
      throw new Error('ALLOWED_ORIGINS phải chứa các origin HTTP hoặc HTTPS hợp lệ.');
    }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value) {
      throw new Error('ALLOWED_ORIGINS chỉ chấp nhận origin đầy đủ, không có đường dẫn hoặc ký tự đại diện.');
    }
    allowedOrigins.add(origin.origin);
  }
  if (local) {
    for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
      allowedOrigins.add(`http://${name}:${port}`);
      allowedOrigins.add(`http://${name}:5173`);
    }
  }

  return {
    host,
    port,
    appToken,
    allowedOrigins,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    sqlitePath: env.SQLITE_PATH || resolve(project, 'data/livelens.sqlite'),
    signApiKey: env.SIGN_API_KEY?.trim() || undefined,
    staticDir: resolve(project, 'dist/client'),
  };
}
