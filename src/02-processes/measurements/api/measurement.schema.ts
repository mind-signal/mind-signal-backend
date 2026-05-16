// src/02-processes/measurements/api/measurement.schema.ts
import { z } from 'zod';
export {
  SampleEnvelopeSchema,
  WavePowerSchema,
  type SampleEnvelope,
} from '@07-shared/schemas/measurement-envelope.schema';

/** MongoDB ObjectId 정규식 패턴 — 24자리 16진수 문자열 검증 */
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

/**
 * 뇌파 측정 시작 경로 파라미터 스키마.
 *
 * POST /sessions/:sessionId/eeg/stream:start 요청의
 * req.params를 검증함.
 */
export const measurementStartParamsSchema = z.object({
  sessionId: z
    .string()
    .regex(OBJECT_ID_REGEX, 'sessionId는 유효한 MongoDB ObjectId여야 합니다.'),
});
