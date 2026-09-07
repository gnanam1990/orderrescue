/** Recomputes the evidence hash chain over the whole journal. */
import { loadConfig } from '../config.js';
import { Journal } from '@orderrescue/journal';

const config = loadConfig();
const journal = new Journal(config.dbPath);
const result = journal.verifyChain();
journal.close();

if (result.ok) {
  console.log(`PASS  ${result.checked} evidence events verified; the chain is intact`);
  process.exit(0);
}

console.error(`FAIL  chain broken at sequence ${result.brokenAt}: ${result.reason}`);
console.error(`      ${result.checked} events verified before the break`);
process.exit(1);
