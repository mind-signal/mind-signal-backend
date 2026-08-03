import { z } from 'zod';

// createSession 전용 validate middleware schema — body 누락 시 .default({})로 빈 객체 대체함
// POST / — 세션 생성 요청 검증 DTO (body 선택적)
// groupId 누락 시 빈 객체로 대체 → safeParse 성공 처리함 (F8-bis 패턴)
export const createSessionSchema = z
  .object({
    groupId: z
      .string()
      .regex(/^[0-9a-fA-F]{24}$/, 'groupId는 24자리 HEX ObjectId여야 합니다.')
      .optional(),
    // 실험 모드 — 미제공 시 BE 스키마 default(DUAL) 적용함 (DUAL_2PC 생성 경로 지원)
    experimentMode: z.enum(['BTI', 'DUAL_2PC']).optional(),
  })
  .default({});

export type CreateSessionDto = z.infer<typeof createSessionSchema>;
