import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => ['true', 'false', '1', '0', 'yes', 'no', ''].includes(v), 'must be a boolean')
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z.object({
  ORDERRESCUE_ENV: z.enum(['TESTNET', 'MAINNET']).default('TESTNET'),
  ORDERRESCUE_HOST: z.string().default('127.0.0.1'),
  ORDERRESCUE_PORT: z.coerce.number().int().min(1).max(65535).default(4319),
  ORDERRESCUE_DB_PATH: z.string().default('./data/journal.db'),
  ORDERRESCUE_SESSION_SECRET: z.string().min(16).optional(),
  ORDERRESCUE_FAULT_LAB: booleanish.default('true'),
  ORDERRESCUE_MAX_NOTIONAL: z.string().default('25'),
  ORDERRESCUE_RECONCILE_BASE_MS: z.coerce.number().int().min(200).default(1500),
  ORDERRESCUE_RECONCILE_MAX_MS: z.coerce.number().int().min(1000).default(20_000),
  ORDERRESCUE_ABSENCE_MIN_ATTEMPTS: z.coerce.number().int().min(2).default(5),
  ORDERRESCUE_ABSENCE_WINDOW_MS: z.coerce.number().int().min(5000).default(60_000),
  BINANCE_BASE_URL: z.string().url().default('https://testnet.binance.vision'),
  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  BINANCE_RECV_WINDOW_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),
  BINANCE_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
});

export interface Config {
  environment: 'TESTNET';
  host: string;
  port: number;
  dbPath: string;
  sessionSecret: string;
  faultLabEnabled: boolean;
  maxNotional: string;
  reconcileBaseMs: number;
  reconcileMaxMs: number;
  absenceMinAttempts: number;
  absenceWindowMs: number;
  binance: {
    baseUrl: string;
    apiKey: string;
    apiSecret: string;
    recvWindowMs: number;
    timeoutMs: number;
    credentialsPresent: boolean;
  };
}

export class ConfigError extends Error {}

const MAINNET_HOSTS = ['api.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com', 'api4.binance.com'];

/**
 * Resolves the journal path to an absolute one, against the directory the
 * command was invoked from rather than the process cwd.
 *
 * pnpm runs a package script with cwd set to that package's directory, so a
 * relative `./data/journal.db` meant two different files depending on whether
 * you ran the server or a CLI — and the CLI would happily create the second
 * one. INIT_CWD is where the user actually stood, which is what they meant.
 */
function resolveDbPath(configured: string, env: NodeJS.ProcessEnv): string {
  if (configured === ':memory:' || isAbsolute(configured)) return configured;
  const base = env.INIT_CWD ?? process.cwd();
  return resolve(base, configured);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid configuration: ${issues}`);
  }
  const value = parsed.data;

  // Hard lockout. This build is for a hackathon demo against testnet; there is
  // no configuration of it that trades real money.
  if (value.ORDERRESCUE_ENV === 'MAINNET') {
    throw new ConfigError(
      'ORDERRESCUE_ENV=MAINNET is refused: this build executes against Binance Spot Testnet only',
    );
  }

  const host = new URL(value.BINANCE_BASE_URL).hostname;
  if (MAINNET_HOSTS.includes(host)) {
    throw new ConfigError(
      `BINANCE_BASE_URL points at the mainnet host ${host}; this build executes against Binance Spot Testnet only`,
    );
  }

  const faultLabEnabled = value.ORDERRESCUE_FAULT_LAB;

  return {
    environment: 'TESTNET',
    host: value.ORDERRESCUE_HOST,
    port: value.ORDERRESCUE_PORT,
    dbPath: resolveDbPath(value.ORDERRESCUE_DB_PATH, env),
    // Generated per process when unset: a mutation route is never left
    // unprotected just because nobody configured a secret.
    sessionSecret: value.ORDERRESCUE_SESSION_SECRET ?? randomBytes(32).toString('hex'),
    faultLabEnabled,
    maxNotional: value.ORDERRESCUE_MAX_NOTIONAL,
    reconcileBaseMs: value.ORDERRESCUE_RECONCILE_BASE_MS,
    reconcileMaxMs: value.ORDERRESCUE_RECONCILE_MAX_MS,
    absenceMinAttempts: value.ORDERRESCUE_ABSENCE_MIN_ATTEMPTS,
    absenceWindowMs: value.ORDERRESCUE_ABSENCE_WINDOW_MS,
    binance: {
      baseUrl: value.BINANCE_BASE_URL,
      apiKey: value.BINANCE_API_KEY,
      apiSecret: value.BINANCE_API_SECRET,
      recvWindowMs: value.BINANCE_RECV_WINDOW_MS,
      timeoutMs: value.BINANCE_TIMEOUT_MS,
      credentialsPresent: value.BINANCE_API_KEY !== '' && value.BINANCE_API_SECRET !== '',
    },
  };
}
