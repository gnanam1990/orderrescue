# Integration Gate — correlation evidence

**Recorded:** 7 September 2026, 11:11 UTC
**Verdict:** **PASS (Spot Testnet execution path)** / **NOT VERIFIED (Agent OS placement path)**

The PRD forbids building OrderRescue unless one exact order-correlation path is
proven. "Exact" means: an identifier chosen by the caller *before* dispatch, which
can afterwards be used to query authoritative venue state for that specific order.
Matching on symbol + side + quantity + timestamp is explicitly not acceptable and
is not used anywhere in this codebase.

## Path A — Binance Spot Testnet REST: **verified**

Correlation identifier: `newClientOrderId` on order placement, queried back via
`origClientOrderId` on order status.

- `POST /api/v3/order` accepts `newClientOrderId` (documented pattern
  `^[\.A-Z\:/a-z0-9_-]{1,36}$`) and echoes `clientOrderId` in its response.
- `GET /api/v3/order` accepts `origClientOrderId` and returns `orderId`,
  `status`, `executedQty`, `cummulativeQuoteQty` and `updateTime` for that exact order.
- `GET /api/v3/openOrders` and `GET /api/v3/myTrades` provide corroborating
  account-side observation.

This is what makes recovery honest: `deriveClientOrderId()` computes the id
deterministically from `(intentId, intentDigest)` *before* anything is sent, so a
process that crashes mid-dispatch rebuilds the identical id on restart and can ask
Binance what happened to that order.

### Live probe, run against the real testnet host

```
$ curl -s -o /dev/null -w "%{http_code}\n" https://testnet.binance.vision/api/v3/ping
200
$ curl -s https://testnet.binance.vision/api/v3/time
{"serverTime":1788779481758}
```

`GET /api/v3/exchangeInfo?symbol=BNBUSDT` returned, at the time of writing:

| Filter | Value used by the demo |
|---|---|
| `NOTIONAL.minNotional` | `5.00000000` (`applyMinToMarket: true`) |
| `LOT_SIZE.stepSize` | `0.00100000` |
| `PRICE_FILTER.tickSize` | `0.01000000` |
| `status` | `TRADING` |

These are read live by the capability probe rather than hard-coded, so a stale
constant cannot silently invalidate an order.

## Path B — Binance Agent OS / MCP placement: **not verified in this session**

Not verified, and therefore not claimed. Inspecting the authenticated Agent OS
tool catalogue requires user-approved Agent OS credentials, which are not
configured on this machine. No Agent OS tool name, input schema, scope, or
response shape has been invented to fill the gap, and no code path in this
repository pretends to call one.

The adapter interface (`packages/adapter-binance/src/adapter.ts`) is the seam
where an Agent OS execution adapter would be added once its schema is captured.
Until that inspection happens, the honest statement is: *OrderRescue executes
against Binance Spot Testnet; whether the same correlation key survives an
Agent OS placement call is untested.*

## What happens either side of the failure boundary

1. The intent, its digest, and the derived `clientOrderId` commit to SQLite.
2. The operation moves to `SUBMITTING` and commits. **Only now** is anything sent.
3. The HTTP request reaches Binance and Binance does or does not accept it.
4. The fault injector may discard the response **after step 3**. It never
   fabricates a venue result, and it cannot prevent the order from existing.
5. The client sees an ambiguous outcome; the operation moves to `UNKNOWN`.
6. Reconciliation asks Binance about `origClientOrderId` from step 1.

The identifier in step 6 is the one written in step 1, which is what makes the
answer authoritative rather than a guess.

## Open risks

- Agent OS placement correlation is unproven (above).
- Event eligibility rules for a split Agent OS/testnet integration have not been
  confirmed with the organisers.
- `NOT_FOUND_SAFE` depends on Binance's documented behaviour that a queried
  `origClientOrderId` returns `-2013 Order does not exist` for an order that was
  never accepted. This code still requires an exhausted multi-query window before
  it will call an order absent, because a single not-found is not proof.
