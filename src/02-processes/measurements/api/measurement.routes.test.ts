/**
 * measurement.routes.ts — validateParams 보강 검증 + 라우트 통합 테스트
 *
 * 검증 항목:
 *   - measurementStartParamsSchema Zod 런타임 검증
 *   - measurementGroupStartParamsSchema Zod 런타임 검증
 *   - validateParams가 라우트 미들웨어 체인에 실제로 연결됨 (supertest 기반)
 *   - 유효하지 않은 sessionId(비-ObjectId)는 검증 실패함
 *   - POST /groups/:groupId/eeg/stream:start 엔드포인트 검증
 */

import express from 'express';
import request from 'supertest';
import {
  measurementStartParamsSchema,
  measurementGroupStartParamsSchema,
} from './measurement.schema';
import { authenticate, validateParams } from '@07-shared/middlewares';
import measurementController from './measurement.controller';
import * as measurementService from '@02-processes/measurements/services/measurement.service';
import { AppError } from '@07-shared/errors';

// measurementService 모킹 — 외부 인프라(Redis, Python 엔진, MongoDB) 의존 제거
jest.mock('@02-processes/measurements/services/measurement.service', () => ({
  startMeasurementService: jest
    .fn()
    .mockResolvedValue({ measuredAt: '2026-01-01T00:00:00.000Z' }),
  startDualMeasurementByGroup: jest
    .fn()
    .mockResolvedValue({ groupId: '65c9f0b2a1b2c3d4e5f67890' }),
}));

// authenticate 모킹 — JWT 검증 없이 req.user 주입
jest.mock('@07-shared/middlewares', () => {
  const actual = jest.requireActual('@07-shared/middlewares');
  return {
    ...actual,
    authenticate: (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction
    ) => {
      (req as any).user = { id: 'mockUserId' };
      next();
    },
  };
});

// 라우트 통합 테스트용 경량 Express 앱 생성
function buildMeasurementApp() {
  const app = express();
  app.use(express.json());
  app.post(
    '/sessions/:sessionId/eeg/stream:start',
    authenticate,
    validateParams(measurementStartParamsSchema),
    measurementController.startStreaming
  );
  app.post(
    '/groups/:groupId/eeg/stream:start',
    authenticate,
    validateParams(measurementGroupStartParamsSchema),
    measurementController.startStreamingByGroup
  );
  // 전역 에러 핸들러 — AppError를 JSON으로 변환함
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (err instanceof AppError) {
        const status = err.statusCode >= 500 ? 'error' : 'fail';
        return res
          .status(err.statusCode)
          .json({ status, message: err.message });
      }
      return res.status(500).json({ status: 'error', message: 'unknown' });
    }
  );
  return app;
}

describe('measurementStartParamsSchema Zod 런타임 검증', () => {
  it('유효한 24자리 hex ObjectId는 검증을 통과함', () => {
    const result = measurementStartParamsSchema.safeParse({
      sessionId: '65c9f0b2a1b2c3d4e5f67890',
    });
    expect(result.success).toBe(true);
  });

  it('소문자 24자리 hex ObjectId도 검증을 통과함', () => {
    const result = measurementStartParamsSchema.safeParse({
      sessionId: 'aabbccddeeff001122334455',
    });
    expect(result.success).toBe(true);
  });

  it('23자리 짧은 문자열은 검증 실패함', () => {
    const result = measurementStartParamsSchema.safeParse({
      sessionId: '65c9f0b2a1b2c3d4e5f6789',
    });
    expect(result.success).toBe(false);
  });

  it('비-hex 문자 포함 시 검증 실패함', () => {
    const result = measurementStartParamsSchema.safeParse({
      sessionId: 'zzzzzzzzzzzzzzzzzzzzzzzz',
    });
    expect(result.success).toBe(false);
  });

  it('빈 문자열은 검증 실패함', () => {
    const result = measurementStartParamsSchema.safeParse({ sessionId: '' });
    expect(result.success).toBe(false);
  });

  it('sessionId 누락 시 검증 실패함', () => {
    const result = measurementStartParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('measurementGroupStartParamsSchema Zod 런타임 검증', () => {
  it('유효한 24자리 hex ObjectId는 검증을 통과함', () => {
    const result = measurementGroupStartParamsSchema.safeParse({
      groupId: '65c9f0b2a1b2c3d4e5f67890',
    });
    expect(result.success).toBe(true);
  });

  it('비-hex 문자 포함 시 검증 실패함', () => {
    const result = measurementGroupStartParamsSchema.safeParse({
      groupId: 'invalid-group-id',
    });
    expect(result.success).toBe(false);
  });

  it('groupId 누락 시 검증 실패함', () => {
    const result = measurementGroupStartParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('POST /sessions/:sessionId/eeg/stream:start — validateParams 라우트 통합', () => {
  const app = buildMeasurementApp();

  it('유효한 ObjectId sessionId로 요청 시 200 반환함', async () => {
    const res = await request(app).post(
      '/sessions/65c9f0b2a1b2c3d4e5f67890/eeg/stream:start'
    );
    expect(res.status).toBe(200);
  });

  it('비-ObjectId sessionId로 요청 시 400 반환함 (validateParams 체인 확인)', async () => {
    const res = await request(app).post(
      '/sessions/invalid-id/eeg/stream:start'
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /groups/:groupId/eeg/stream:start — DUAL_2PC 그룹 기반 측정 시작', () => {
  const VALID_GROUP_ID = '65c9f0b2a1b2c3d4e5f67890';
  const app = buildMeasurementApp();

  const mockedStartDualMeasurementByGroup =
    measurementService.startDualMeasurementByGroup as jest.MockedFunction<
      typeof measurementService.startDualMeasurementByGroup
    >;

  beforeEach(() => {
    mockedStartDualMeasurementByGroup.mockResolvedValue({
      groupId: VALID_GROUP_ID,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('유효한 groupId + DUAL_2PC 세션 존재 시 202 반환함', async () => {
    const res = await request(app).post(
      `/groups/${VALID_GROUP_ID}/eeg/stream:start`
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      status: 'accepted',
      groupId: VALID_GROUP_ID,
    });
  });

  it('groupId에 속한 세션 없을 때 404 반환함', async () => {
    mockedStartDualMeasurementByGroup.mockRejectedValue(
      new AppError('해당 groupId에 속한 세션을 찾을 수 없습니다.', 404)
    );
    const res = await request(app).post(
      `/groups/${VALID_GROUP_ID}/eeg/stream:start`
    );
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('fail');
  });

  it('experimentMode가 DUAL_2PC가 아닐 때 400 반환함', async () => {
    mockedStartDualMeasurementByGroup.mockRejectedValue(
      new AppError('groupId 기반 측정 시작은 DUAL_2PC 모드만 지원합니다.', 400)
    );
    const res = await request(app).post(
      `/groups/${VALID_GROUP_ID}/eeg/stream:start`
    );
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('fail');
  });

  it('비-ObjectId groupId로 요청 시 400 반환함 (validateParams 체인 확인)', async () => {
    const res = await request(app).post(
      '/groups/invalid-group-id/eeg/stream:start'
    );
    expect(res.status).toBe(400);
  });
});
