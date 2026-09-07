# OrderRescue

**When an AI agent's trade request loses its response, OrderRescue proves whether the order executed before allowing any retry.**

Built for the Binance Agent OS Mini Hackathon. It is not a signal bot, a strategy, or a portfolio chatbot. It is a narrow reliability layer for the dangerous interval between *"the agent sent the trade"* and *"anyone knows what actually happened."*

---

## The problem is documented by Binance itself

The Spot API reference states that a matching-engine request can return `-1007 TIMEOUT`, that the send status is then **unknown**, and that a timeout **does not always mean the operation failed**. It says an HTTP `5XX` must not be treated as a failed operation, because it may have succeeded.

An agent that treats any of those as "it didn't go through" and retries can buy twice.

OrderRescue exists to make that specific mistake structurally impossible within its own execution path.

## What it actually does

1. Gives every trade intent a durable identity and a client order id **derived before dispatch**.
2. Commits that identity to disk **before** anything reaches the network.
3. Sends exactly once.
4. Treats an ambiguous answer as `UNKNOWN` — never as failure.
5. Refuses any further economic action for that intent while the outcome is unknown.
6. Asks Binance about that exact order id, and settles the state from the authoritative answer.
7. Exports a tamper-evident evidence bundle of the whole sequence.

### What it will not do

- Infer that an order did not execute from a timeout, a `5xx`, or a lost connection.
- Match an order by symbol, side, quantity, and timestamp. Correlation is by exact client order id or it does not happen.
- Retry because a model judged it probably safe.
- Show stale account state as live.
- Claim globally exactly-once execution. The honest claim is **one economic action per intent within OrderRescue's own execution path**; another client holding separate credentials is outside that boundary.
- Trade real money. `MAINNET` is refused at startup, and so is a mainnet base URL.

## Quick start

```bash
git clone https://github.com/gnanam1990/orderrescue.git
cd orderrescue
pnpm install
cp .env.example .env
```

