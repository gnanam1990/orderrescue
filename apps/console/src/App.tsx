import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  readSessionSecret,
  writeSessionSecret,
  type EvidenceEvent,
  type Operation,
  type OperationDetail,
  type Readiness,
} from './api';
import { describeEconomics, freshness, present } from './state';

export default function App() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [operations, setOperations] = useState<Operation[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const [faults, setFaults] = useState<{ enabled: boolean; dropNextAck: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState(readSessionSecret);

  // One contextual live region for the whole console. Individual badges do not
  // announce themselves; a screen-reader user gets one clear sentence when
  // something meaningful changes, and focus is never moved out from under them.
  const announce = useCallback((message: string) => setStatus(message), []);

  const refresh = useCallback(async () => {
    try {
      const [ready, list, faultState] = await Promise.all([api.readiness().catch(() => null), api.listOperations(), api.faults()]);
      if (ready !== null) setReadiness(ready);
      setOperations(list.operations);
      setFaults(faultState);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api.operation(selectedId);
        if (!cancelled) setDetail(next);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : String(cause));
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedId]);

  const run = useCallback(
    async (label: string, action: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      try {
        const message = await action();
        announce(message);
        await refresh();
      } catch (cause) {
        const message = cause instanceof ApiError ? cause.message : String(cause);
        setError(`${label}: ${message}`);
        announce(`${label} refused. ${message}`);
      } finally {
        setBusy(false);
      }
    },
    [announce, refresh],
  );

  return (
    <div className="app">
      <ConnectionGate
        readiness={readiness}
        secret={secret}
        onSecretChange={(value) => {
          setSecret(value);
          writeSessionSecret(value);
        }}
      />

      <p aria-live="polite" role="status" className="sr-only">
        {status}
      </p>

      <div className="columns">
        <IntentQueue operations={operations} selectedId={selectedId} onSelect={setSelectedId} />
        <main className="detail">
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {detail === null ? (
            <NewIntentPanel
              readiness={readiness}
              faults={faults}
              busy={busy}
              onRun={run}
              onCreated={(operationId) => setSelectedId(operationId)}
            />
          ) : (
            <OperationDetailView detail={detail} busy={busy} onRun={run} onBack={() => setSelectedId(null)} />
          )}
        </main>
      </div>
    </div>
  );
}

function ConnectionGate({
  readiness,
  secret,
  onSecretChange,
}: {
  readiness: Readiness | null;
  secret: string;
  onSecretChange: (value: string) => void;
}) {
  const venue = readiness?.venue;
  return (
    <header className="gate">
      <h1>OrderRescue</h1>
      <span className="pill" data-tone={venue?.reachable ? 'active' : 'danger'} data-glyph={venue?.reachable ? '=' : '!'}>
        {venue?.environment ?? 'UNKNOWN'} {venue?.reachable ? 'connected' : 'disconnected'}
      </span>
      <dl className="gate-facts">
        <div className="fact">
          <dt>Correlation</dt>
          <dd>{venue?.correlation ?? '—'}</dd>
        </div>
        <div className="fact">
          <dt>Execution</dt>
          <dd>{readiness === null ? '—' : readiness.executionAvailable ? 'enabled' : 'no credentials'}</dd>
        </div>
        <div className="fact">
          <dt>Journal</dt>
          <dd>{readiness?.journal ?? '—'}</dd>
        </div>
        <div className="fact">
          <dt>Clock skew</dt>
          <dd>{venue?.serverTimeSkewMs === null || venue === undefined ? '—' : `${venue.serverTimeSkewMs}ms`}</dd>
        </div>
        <div className="fact">
          <dt>
            <label htmlFor="session-secret">Session secret</label>
          </dt>
          <dd>
            <input
              id="session-secret"
              type="password"
              value={secret}
              placeholder="paste from server log"
              onChange={(event) => onSecretChange(event.target.value)}
              style={{ width: 180, minHeight: 28, padding: '0 8px', background: 'var(--bg)', border: '1px solid var(--line-strong)', borderRadius: 4 }}
            />
          </dd>
        </div>
      </dl>
    </header>
  );
}

function IntentQueue({
  operations,
  selectedId,
  onSelect,
}: {
  operations: Operation[] | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const needsAttention = useMemo(
    () => (operations ?? []).filter((o) => ['UNKNOWN', 'MANUAL_REVIEW', 'PARTIALLY_FILLED'].includes(o.state)).length,
    [operations],
  );

  return (
    <nav className="queue" aria-label="Intent queue">
      <div className="queue-head">
        <h2>Intents</h2>
        {needsAttention > 0 && (
          <span className="pill" data-tone="unknown" data-glyph="?">
            {needsAttention} need attention
          </span>
        )}
      </div>

      {operations === null && <p className="empty">Loading…</p>}
      {operations !== null && operations.length === 0 && (
        <p className="empty">
          No intents yet. Create one to see the recovery path.
        </p>
      )}
      {(operations ?? []).map((operation) => {
        const view = present(operation.state);
        const age = freshness(operation.lastObservedAt);
        return (
          <button
            key={operation.operationId}
            type="button"
            className="queue-item"
            aria-current={operation.operationId === selectedId}
            onClick={() => onSelect(operation.operationId)}
          >
            <span className="queue-row">
              <span className="pill" data-tone={view.tone} data-glyph={view.glyph}>
                {view.label}
              </span>
              <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                {operation.venueOrderId ?? '—'}
              </span>
            </span>
            <span className="queue-sub">
              {operation.venueClientOrderId}
              <br />
              <span className={age.stale ? 'stale' : undefined}>observed {age.text}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function NewIntentPanel({
  readiness,
  faults,
  busy,
  onRun,
  onCreated,
}: {
  readiness: Readiness | null;
  faults: { enabled: boolean; dropNextAck: boolean } | null;
  busy: boolean;
  onRun: (label: string, action: () => Promise<string>) => Promise<void>;
  onCreated: (operationId: string) => void;
}) {
  const [symbol, setSymbol] = useState('BNBUSDT');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [quoteQuantity, setQuoteQuantity] = useState('20');
  const [maxNotional, setMaxNotional] = useState('25');

  const executionAvailable = readiness?.executionAvailable === true;

  return (
    <>
      <section className="panel">
        <header>
          <h2>New trade intent</h2>
        </header>
        <div className="panel-body">
          {!executionAvailable && (
            <div className="blocked" data-tone="danger">
              <span className="glyph" aria-hidden="true">!</span>
              <div>
                <strong>Execution is unavailable</strong>
                <p>
                  No Binance testnet credentials are configured, so OrderRescue will refuse to execute rather than
                  pretend an order was placed. Set BINANCE_API_KEY and BINANCE_API_SECRET and restart.
                </p>
              </div>
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onRun('Create intent', async () => {
                const result = await api.createIntent(
                  {
                    accountRef: 'agentic-sub-1',
                    symbol,
                    side,
                    orderType: 'MARKET',
                    quoteQuantity,
                    maxNotional,
                    createdBy: 'operations-console',
                    expiresInSeconds: 3600,
                  },
                  crypto.randomUUID(),
                );
                onCreated(result.operation.operationId);
                return `Intent created. Client order id ${result.operation.venueClientOrderId} is committed before anything is sent.`;
              });
            }}
          >
            <div className="field-row">
              <div className="field">
                <label htmlFor="symbol">Symbol</label>
                <input id="symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} required />
              </div>
              <div className="field">
                <label htmlFor="side">Side</label>
                <select id="side" value={side} onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')}>
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                </select>
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="quote">Quote quantity</label>
                <input id="quote" value={quoteQuantity} onChange={(e) => setQuoteQuantity(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="cap">Max notional</label>
                <input id="cap" value={maxNotional} onChange={(e) => setMaxNotional(e.target.value)} required />
              </div>
            </div>
            <button className="btn" data-variant="primary" type="submit" disabled={busy}>
              Create intent
            </button>
            <p className="note">
              A market order is checked against live exchange filters and the notional cap before it is written. Nothing
              is sent until the intent is confirmed and executed.
            </p>
          </form>
        </div>
      </section>

      {faults?.enabled === true && (
        <section className="panel">
          <header>
            <h2>Fault lab · testnet only</h2>
            <span className="pill" data-tone={faults.dropNextAck ? 'unknown' : 'neutral'} data-glyph={faults.dropNextAck ? '?' : '·'}>
              {faults.dropNextAck ? 'armed' : 'disarmed'}
            </span>
          </header>
          <div className="panel-body">
            <p className="note" style={{ marginTop: 0 }}>
              Drop the acknowledgement of the next submission <em>after</em> the request reaches Binance. The order is
              real; only our knowledge of the answer is destroyed. Nothing here fabricates a venue result.
            </p>
            <div className="actions">
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() =>
                  void onRun(faults.dropNextAck ? 'Disarm fault' : 'Arm fault', async () => {
                    if (faults.dropNextAck) {
                      await api.disarmDropAck();
                      return 'Fault disarmed.';
                    }
                    await api.armDropAck();
                    return 'Fault armed. The next submission will lose its acknowledgement after dispatch.';
                  })
                }
              >
                {faults.dropNextAck ? 'Disarm drop-ack' : 'Arm drop-ack'}
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

function OperationDetailView({
  detail,
  busy,
  onRun,
  onBack,
}: {
  detail: OperationDetail;
  busy: boolean;
  onRun: (label: string, action: () => Promise<string>) => Promise<void>;
  onBack: () => void;
}) {
  const { operation, intent, evidence, reconciliation } = detail;
  const view = present(operation.state);
  const age = freshness(operation.lastObservedAt);
  const previousState = useRef(operation.state);

  useEffect(() => {
    previousState.current = operation.state;
  }, [operation.state]);

  const canConfirm = operation.allowedActions.includes('CONFIRM');
  const canExecute = operation.allowedActions.includes('EXECUTE');
  const canReconcile = operation.allowedActions.includes('RECONCILE');

  return (
    <>
      <div className="headline">
        <button className="btn" type="button" onClick={onBack} style={{ minHeight: 32 }}>
          ← Queue
        </button>
        <span className="pill" data-tone={view.tone} data-glyph={view.glyph}>
          {view.label}
        </span>
        {intent !== null && <span className="economics">{describeEconomics(intent)}</span>}
      </div>

      {operation.retryBlockedReason !== null && (
        <div className="blocked" data-tone={view.tone === 'settled' ? 'settled' : view.tone === 'danger' ? 'danger' : 'unknown'} role="note">
          <span className="glyph" aria-hidden="true">{view.glyph}</span>
          <div>
            <strong>Retry is blocked</strong>
            <p>{operation.retryBlockedReason}</p>
          </div>
        </div>
      )}

      <section className="panel">
        <header>
          <h2>Recovery console</h2>
          <span className={age.stale ? 'mono stale' : 'mono'} style={{ fontSize: 12 }}>
            observed {age.text}
          </span>
        </header>
        <div className="panel-body">
          <div className="actions">
            <button
              className="btn"
              type="button"
              disabled={busy || !canConfirm}
              onClick={() =>
                void onRun('Confirm', async () => {
                  await api.confirm(operation.intentId, `console-${Date.now()}`);
                  return 'Intent confirmed and approved for a single dispatch.';
                })
              }
            >
              Confirm intent
            </button>

            <button
              className="btn"
              data-variant="primary"
              type="button"
              disabled={busy || !canExecute}
              title={operation.retryBlockedReason ?? undefined}
              onClick={() =>
                void onRun('Execute', async () => {
                  const result = await api.execute(operation.intentId);
                  return `Submission finished in state ${result.state}. ${result.detail}`;
                })
              }
            >
              Execute once
            </button>

            <button
              className="btn"
              data-variant={canReconcile ? 'primary' : undefined}
              type="button"
              disabled={busy || !canReconcile}
              onClick={() =>
                void onRun('Reconcile', async () => {
                  const result = await api.reconcile(operation.operationId);
                  return `Reconciled to ${result.state}. ${result.detail}`;
                })
              }
            >
              Reconcile against venue
            </button>

            <a className="btn" href={api.evidenceUrl(operation.operationId)} download>
              Export evidence
            </a>
          </div>

          {reconciliation !== null && (
            <p className="note">
              Reconciliation {reconciliation.status.toLowerCase()} after {reconciliation.attempts} attempt
              {reconciliation.attempts === 1 ? '' : 's'}
              {reconciliation.lastError !== null ? ` · last error: ${reconciliation.lastError}` : ''}
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>Identity and outcome</h2>
        </header>
        <div className="panel-body">
          <dl className="kv">
            <dt>Client order id</dt>
            <dd>{operation.venueClientOrderId}</dd>
            <dt>Venue order id</dt>
            <dd>{operation.venueOrderId ?? 'not yet bound'}</dd>
            <dt>Intent digest</dt>
            <dd>{intent?.intentDigest ?? '—'}</dd>
            <dt>Executed quantity</dt>
            <dd>{operation.executedQuantity}</dd>
            <dt>Cumulative quote</dt>
            <dd>{operation.cumulativeQuoteQuantity}</dd>
            <dt>Dispatch attempts</dt>
            <dd>{operation.submitAttemptCount}</dd>
            <dt>Terminal reason</dt>
            <dd>{operation.terminalReason ?? '—'}</dd>
          </dl>
        </div>
      </section>

      <section className="panel">
        <header>
          <h2>Evidence · {evidence.length} events</h2>
        </header>
        <ul className="timeline">
          {evidence.map((event) => (
            <EvidenceRow key={event.sequence} event={event} />
          ))}
        </ul>
      </section>
    </>
  );
}

function EvidenceRow({ event }: { event: EvidenceEvent }) {
  return (
    <li>
      <details>
        <summary className="event-summary">
          <span className="event-seq">{event.sequence}</span>
          <span className="event-type">{event.eventType.replaceAll('_', ' ').toLowerCase()}</span>
          <span className="event-source">{event.source}</span>
        </summary>
        <div className="event-body">
          <pre>{JSON.stringify(event.facts, null, 2)}</pre>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Observed at</dt>
            <dd>{event.observedAt}</dd>
            <dt>Venue timestamp</dt>
            <dd>{event.sourceTimestamp ?? '—'}</dd>
            <dt>Event hash</dt>
            <dd>{event.eventHash.slice(0, 32)}…</dd>
          </dl>
        </div>
      </details>
    </li>
  );
}
