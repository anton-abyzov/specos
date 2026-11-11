import os from 'node:os';
import { buildApp } from './app';

function lanAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

const specos = await buildApp();
await specos.listen();
const address = specos.app.server.address();
const port = typeof address === 'object' && address ? address.port : specos.config.port;

// The one line a person needs: open this from another computer on the network.
console.log(`SpecOS  http://${lanAddress()}:${port}/?token=${specos.config.token}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void specos.close().finally(() => process.exit(0));
  });
}
