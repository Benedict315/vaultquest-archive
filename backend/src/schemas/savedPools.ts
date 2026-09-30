import { z } from "zod";
import { POOL_STATE_INPUTS } from "../../../lib/pool-lifecycle.js";
import { safeRequiredText } from "./safeContent.js";

// Validates against the shared pool-lifecycle vocabulary (#763) instead of a
// hand-copied subset, so the API accepts exactly the tokens the state machine
// can normalize (canonical states + on-chain aliases such as `closed`).
export const savedPoolStatus = z.enum(POOL_STATE_INPUTS);

export const savedPoolRecord = z.object({
  pool_id: z.string().min(1).max(120),
  pool_name: safeRequiredText(200),
  status: savedPoolStatus,
  tvl: z.string().min(1).max(120),
  asset: z.string().min(1).max(32),
  participant_count: z.coerce.number().int().min(0),
  expected_yield: z.string().min(1).max(120),
  prize: z.string().max(120).optional().nullable(),
  opens_at: z.string().datetime({ offset: true }).optional().nullable(),
  locks_at: z.string().datetime({ offset: true }).optional().nullable(),
  draws_at: z.string().datetime({ offset: true }).optional().nullable()
});

export const savedPoolUpsertBody = z.object({
  wallet_address: z.string().min(1).max(120),
  pool: savedPoolRecord,
  idempotency_key: z.string().uuid().optional()
});

export const savedPoolListQuery = z.object({
  wallet: z.string().min(1).max(120),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const savedPoolDeleteParams = z.object({
  poolId: z.string().min(1).max(120)
});