Get a testnet key pair from [testnet.binance.vision](https://testnet.binance.vision) (GitHub sign-in → *Generate HMAC_SHA256 Key*), put it in `.env`, then check the venue before touching anything else:

```bash
pnpm probe
```

```
environment       TESTNET
venue             https://testnet.binance.vision
reachable         yes
authenticated     yes
clock skew        -33ms
correlation       clientOrderId (exact)
symbol            BNBUSDT TRADING
  minNotional     5.00000000
  stepSize        0.00100000

PASS  reachable, authenticated, and correlated by an exact client order id
```

The probe exits non-zero when anything required is missing, so it works as a preflight gate. Without credentials it reports `PARTIAL` and the server starts read-only: it will refuse to execute rather than pretend an order was placed.

### Run it

```bash
pnpm build
pnpm dev
```

The console is on <http://127.0.0.1:4319>. Mutations need the session secret, which the server writes to `.orderrescue-session` (mode 0600) — paste it into the field in the header.

### The demo, in one command

```bash
pnpm demo
```

This places **one real testnet order**, destroys the response after Binance has already received it, proves the retry is blocked, restarts the journal from disk, then asks Binance what happened and settles from the answer. It writes an evidence bundle and exits non-zero if any invariant fails.

## The failure path, step by step

| Step | What happens | State |
|---|---|---|
| 1 | Intent, digest, and derived client order id commit to SQLite | `AWAITING_CONFIRMATION` |
| 2 | Confirmation recorded | `APPROVED` |
| 3 | `SUBMITTING` commits to disk — **then** the request is sent | `SUBMITTING` |
| 4 | Binance receives the order. The acknowledgement is discarded | `UNKNOWN` |
| 5 | The agent retries. **Refused**, with the reason | `UNKNOWN` |
| 6 | The process is killed and restarted | `UNKNOWN` (survives) |
| 7 | `GET /api/v3/order?origClientOrderId=…` — the id from step 1 | `RECONCILING` |
| 8 | Binance answers `FILLED`; account delta recorded | `FILLED` |
| 9 | The retry stays blocked, now because it already executed | `FILLED` |

The identifier used in step 7 is the one written in step 1. That is the entire trick, and it is why the answer is authoritative rather than a guess.

## Design decisions worth knowing

**Ambiguity is a state, not an error code.** Submission has exactly three outcomes: the venue told us what it did, the venue told us it did nothing *and identified itself while saying so*, or we do not know. Only a parsed `{code, msg}` envelope earns a rejection — an HTML error page from a proxy is not the exchange speaking, so a `4xx` without that envelope stays ambiguous.

**Absence is the hardest claim to make.** `NOT_FOUND_SAFE` needs a positive `-2013 Order does not exist` on the exact client order id, a minimum number of queries, *and* an elapsed window. A single not-found is not proof. An unreachable venue returns the operation to `UNKNOWN` and never to absence.

**A partial fill is exposure, not absence.** It blocks a retry just as a full fill does.

**Contradictions escalate rather than resolve.** If a fill appears to shrink, or an observation carries a different venue order id, or a settled outcome is contradicted by a late response, the operation goes to `MANUAL_REVIEW`. The system never picks the convenient answer.

**Duplicate suppression is structural.** `operations.intent_id` is `UNIQUE`, so one economic decision cannot own two dispatchable records. Every transition runs inside `BEGIN IMMEDIATE`, so two competing execute requests serialize before either decides to dispatch — and a second connection reaches the same conclusion, because the guarantee is on disk rather than in memory.

**Recovery observes, it never resubmits.** An operation left in `SUBMITTING` by a dead process becomes `UNKNOWN`, not `APPROVED`. Finding out what the venue already holds comes first.

**Redaction happens on the way in.** Credentials are stripped before evidence is written, so nothing secret is ever at rest and an export bug cannot leak what was never stored. The export is a field allow-list, and withholds the caller-chosen idempotency key.

**Evidence is a hash chain** over the whole journal. An edited fact, a deleted row, or a reordered event is detectable: `pnpm verify-chain`.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the diagrams.

```
packages/domain            pure state machine, intent identity, exact decimals — no I/O
packages/journal           SQLite WAL journal, hash chain, locking, restart recovery
packages/adapter-binance   signed REST client and the outcome classification table
apps/server                execution path, reconciler, API, CLIs
apps/console               operations console
```

`packages/domain` has no knowledge of HTTP or SQLite, and no route or adapter may mutate operation state directly — every transition goes through `decide()`.

## Tests

```bash
pnpm test
```

97 tests. The ones that matter:

- a lost response becomes `UNKNOWN`, never `FAILED`
- no second dispatch from any state that may carry economic effect
- a duplicate dispatch is refused through a *separate database connection*
- a crash mid-dispatch reopens as `UNKNOWN` with the attempt count unchanged
- absence needs an exhausted window; an unreachable venue never becomes absence
- terminal states cannot be rewritten by a late or contradictory response
- an edited fact and a deleted event are both detected by the chain
- credentials never reach storage or an export
- the whole demo path, with only the network stubbed — real classification, real state machine, real SQLite

## Honest limitations

- **Agent OS placement is not integrated.** Inspecting the authenticated Agent OS tool catalogue needs user-approved credentials that were not available. Rather than invent a tool name or schema, execution goes through Binance Spot Testnet, where the correlation path is documented and verified. `packages/adapter-binance/src/adapter.ts` is the seam where an Agent OS adapter belongs. See [docs/integration-gate.md](docs/integration-gate.md).
- **Event eligibility for a split Agent OS/testnet integration has not been confirmed** with the organisers.
- Spot only. No margin, futures, convert, or cross-product routing.
- No WebSocket user data stream yet; reconciliation is by REST query.
- Single node. The locking is correct for concurrent connections to one SQLite file, not for a distributed deployment.
- **Commercial demand is unproven.** The technical failure class is documented by Binance; that is not the same as evidence anyone will pay for a managed version.

## Licence

MIT. See [LICENSE](LICENSE).
