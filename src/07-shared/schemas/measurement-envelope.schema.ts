/* eslint-disable camelcase */
import { z } from 'zod';

export const WavePowerSchema = z.object({
  delta: z.number(),
  theta: z.number(),
  alpha: z.number(),
  beta: z.number(),
  gamma: z.number(),
});

export const SampleEnvelopeSchema = z.object({
  group_id: z.string(),
  subject_idx: z.number().int(),
  de_ts_ns: z.string().regex(/^\d{1,21}$/),
  proxy_ingress_ts_ns: z.string().regex(/^\d{1,21}$/),
  seq: z.number().int(),
  payload: WavePowerSchema,
  sync_meta: z.record(z.string(), z.unknown()),
});
export type SampleEnvelope = z.infer<typeof SampleEnvelopeSchema>;
