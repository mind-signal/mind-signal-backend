/* eslint-disable camelcase */
import { z } from 'zod';

/**
 * proxy be-forwarder가 `proxy:sample`로 보내는 envelope의 집중 검증 스키마.
 *
 * publish에 필요한 필드(group_id, subject_idx, payload)만 검증함.
 * de_ts_ns/proxy_ingress_ts_ns/seq/sync_meta는 BE 미소비라 미검증함 (Zod가 strip).
 * 계약 출처: mind-signal-proxy/src/types/envelope.ts
 */
const WavePowerSchema = z.object({
  delta: z.number(),
  theta: z.number(),
  alpha: z.number(),
  beta: z.number(),
  gamma: z.number(),
});

export const ProxySampleSchema = z.object({
  group_id: z.string().min(1),
  // subject_idx는 1-based 계약임 (measurement.service.ts [1, 2] 루프 정합).
  // proxy 원본은 z.number().int()로 더 느슨하나 BE는 0/음수를 의도적 fail-closed로
  // invalid_frame 처리함.
  subject_idx: z.number().int().min(1),
  payload: WavePowerSchema,
});

export type ProxySample = z.infer<typeof ProxySampleSchema>;
