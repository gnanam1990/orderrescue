import { closeSync, constants, fchmodSync, openSync, writeSync } from 'node:fs';
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
  writeSecretFile(secretPath, `${config.sessionSecret}\n`);
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

/**
 * Writes a credential to disk without trusting what is already at the path.
 *
 * O_NOFOLLOW makes the open fail rather than write through a symlink someone
 * planted there, and fchmod is applied to the open descriptor because the
 * `mode` argument only takes effect when a file is created — an existing
 * world-readable file would otherwise keep its permissions.
 */
function writeSecretFile(path: string, contents: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new Error(`refusing to write the session secret: ${path} is a symbolic link`);
    }
    throw error;
  }
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
