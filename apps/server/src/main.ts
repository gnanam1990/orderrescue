import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { OrderRescueService } from './service.js';
import { buildApi } from './api.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`orderrescue: ${error.message}`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const service = new OrderRescueService(config);

  // Anything left unresolved by a previous process is re-queued for
  // observation before the API starts accepting new work.
  const resumed = service.journal.resumeUnresolvedOperations();
  if (resumed.length > 0) {
    console.log(`orderrescue: resumed ${resumed.length} unresolved operation(s) for observation, none re-dispatched`);
  }

  const chain = service.journal.verifyChain();
  if (!chain.ok) {
    console.error(`orderrescue: evidence chain is broken at sequence ${chain.brokenAt}: ${chain.reason}`);
    process.exit(70);
  }

  service.startReconciler();

  const app = buildApi(config, service);
  await app.listen({ host: config.host, port: config.port });

  console.log(`orderrescue: ${config.environment} console on http://${config.host}:${config.port}`);
  console.log(`orderrescue: venue ${config.binance.baseUrl}`);
  console.log(`orderrescue: execution ${config.binance.credentialsPresent ? 'enabled' : 'DISABLED (no credentials configured)'}`);
  console.log(`orderrescue: fault lab ${config.faultLabEnabled ? 'enabled' : 'disabled'}`);

  // The operator needs this value to use the console, but stdout is the wrong
  // place for it: server logs get pasted into issues and captured in demo
  // recordings. Write it to an owner-only file and print the path instead.
  const secretPath = resolve('.orderrescue-session');
  writeFileSync(secretPath, `${config.sessionSecret}\n`, { mode: 0o600 });
  console.log(`orderrescue: session secret written to ${secretPath} (mode 0600)`);

  const shutdown = async () => {
    await service.stop();
    await app.close();
    service.journal.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
