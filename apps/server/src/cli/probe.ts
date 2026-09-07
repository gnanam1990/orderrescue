/**
 * Capability probe. Verifies the venue is reachable, the credentials work, and
 * the correlation path this product depends on actually exists — without
 * placing an order. Exits non-zero with a reason when anything is missing, so
 * it is usable as a preflight gate.
 */
import { loadConfig, ConfigError } from '../config.js';
import { BinanceSpotAdapter } from '@orderrescue/adapter-binance';

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`FAIL  configuration: ${error instanceof ConfigError ? error.message : String(error)}`);
    return 78;
  }

  const adapter = new BinanceSpotAdapter({
    baseUrl: config.binance.baseUrl,
    apiKey: config.binance.apiKey,
    apiSecret: config.binance.apiSecret,
    recvWindowMs: config.binance.recvWindowMs,
    timeoutMs: config.binance.timeoutMs,
    environment: 'TESTNET',
  });

  console.log(`environment       ${config.environment}`);
  console.log(`venue             ${config.binance.baseUrl}`);

  const report = await adapter.capabilities();
  console.log(`reachable         ${report.reachable ? 'yes' : 'no'}`);
  console.log(`authenticated     ${report.authenticated ? 'yes' : 'no'}`);
  console.log(`clock skew        ${report.serverTimeSkewMs === null ? 'unknown' : `${report.serverTimeSkewMs}ms`}`);
  console.log(`correlation       ${report.supportsClientOrderIdCorrelation ? 'clientOrderId (exact)' : 'NONE'}`);

  const symbol = process.argv[2] ?? 'BNBUSDT';
  let filtersOk = false;
  try {
    const filters = await adapter.loadSymbolFilters(symbol);
    filtersOk = filters.status === 'TRADING';
    console.log(`symbol            ${symbol} ${filters.status}`);
    console.log(`  minNotional     ${filters.minNotional ?? 'n/a'}`);
    console.log(`  stepSize        ${filters.stepSize ?? 'n/a'}`);
    console.log(`  assets          ${filters.baseAsset}/${filters.quoteAsset}`);
  } catch (error) {
    console.log(`symbol            ${symbol} UNAVAILABLE (${error instanceof Error ? error.message : String(error)})`);
  }

  for (const problem of report.problems) {
    console.log(`problem           ${problem}`);
  }

  if (!report.reachable) {
    console.error('\nFAIL  the venue is unreachable; nothing can be executed or verified');
    return 1;
  }
  if (!report.supportsClientOrderIdCorrelation) {
    console.error('\nFAIL  no exact correlation identifier is available; refusing to proceed with heuristic matching');
    return 1;
  }
  if (!filtersOk) {
    console.error(`\nFAIL  ${symbol} is not tradable on this venue`);
    return 1;
  }
  if (!report.authenticated) {
    console.error('\nPARTIAL  reads work and correlation exists, but credentials are missing or rejected: execution is unavailable');
    return 2;
  }

  console.log('\nPASS  reachable, authenticated, and correlated by an exact client order id');
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
