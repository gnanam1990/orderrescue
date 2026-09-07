/**
 * Recomputes the evidence hash chain over the whole journal.
 *
 * Refuses to run against a database that does not exist. An integrity checker
 * that creates an empty journal and reports it intact is worse than no checker
 * at all, because the operator walks away reassured.
 */
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { Journal } from '@orderrescue/journal';

const config = loadConfig();

console.log(`journal  ${config.dbPath}`);

if (!existsSync(config.dbPath)) {
  console.error(`\nFAIL  no journal at that path; there is nothing to verify.`);
  console.error(`      Set ORDERRESCUE_DB_PATH, or run this from the directory holding ./data.`);
  process.exit(2);
}

const journal = new Journal(config.dbPath);
const result = journal.verifyChain();
journal.close();

if (result.checked === 0) {
  console.log('\nEMPTY  the journal exists but holds no evidence events yet.');
  process.exit(0);
}

if (result.ok) {
  console.log(`\nPASS  ${result.checked} evidence events verified; the chain is intact`);
  process.exit(0);
}

console.error(`\nFAIL  chain broken at sequence ${result.brokenAt}: ${result.reason}`);
console.error(`      ${result.checked} events verified before the break`);
process.exit(1);
