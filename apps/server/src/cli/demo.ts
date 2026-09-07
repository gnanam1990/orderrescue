/**
 * The failure-path demo, end to end, against real Binance Spot Testnet.
 *
 * This script places one real testnet order, destroys the response, proves the
 * retry is blocked, restarts the journal from disk, and then asks Binance what
 * actually happened. Nothing in it is simulated: if credentials are missing it
 * stops rather than pretending.
 *
 *   pnpm demo
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { OrderRescueService } from '../service.js';
import { Journal } from '@orderrescue/journal';
import { isDomainError } from '@orderrescue/domain';

const step = (n: number, text: string) => console.log(`\n[${n}] ${text}`);
const fact = (label: string, value: unknown) => console.log(`    ${label.padEnd(22)} ${String(value)}`);

async function main(): Promise<number> {
  const config = loadConfig();
  const symbol = process.env.DEMO_SYMBOL ?? 'BNBUSDT';
  const quoteQuantity = process.env.DEMO_QUOTE_QTY ?? '20';

  console.log('OrderRescue failure-path demo');
  fact('environment', config.environment);
  fact('venue', config.binance.baseUrl);
  fact('symbol', symbol);

  if (!config.binance.credentialsPresent) {
    console.error(
      '\nSTOP  no Binance testnet credentials configured.\n' +
        '      Get a key pair from https://testnet.binance.vision and set\n' +
        '      BINANCE_API_KEY and BINANCE_API_SECRET. This demo places a real\n' +
        '      testnet order; it will not fake one.',
    );
    return 78;
  }

  let service = new OrderRescueService(config);

  step(0, 'Capability probe');
  const capabilities = await service.adapter.capabilities();
  fact('reachable', capabilities.reachable);
  fact('authenticated', capabilities.authenticated);
  fact('clock skew', `${capabilities.serverTimeSkewMs}ms`);
  fact('correlation', capabilities.supportsClientOrderIdCorrelation ? 'clientOrderId (exact)' : 'NONE');
  if (!capabilities.reachable || !capabilities.authenticated) {
    console.error('\nSTOP  the venue is unreachable or the credentials are rejected.');
    for (const problem of capabilities.problems) console.error(`      ${problem}`);
    return 1;
  }

  step(1, 'Create and confirm one capped intent');
  const created = await service.createIntent(
    {
      accountRef: 'agentic-sub-1',
      symbol,
      side: 'BUY',
      orderType: 'MARKET',
      quoteQuantity,
      maxNotional: config.maxNotional,
      createdBy: 'demo-script',
      expiresInSeconds: 600,
    },
    `demo-${Date.now()}`,
  );
  const operationId = created.operation.operationId;
  const intentId = created.intent.intentId;
  fact('intent digest', created.intent.intentDigest);
  fact('client order id', created.operation.venueClientOrderId);
  console.log('    ^ committed to disk before anything is sent');
  service.confirmIntent(operationId, 'demo-user-approval');

  step(2, 'Arm the fault: drop the acknowledgement after dispatch');
  service.fault.dropNextAck = true;
  console.log('    the request will still reach Binance; only our knowledge of the reply is destroyed');

  step(3, 'Execute once');
  const executed = await service.executeIntent(operationId);
  fact('outcome', executed.outcome);
  fact('state', executed.state);
  fact('detail', executed.detail);
  if (executed.state !== 'UNKNOWN') {
    console.error('\nFAIL  expected the operation to be UNKNOWN after the dropped acknowledgement');
    return 1;
  }

  step(4, 'A naive agent retries here');
  try {
    await service.executeIntent(operationId);
    console.error('\nFAIL  a duplicate dispatch was allowed; this is the failure the product exists to prevent');
    return 1;
  } catch (error) {
    if (!isDomainError(error)) throw error;
    fact('refused with', error.code);
    console.log(`    ${error.message}`);
  }

  step(5, 'Restart the process');
  await service.stop();
  service.journal.close();
  service = new OrderRescueService(config, new Journal(config.dbPath));
  const afterRestart = service.journal.getOperation(operationId)!;
  fact('state on disk', afterRestart.state);
  fact('dispatch attempts', afterRestart.submitAttemptCount);
  service.journal.resumeUnresolvedOperations();
  fact('after resume', service.journal.getOperation(operationId)!.state);
  console.log('    recovery re-queues observation; it never resubmits');

  step(6, 'Ask Binance what actually happened, by the id written in step 1');
  let settled = service.journal.getOperation(operationId)!;
  for (let attempt = 1; attempt <= 6 && ['UNKNOWN', 'RECONCILING'].includes(settled.state); attempt += 1) {
    const result = await service.reconcileOnce(operationId, attempt);
    fact(`attempt ${attempt}`, `${result.state} — ${result.detail}`);
    settled = service.journal.getOperation(operationId)!;
    if (['UNKNOWN'].includes(settled.state)) await sleep(1500);
  }

  step(7, 'Authoritative outcome');
  fact('state', settled.state);
  fact('venue order id', settled.venueOrderId ?? 'none');
  fact('executed quantity', settled.executedQuantity);
  fact('cumulative quote', settled.cumulativeQuoteQuantity);
  fact('dispatch attempts', settled.submitAttemptCount);

  step(8, 'Confirm exactly one order exists at the venue for this id');
  const direct = await service.adapter.getOrderByClientOrderId(symbol, settled.venueClientOrderId);
  if (direct.kind === 'OBSERVED') {
    fact('venue reports', `${direct.observation.status} on order ${direct.observation.venueOrderId}`);
    if (settled.venueOrderId !== null && direct.observation.venueOrderId !== settled.venueOrderId) {
      console.error('\nFAIL  the venue order id does not match the one recorded');
      return 1;
    }
  } else {
    fact('venue reports', direct.kind);
  }

  step(9, 'Export the evidence bundle');
  const bundle = service.exportEvidence(operationId)!;
  const path = `./evidence-${operationId}.json`;
  writeFileSync(path, JSON.stringify(bundle, null, 2));
  fact('events', bundle.events.length);
  fact('chain intact', bundle.chain.ok);
  fact('bundle digest', bundle.bundleDigest.slice(0, 32) + '…');
  fact('written to', path);

  await service.stop();
  service.journal.close();

  const passed = settled.submitAttemptCount === 1 && !['UNKNOWN', 'RECONCILING'].includes(settled.state) && bundle.chain.ok;
  console.log(
    passed
      ? `\nPASS  one intent, one dispatch, one venue order, settled as ${settled.state} from authoritative status.`
      : `\nINCOMPLETE  operation ended in ${settled.state} after ${settled.submitAttemptCount} dispatch(es).`,
  );
  console.log(`      intent ${intentId}`);
  return passed ? 0 : 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
