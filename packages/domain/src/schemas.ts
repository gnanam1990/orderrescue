import { z } from 'zod';
import { OPERATION_STATES } from './states.js';

export const SCHEMA_VERSION = 1;

const decimalString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/u, 'must be a non-negative decimal string')
  .refine((v) => Number(v) > 0, 'must be greater than zero');

export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{5,20}$/u, 'symbol must be 5-20 uppercase alphanumeric characters');

export const sideSchema = z.enum(['BUY', 'SELL']);
export const orderTypeSchema = z.enum(['MARKET', 'LIMIT']);
export const timeInForceSchema = z.enum(['GTC', 'IOC', 'FOK']);

/** Request body for POST /v1/intents. */
export const createIntentRequestSchema = z
  .object({
    accountRef: z.string().trim().min(1).max(64),
    symbol: symbolSchema,
    side: sideSchema,
    orderType: orderTypeSchema,
    quantity: decimalString.optional(),
    quoteQuantity: decimalString.optional(),
    limitPrice: decimalString.optional(),
    timeInForce: timeInForceSchema.optional(),
    maxNotional: decimalString,
    expiresInSeconds: z.number().int().min(30).max(86_400).default(3600),
    createdBy: z.string().trim().min(1).max(120),
  })
  .superRefine((value, ctx) => {
    const hasQty = value.quantity !== undefined;
    const hasQuoteQty = value.quoteQuantity !== undefined;
    if (hasQty === hasQuoteQty) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of quantity or quoteQuantity',
        path: ['quantity'],
      });
    }
    if (value.orderType === 'LIMIT') {
      if (value.limitPrice === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'limitPrice is required for LIMIT orders',
          path: ['limitPrice'],
        });
      }
      if (hasQuoteQty) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'quoteQuantity is not supported for LIMIT orders',
          path: ['quoteQuantity'],
        });
      }
    }
    if (value.orderType === 'MARKET' && value.limitPrice !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'limitPrice is not valid for MARKET orders',
        path: ['limitPrice'],
      });
    }
  });

export type CreateIntentRequest = z.infer<typeof createIntentRequestSchema>;

export const tradeIntentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  intentId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(128),
  intentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  accountRef: z.string(),
  symbol: z.string(),
  side: sideSchema,
  orderType: orderTypeSchema,
  quantity: z.string().nullable(),
  quoteQuantity: z.string().nullable(),
  limitPrice: z.string().nullable(),
  timeInForce: timeInForceSchema.nullable(),
  maxNotional: z.string(),
  createdBy: z.string(),
  confirmationRef: z.string().nullable(),
  confirmedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type TradeIntent = z.infer<typeof tradeIntentSchema>;

export const operationSchema = z.object({
  operationId: z.string().uuid(),
  intentId: z.string().uuid(),
  venueClientOrderId: z.string(),
  venueOrderId: z.string().nullable(),
  state: z.enum(OPERATION_STATES),
  stateVersion: z.number().int().nonnegative(),
  submitAttemptCount: z.number().int().nonnegative(),
  executedQuantity: z.string(),
  cumulativeQuoteQuantity: z.string(),
  firstSubmittedAt: z.string().datetime().nullable(),
  lastObservedAt: z.string().datetime().nullable(),
  terminalReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Operation = z.infer<typeof operationSchema>;

export const evidenceSourceSchema = z.enum([
  'LOCAL',
  'AGENT_OS',
  'BINANCE_ORDER_API',
  'BINANCE_ACCOUNT_API',
  'FAULT_INJECTOR',
  'OPERATOR',
]);

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const evidenceEventTypeSchema = z.enum([
  'INTENT_CREATED',
  'INTENT_CONFIRMED',
  'SUBMISSION_STARTED',
  'SUBMISSION_ACKNOWLEDGED',
  'SUBMISSION_AMBIGUOUS',
  'SUBMISSION_REJECTED',
  'RECONCILIATION_STARTED',
  'ORDER_OBSERVED',
  'ORDER_ABSENT_OBSERVED',
  'ACCOUNT_OBSERVED',
  'CANCEL_REQUESTED',
  'CANCEL_OBSERVED',
  'MANUAL_REVIEW_ESCALATED',
  'RETRY_BLOCKED',
  'FAULT_INJECTED',
]);

export type EvidenceEventType = z.infer<typeof evidenceEventTypeSchema>;

export const evidenceEventSchema = z.object({
  sequence: z.number().int().positive(),
  operationId: z.string().uuid(),
  eventType: evidenceEventTypeSchema,
  source: evidenceSourceSchema,
  sourceTimestamp: z.string().datetime().nullable(),
  observedAt: z.string().datetime(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  facts: z.record(z.unknown()),
  previousEventHash: z.string().nullable(),
  eventHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type EvidenceEvent = z.infer<typeof evidenceEventSchema>;

/**
 * Vendor-neutral view of an authoritative order observation. Adapter response
 * shapes never reach the domain; they are normalized into this first.
 */
export const orderObservationSchema = z.object({
  venueClientOrderId: z.string(),
  venueOrderId: z.string(),
  status: z.enum([
    'NEW',
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCELED',
    'PENDING_CANCEL',
    'REJECTED',
    'EXPIRED',
    'EXPIRED_IN_MATCH',
  ]),
  executedQuantity: z.string(),
  cumulativeQuoteQuantity: z.string(),
  sourceTimestamp: z.string().datetime().nullable(),
});

export type OrderObservation = z.infer<typeof orderObservationSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
