import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DomainError,
  allowedActions,
  createIntentRequestSchema,
  isDomainError,
  retryBlockReason,
  type OperationState,
} from '@orderrescue/domain';
import type { Config } from './config.js';
import type { OrderRescueService } from './service.js';

const here = dirname(fileURLToPath(import.meta.url));

const ERROR_STATUS: Record<string, number> = {
  IDEMPOTENCY_CONFLICT: 409,
  ILLEGAL_TRANSITION: 409,
  TERMINAL_STATE: 409,
  RETRY_BLOCKED: 409,
  NOT_CONFIRMED: 409,
  CONTRADICTORY_OBSERVATION: 409,
  INTENT_EXPIRED: 410,
  NOTIONAL_CAP_EXCEEDED: 422,
  VALIDATION_FAILED: 400,
};

export function buildApi(config: Config, service: OrderRescueService): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.setErrorHandler((error, _request, reply) => {
    if (isDomainError(error)) {
      return reply.status(ERROR_STATUS[error.code] ?? 400).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    const message = error instanceof Error ? error.message : 'unexpected error';
    return reply.status(500).send({ error: { code: 'INTERNAL', message } });
  });

  /**
   * Mutations require the session secret. The server binds to localhost by
   * default, but "only reachable from this machine" is not the same as "only
   * usable by the operator" — any page in the browser can reach localhost.
   */
  const requireSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const provided = request.headers['x-orderrescue-session'];
    if (typeof provided !== 'string' || !constantTimeEqual(provided, config.sessionSecret)) {
      await reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid session secret' } });
    }
  };

  app.addHook('onRequest', async (request, reply) => {
    // Reject cross-origin browser callers outright rather than relying on CORS
    // headers, which only ask the browser nicely.
    const origin = request.headers.origin;
    if (typeof origin === 'string') {
      const allowed = [`http://${config.host}:${config.port}`, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];
      if (!allowed.includes(origin)) {
        await reply.status(403).send({ error: { code: 'FORBIDDEN_ORIGIN', message: 'cross-origin request refused' } });
      }
    }
  });

  app.get('/health', async () => ({ status: 'ok', environment: config.environment }));

  app.get('/ready', async (_request, reply) => {
    const chain = service.journal.verifyChain();
    const capabilities = await service.adapter.capabilities();
    const ready = chain.ok && capabilities.reachable;
    return reply.status(ready ? 200 : 503).send({
      process: 'ok',
      journal: chain.ok ? 'ok' : `chain broken at sequence ${chain.brokenAt}`,
      venue: {
        environment: capabilities.environment,
        reachable: capabilities.reachable,
        authenticated: capabilities.authenticated,
        serverTimeSkewMs: capabilities.serverTimeSkewMs,
        correlation: capabilities.supportsClientOrderIdCorrelation ? 'clientOrderId' : 'none',
        problems: capabilities.problems,
      },
      faultLabEnabled: config.faultLabEnabled,
      executionAvailable: config.binance.credentialsPresent,
    });
  });

  app.post('/v1/intents', { onRequest: requireSession }, async (request, reply) => {
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new DomainError('VALIDATION_FAILED', 'the Idempotency-Key header is required');
    }
    const parsed = createIntentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', 'invalid intent', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const result = await service.createIntent(parsed.data, idempotencyKey.trim());
    return reply.status(result.created ? 201 : 200).send({
      intent: result.intent,
      operation: result.operation,
      reused: !result.created,
    });
  });

  app.post<{ Params: { id: string }; Body: { confirmationRef?: string } }>(
    '/v1/intents/:id/confirm',
    { onRequest: requireSession },
    async (request) => {
      const operation = requireOperationByIntent(service, request.params.id);
      const confirmationRef = (request.body?.confirmationRef ?? '').trim();
      if (confirmationRef === '') {
        throw new DomainError('VALIDATION_FAILED', 'confirmationRef is required');
      }
      const result = service.confirmIntent(operation.operationId, confirmationRef);
      return { operation: result.operation };
    },
  );

  app.post<{ Params: { id: string } }>('/v1/intents/:id/execute', { onRequest: requireSession }, async (request) => {
    const operation = requireOperationByIntent(service, request.params.id);
    return service.executeIntent(operation.operationId);
  });

  app.post<{ Params: { id: string } }>('/v1/operations/:id/reconcile', { onRequest: requireSession }, async (request) => {
    const job = service.journal.getReconciliationJob(request.params.id);
    const attempts = (job?.attempts ?? 0) + 1;
    const result = await service.reconcileOnce(request.params.id, attempts);
    service.journal.releaseReconciliation(
      request.params.id,
      ['UNKNOWN', 'RECONCILING'].includes(result.state) ? 'PENDING' : 'SETTLED',
      { nextAttemptAt: new Date(Date.now() + service.backoffMs(attempts)) },
    );
    return result;
  });

  app.get('/v1/operations', async () => ({
    operations: service.journal.listOperations().map((operation) => decorate(operation)),
  }));

  app.get<{ Params: { id: string } }>('/v1/operations/:id', async (request, reply) => {
    const operation = service.journal.getOperation(request.params.id);
    if (operation === null) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'unknown operation' } });
    const intent = service.journal.getIntent(operation.intentId);
    const job = service.journal.getReconciliationJob(operation.operationId);
    return {
      operation: decorate(operation),
      intent,
      evidence: service.journal.getEvidence(operation.operationId),
      reconciliation: job,
    };
  });

  app.get<{ Params: { id: string } }>('/v1/operations/:id/evidence', async (request, reply) => {
    const bundle = service.exportEvidence(request.params.id);
    if (bundle === null) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'unknown operation' } });
    return reply
      .header('content-disposition', `attachment; filename="orderrescue-${request.params.id}.json"`)
      .send(bundle);
  });

  // Fault lab. Testnet-only and flag-gated; the routes do not exist otherwise.
  if (config.faultLabEnabled) {
    app.post('/v1/faults/drop-ack', { onRequest: requireSession }, async () => {
      service.fault.dropNextAck = true;
      service.fault.armedAt = new Date().toISOString();
      return {
        armed: true,
        scope: 'next submission only',
        note: 'the request will still reach Binance; only our knowledge of the response is discarded',
      };
    });

    app.delete('/v1/faults/drop-ack', { onRequest: requireSession }, async () => {
      service.fault.dropNextAck = false;
      service.fault.armedAt = null;
      return { armed: false };
    });
  }

  app.get('/v1/faults', async () => ({
    enabled: config.faultLabEnabled,
    dropNextAck: service.fault.dropNextAck,
    armedAt: service.fault.armedAt,
  }));

  const consoleDir = resolveConsoleDir();
  if (consoleDir !== null) {
    app.register(fastifyStatic, { root: consoleDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/v1/')) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'unknown route' } });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

function decorate(operation: { state: OperationState } & Record<string, unknown>) {
  return {
    ...operation,
    allowedActions: allowedActions(operation.state),
    retryBlockedReason: retryBlockReason(operation.state),
  };
}

function requireOperationByIntent(service: OrderRescueService, intentId: string) {
  const operation = service.journal.listOperations(1000).find((o) => o.intentId === intentId);
  if (operation === undefined) throw new DomainError('VALIDATION_FAILED', `unknown intent ${intentId}`);
  return operation;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function resolveConsoleDir(): string | null {
  for (const candidate of [
    join(here, '..', '..', 'console', 'dist'),
    join(here, '..', '..', '..', 'console', 'dist'),
  ]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}
