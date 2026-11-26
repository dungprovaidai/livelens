import { loadConfig } from './config.mjs';
import { createApp } from './http.mjs';
import { createTikTokFactory, SessionManager } from './manager.mjs';
import { createStore } from './store.mjs';

async function main() {
  const config = loadConfig();
  const store = await createStore(config);
  const manager = new SessionManager({ store, connectorFactory: createTikTokFactory(config.signApiKey) });
  try {
    await manager.recover();
  } catch (error) {
    await store.close();
    throw error;
  }
  const server = createApp({ store, manager, config });
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    try {
      await closed;
      await manager.close();
      await store.close();
    } catch {
      process.exitCode = 1;
      console.error('Không thể đóng hoàn toàn máy chủ LiveLens.');
    }
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.on('error', (error) => {
    process.exitCode = 1;
    console.error(error.code === 'EADDRINUSE'
      ? 'Cổng LiveLens đang được sử dụng. Hãy chọn PORT khác.'
      : 'Không thể mở cổng máy chủ LiveLens.');
    void shutdown();
  });
  server.listen(config.port, config.host, () => {
    console.log(`LiveLens sẵn sàng trên cổng ${config.port} (${store.kind}).`);
  });
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(error.message.startsWith('PORT') || error.message.startsWith('Cần APP_TOKEN')
    || error.message.startsWith('ALLOWED_ORIGINS') ? error.message
    : 'Không thể khởi động LiveLens. Hãy kiểm tra cấu hình máy chủ và kho lưu trữ.');
});
