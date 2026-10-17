/* eslint-disable camelcase */
import { z } from 'zod';

/**
 * proxy be-forwarder가 `proxy:sample`로 보내는 envelope의 집중 검증 스키마.
 *
 * publish에 필요한 필드(group_id, subject_idx, payload)와 정렬 기준
 * proxy_ingress_ts_ns, 중복 판정 키 seq/de_ts_ns만 검증함. sync_meta는
 * BE 미소비라 미검증함 (Zod가 strip).
 * 계약 출처: mind-signal-proxy/src/types/envelope.ts
 */

/**
 * 프록시 수신 시각(epoch ns 십진 문자열). aligner 페어링 기준임 (EEG-W006).
 * 길이 상한으로 BigInt 변환 전에 범위를 막음.
 */
export const IngressTsNsSchema = z.string().regex(/^\d{1,21}$/);
export const WavePowerSchema = z.object({
  delta: z.number(),
  theta: z.number(),
  alpha: z.number(),
  beta: z.number(),
  gamma: z.number(),
});

/**
 * EMOTIV 지표 6종. metrics를 싣지 않던 구버전 DE 프레임과 호환하려고 optional임.
 * 누락 시 FE 차트가 대역 파워를 지표 자리에 표시하던 결함이 재발함 (2026-07-10 수정).
 */
export const EmotivMetricsSchema = z.object({
  focus: z.number(),
  engagement: z.number(),
  interest: z.number(),
  excitement: z.number(),
  stress: z.number(),
  relaxation: z.number(),
});

/**
 * DE가 Redis 채널로 직접 publish하는 brain_sync_all 메시지 스키마.
 *
 * JSON.parse 결과를 검증 없이 aligner에 넣으면 waves 누락 프레임이
 * SubjectSample.waves(필수)에 undefined로 주입됨 (CodeRabbit PR #74).
 */
export const BrainSyncAllSchema = z.object({
  type: z.literal('brain_sync_all'),
  waves: WavePowerSchema,
  metrics: EmotivMetricsSchema.optional(),
  // /proxy 핸들러가 재발행한 프레임에만 있음. DE 직접 발행 프레임에는 없음
  proxy_ingress_ts_ns: IngressTsNsSchema.optional(),
});

export const ProxySampleSchema = z.object({
  group_id: z.string().min(1),
  // subject_idx는 1-based 계약이며 Group 최대 2 Subject라 1..2만 유효함
  // (measurement.service.ts [1, 2] 루프 정합). 범위 밖(0/음수/3+)은 구독자 없는
  // 채널로 publish되어 ack는 ok인데 silent drop되므로 의도적 fail-closed로 invalid_frame 거부함.
  subject_idx: z.number().int().min(1).max(2),
  payload: WavePowerSchema,
  metrics: EmotivMetricsSchema.optional(),
  // 프록시가 항상 찍지만 구버전 프록시와 호환하려고 optional임
  proxy_ingress_ts_ns: IngressTsNsSchema.optional(),
  // 재시도/replay 중복 판정 키임 (EEG-W007). 구버전 엔진은 없을 수 있어 optional임
  seq: z.number().int().min(0).optional(),
  de_ts_ns: IngressTsNsSchema.optional(),
});

export type ProxySample = z.infer<typeof ProxySampleSchema>;

/**
 * proxy가 `proxy:status`로 보내는 헤드셋 상태 통보 스키마.
 *
 * 엔진이 Redis에 직접 보내던 headset_status 경보를 Redis 없는 구성에서
 * 프록시 경유로 받기 위한 계약임. subject_idx 범위는 ProxySampleSchema와 같음.
 */
export const ProxyStatusSchema = z.object({
  group_id: z.string().min(1),
  subject_idx: z.number().int().min(1).max(2),
  status: z.string(),
  silent_seconds: z.number().optional(),
});

export type ProxyStatus = z.infer<typeof ProxyStatusSchema>;
