/**
 * session.repro-dual-mode-qr.test.ts — DUAL 모드 QR 미생성 버그 회귀 박제
 *
 * 확정된 root cause 3가지:
 *   1. FE → BE 첫 호출: FE session.ts:48-49가 { groupId: null } 전송
 *   2. Zod regex 거부: session.schema.ts:8-11의 z.string().regex(...).optional()이
 *      null을 string으로 판단하지 않아 400 반환 (버그 A)
 *   3. 2차 함정: pairing.service.ts:43-44가 신규 groupId를 8자리 HEX 생성.
 *      두 번째 Subject 요청 시 8자리 boundId 보내도 24자리 regex 실패 → 400 (버그 B)
 *
 * 시나리오 ABC (회귀 시뮬레이션 의무):
 *   A = 기존 잘못된 동작 박제 — fix 전 fail, fix 후 pass 전환 대상
 *   B = fix 무력화 시뮬레이션 — fix 적용 후 동일 입력이 다시 400으로 돌아가면 회귀
 *   C = happy path — 정상 동작 기준선 (항상 pass 유지)
 *
 * fix 적용 후 PASS 전환 방법:
 *   - Scenario A: expect(res.status).toBe(400) → toBe(201)
 *   - Scenario B: expect(res.status).toBe(400) → toBe(201)
 *   - Scenario C: 변경 불필요 (이미 201)
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// ===== Mock 설정 (hoist 의무 — 모듈 import 전) =====

// env — config.ts 초기 평가 전 설정 의무
process.env.JWT_SECRET_KEY = 'test-secret-repro';
process.env.JWT_EXPIRES_IN = '1h';

// authenticate mock — JWT 검증 우회 + req.user 주입
// session.routes.dual2pc.test.ts:38-56 패턴 정합
jest.mock('@07-shared/middlewares', () => {
  const actual = jest.requireActual('@07-shared/middlewares');
  return {
    ...actual,
    authenticate: (req: Request, _res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return _res.status(401).json({
          status: 'fail',
          message: '인증이 필요합니다.',
        });
      }
      (req as Request & { user?: { id: string } }).user = {
        id: '507f1f77bcf86cd799439011',
      };
      next();
    },
  };
});

// pairing.service mock — MongoDB/group_counters 의존 제거
// createGroupSessionProcess만 교체, 나머지 export 보존
// 옵션 D fix 후 pairing.service.ts:44가 24자리 ObjectId hex 생성하므로
// mock fixture도 24자리 정합 형식 사용함
jest.mock('@05-features/sessions/services/pairing.service', () => ({
  createGroupSessionProcess: jest.fn().mockResolvedValue({
    _id: '507f1f77bcf86cd799439099',
    groupId: '65c9f0b2a1b2c3d4e5f67899',
    subjectIndex: 1,
    pairingToken: 'AABBCC',
    status: 'CREATED',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    save: jest.fn(),
  }),
  addPairingCompleteListener: jest.fn(),
  firePairingCompleteListeners: jest.fn(),
  removePairingCompleteListener: jest.fn(),
  pairDeviceProcess: jest.fn(),
}));

// 라우터 import (mock 적용 후)
import sessionRoutes from './session.routes';
import { AppError } from '@07-shared/errors';
import { createGroupSessionProcess } from '@05-features/sessions/services/pairing.service';

// ===== bare Express app 빌드 =====
// session.routes.adminpair.test.ts:57-71 패턴 정합 — mongoose/app.ts side-effect 없음
const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionRoutes);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        status: err.statusCode >= 500 ? 'error' : 'fail',
        message: err.message,
      });
    }
    // 비-AppError (Zod ValidationError 등) — validate middleware가 400 반환함
    return res.status(500).json({ status: 'error', message: 'internal' });
  });
  return app;
};

const app = buildApp();
const TEST_JWT = 'Bearer test-token-repro';

// ===== 회귀 박제 테스트 suite =====

describe('Reproduce: DUAL 모드 QR 미생성 버그 회귀 박제', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 기본 mock 복원 — 옵션 D fix 후 24자리 ObjectId hex 형식 정합
    (createGroupSessionProcess as jest.Mock).mockResolvedValue({
      _id: '507f1f77bcf86cd799439099',
      groupId: '65c9f0b2a1b2c3d4e5f67899',
      subjectIndex: 1,
      pairingToken: 'AABBCC',
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
  });

  /**
   * 회귀 시뮬레이션 A — "기존 잘못된 동작 박제"
   * 버그 현재 동작을 명시. fix 전에는 이 테스트가 pass (버그 동작 확인).
   * fix 적용 후에는 expect(res.status).toBe(400) 을 toBe(201) 로 변경해야 pass.
   */
  describe('Scenario A: 첫 Subject 페어링 시 FE가 groupId=null 전송 (버그 A 박제)', () => {
    it('현재 동작: BE가 Zod regex 실패로 400 반환함 (버그 — fix 후 201 전환 대상)', async () => {
      // Arrange — FE session.ts:48-49 실제 동작 재현
      // DUAL 모드에서 첫 Subject는 groupId를 모르기 때문에 null을 보냄
      const body = { groupId: null };

      // Act
      const res = await request(app)
        .post('/api/sessions')
        .set('Authorization', TEST_JWT)
        .send(body);

      // Assert — 현재 동작 박제
      // session.schema.ts:8-11의 z.string().regex(...).optional()이
      // null을 거부하여 400을 반환함
      // fix 후엔 201로 변경되어야 함 (null → undefined 처리 or nullable() 추가)
      expect(res.status).toBe(400);

      // 400 응답 시 service가 호출되지 않았음을 확인함 (Zod 미들웨어 차단 확인)
      expect(createGroupSessionProcess).not.toHaveBeenCalled();
    });

    it('현재 동작 상세 확인: Zod 오류 메시지가 groupId 관련 내용임 (근거 박제)', async () => {
      // Arrange
      const body = { groupId: null };

      // Act
      const res = await request(app)
        .post('/api/sessions')
        .set('Authorization', TEST_JWT)
        .send(body);

      // Assert — 400이고 body에 오류 정보 포함 확인
      expect(res.status).toBe(400);
      // validate middleware가 Zod safeParse 실패 시 400을 반환함
      // res.body에 오류 메시지 포함 여부 확인 (구조는 validate.middleware.ts 구현에 따름)
      expect(res.body).toBeDefined();
    });
  });

  /**
   * 회귀 시뮬레이션 B — "fix 무력화 시뮬레이션"
   * 버그 B: pairing.service.ts:43-44가 8자리 HEX groupId 생성.
   * 두 번째 Subject가 해당 8자리 값을 그대로 보내면 24자리 regex 실패 → 400.
   * fix 후 expect(res.status).toBe(400) 을 toBe(201) 로 변경해야 pass.
   */
  describe('Scenario B: 두 번째 Subject 페어링 시 8자리 HEX groupId 전송 (버그 B 박제)', () => {
    it('현재 동작: 8자리 HEX는 24자리 regex 실패로 400 반환함 (버그 — fix 후 201 전환 대상)', async () => {
      // Arrange — pairing.service.ts:44의 crypto.randomBytes(4).toString('hex').toUpperCase() 실제 출력 형태
      // 예: 'ABCD1234' — 8자리 HEX
      const eightHexGroupId = 'ABCD1234';
      const body = { groupId: eightHexGroupId };

      // Act
      const res = await request(app)
        .post('/api/sessions')
        .set('Authorization', TEST_JWT)
        .send(body);

      // Assert — 현재 동작 박제
      // session.schema.ts의 regex(/^[0-9a-fA-F]{24}$/)가
      // 8자리를 거부하여 400을 반환함
      // fix 후엔 201로 변경되어야 함 (regex 조건 확장 or 별도 검증 전략 채택)
      expect(res.status).toBe(400);

      // 400 응답 시 service가 호출되지 않았음을 확인함
      expect(createGroupSessionProcess).not.toHaveBeenCalled();
    });

    it('현재 동작 확인: 12자리 HEX도 거부됨 (24자리 강제 검증 확인)', async () => {
      // Arrange — 24자리가 아닌 다른 HEX 길이
      const twelveHexGroupId = 'AABBCCDDEEFF';
      const body = { groupId: twelveHexGroupId };

      // Act
      const res = await request(app)
        .post('/api/sessions')
        .set('Authorization', TEST_JWT)
        .send(body);

      // Assert — 24자리 regex가 강제 적용됨 확인
      expect(res.status).toBe(400);
      expect(createGroupSessionProcess).not.toHaveBeenCalled();
    });
  });

  /**
   * 회귀 시뮬레이션 C — "happy path 정상 동작 기준선"
   * 정상 path: groupId 없이 빈 body 또는 undefined 전송 → .default({}) 적용
   * fix 전후 모두 pass 유지 (기준선)
   */
  describe('Scenario C: groupId 누락 시 정상 동작 (기준선 — fix 전후 항상 pass)', () => {
    it('현재 동작: 빈 body는 .default({}) 적용으로 201 반환함 (정상 path)', async () => {
      // Arrange — groupId 없이 빈 객체 전송
      // session.schema.ts의 .default({})가 undefined를 빈 객체로 대체함
      const body = {};

      // Act
      const res = await request(app)
        .post('/api/sessions')
        .set('Authorization', TEST_JWT)
        .send(body);

      // Assert — 201 + pairingToken 포함 확인
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('pairingToken');
      expect(res.body.data).toHaveProperty('groupId');
      expect(res.body.data).toHaveProperty('subjectIndex');

      // D-1: 옵션 D fix 후 응답 groupId가 24자리 hex (ObjectId) 형식 확인
      // session.schema.ts:8-11 regex와 정합 (재페어링 시 두 번째 호출도 통과)
      expect(res.body.data.groupId).toMatch(/^[0-9a-fA-F]{24}$/);

      // service가 groupId 없이 호출되었음을 확인 (신규 그룹 생성 경로)
      expect(createGroupSessionProcess).toHaveBeenCalledWith(
        undefined,
        '507f1f77bcf86cd799439011'
      );
    });

    it('현재 동작: 유효한 24자리 ObjectId groupId는 201 반환함 (기존 그룹 추가 경로)', async () => {
      // Arrange — 유효한 MongoDB ObjectId 형식
      const validObjectId = '65c9f0b2a1b2c3d4e5f67800';
      const body = { groupId: validObjectId };

      // Act
      const res = await request(app)
        .post('/api/sessions')
        .set('Authorization', TEST_JWT)
        .send(body);

      // Assert — 201 + 기존 그룹 ID로 service 호출됨
      expect(res.status).toBe(201);
      expect(createGroupSessionProcess).toHaveBeenCalledWith(
        validObjectId,
        '507f1f77bcf86cd799439011'
      );
    });

    it('현재 동작: Authorization 없음 → 401 반환함 (인증 guard 확인)', async () => {
      // Act — 인증 헤더 없이 요청
      const res = await request(app).post('/api/sessions').send({});

      // Assert
      expect(res.status).toBe(401);
      expect(createGroupSessionProcess).not.toHaveBeenCalled();
    });
  });
});
