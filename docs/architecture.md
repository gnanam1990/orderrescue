# Architecture

## The shape of the problem

Everything here follows from one asymmetry: **the transport outcome and the economic outcome are different facts, and only one of them is observable locally.**

```mermaid
flowchart LR
    A[Agent] -->|1 intent| OR[OrderRescue]
    OR -->|2 commit| DB[(SQLite journal)]
    OR -->|3 send once| B[Binance]
    B -.->|4 response may be lost| OR
    OR -->|5 query by exact id| B
    B -->|6 authoritative status| OR

    style B fill:#16233b,stroke:#7cb2ff,color:#e8eefb
    style DB fill:#16233b,stroke:#35496b,color:#e8eefb
    style OR fill:#111b2e,stroke:#f0b429,color:#e8eefb
```

Step 4 is the one everybody gets wrong. A lost response says nothing about whether step 3 had an effect. Step 5 is only possible because the identifier was chosen and committed at step 2.

## Layers

```mermaid
flowchart TD
    subgraph console["apps/console"]
        UI[Operations console]
    end

    subgraph server["apps/server"]
        API[HTTP API]
        SVC[Execution service]
        REC[Reconciliation worker]
        CLI[probe / demo / verify-chain]
    end

    subgraph journal["packages/journal"]
        REPO[Repositories + locking]
        CHAIN[Evidence hash chain]
        QUEUE[Reconciliation queue]
    end

    subgraph domain["packages/domain"]
        MACHINE[State machine]
        IDENT[Intent identity + digest]
        DEC[Exact decimals]
    end

    subgraph adapter["packages/adapter-binance"]
        SIGN[Signed REST client]
        CLASS[Outcome classification]
    end

    UI --> API
    CLI --> SVC
    API --> SVC
    SVC --> REPO
    SVC --> CLASS
    REC --> REPO
    REC --> CLASS
    REPO --> MACHINE
    REPO --> CHAIN
    REPO --> QUEUE
    CLASS --> SIGN
    MACHINE --> DEC
    MACHINE --> IDENT
```

`packages/domain` is pure: no HTTP, no SQLite, no clock. Every state change in the system passes through its `decide()` function, so an invariant proved there holds for the API, the worker, the CLI, and the recovery path alike.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> AWAITING_CONFIRMATION
    AWAITING_CONFIRMATION --> APPROVED: confirmed
    APPROVED --> SUBMITTING: begin submission<br/>(commits before dispatch)

    SUBMITTING --> ACKNOWLEDGED: venue answered
    SUBMITTING --> PARTIALLY_FILLED: venue answered
    SUBMITTING --> FILLED: venue answered
    SUBMITTING --> REJECTED: venue identified itself<br/>while refusing
    SUBMITTING --> UNKNOWN: timeout / 5xx / 409 / 429<br/>/ -1007 / lost socket<br/>/ process death

    UNKNOWN --> RECONCILING: query exact client order id
    RECONCILING --> ACKNOWLEDGED
    RECONCILING --> PARTIALLY_FILLED
    RECONCILING --> FILLED
    RECONCILING --> CANCELLED
    RECONCILING --> UNKNOWN: venue unreachable<br/>or window not exhausted
    RECONCILING --> NOT_FOUND_SAFE: -2013 after an<br/>exhausted window
    RECONCILING --> MANUAL_REVIEW: sources disagree

    ACKNOWLEDGED --> RECONCILING
    ACKNOWLEDGED --> CANCEL_REQUESTED
    PARTIALLY_FILLED --> RECONCILING
    CANCEL_REQUESTED --> CANCELLED
    CANCEL_REQUESTED --> UNKNOWN

    FILLED --> [*]
    CANCELLED --> [*]
    REJECTED --> [*]
    NOT_FOUND_SAFE --> [*]
```

The shaded region of that diagram — `SUBMITTING`, `UNKNOWN`, `RECONCILING`, `ACKNOWLEDGED`, `PARTIALLY_FILLED`, `FILLED`, `CANCEL_REQUESTED`, `MANUAL_REVIEW` — is the set of states where the venue may already hold an economic action. No new dispatch is authorized from any of them, and each has a specific sentence explaining why.

## Ordering guarantees on the critical path

```mermaid
sequenceDiagram
    participant A as Agent
    participant S as Execution service
    participant J as SQLite journal
    participant B as Binance

    A->>S: execute intent
    S->>J: BEGIN IMMEDIATE
    J->>J: decide(APPROVED, BEGIN_SUBMISSION)
    J->>J: write SUBMITTING + evidence
    J-->>S: COMMIT — authorizes dispatch
    Note over J: durable before anything is sent

    S->>B: POST /api/v3/order (newClientOrderId)
    B->>B: order accepted
    B--xS: response lost

    S->>J: write UNKNOWN + evidence
    A->>S: retry
    S--xA: RETRY_BLOCKED, with the reason

    Note over S,B: later, possibly after a restart
    S->>B: GET /api/v3/order (origClientOrderId)
    B-->>S: FILLED, executedQty, orderId
    S->>J: write FILLED + evidence
```

Two properties come out of that ordering:

1. **Nothing is sent that is not already on disk.** A process killed between the commit and the response reopens knowing an order might exist.
2. **Nothing is sent twice.** The commit that authorizes dispatch also moves the operation out of `APPROVED`, and the transaction is `BEGIN IMMEDIATE`, so a concurrent request serializes behind it and then finds a state that refuses.

## Evidence chain

Each event is hashed over `(sequence, operationId, eventType, source, timestamps, payloadDigest, facts, previousEventHash)`, chained across the whole journal rather than per operation. That makes a deleted row visible as a sequence gap and a reordered one visible as a broken link.

Facts are redacted before hashing, so the digest covers exactly what is stored and exactly what is exported. `pnpm verify-chain` recomputes the chain and names the sequence number of the first break.

## Where an Agent OS adapter goes

`packages/adapter-binance/src/adapter.ts` defines `ExecutionAdapter`. An Agent OS implementation slots in beside `BinanceSpotAdapter` without touching the domain, the journal, or the console — provided it can carry a caller-chosen identifier through placement and back out through status. Whether it can is the open question recorded in [integration-gate.md](./integration-gate.md).
