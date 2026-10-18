/**
 * stream/stop 상태 확인 순서 회귀 방어.
 *
 * 종료할 수 없는 세션(CREATED, PAIRED, CANCELLED, EXPIRED)에 stream/stop 을
 * 보내면 엔진 요청이 먼저 나가 400 대신 엔진의 404나 503이 응답됐음. 실제
 * 세션 모델의 전이 규칙(canTransitionTo)과 실제 엔진 프록시를 쓰고 fetch 만
 * 가짜로 바꿔 엔진 요청 수를 셈. 가짜 fetch 는 등록 없는 그룹에 엔진이
 * 내는 응답(stop_stream 의 KeyError → 404)을 흉내 냄.
 */

import express from 'express';
import request from 'supertest';

const GROUP_ID = '65c9f0b2a1b2c3d4e5f6bbbb';
const SECRET = 'correct-engine-secret';

jest.mock('@07-shared/config/config', () => ({
  config: {
    env: 'test',
    isProduction: false,
    messageBus: 'redis',
    redis: { url: 'redis://localhost:6379' },
    dataEngine: { baseUrl: 'http://localhost:5002', secretKey: SECRET },
    dualPc: { timestampToleranceMs: 200, registrationTimeoutMs: 60000 },
    measurement: { expectedSeconds: 600 },
  },
}));

jest.mock('@05-features/sessions', () => ({
  assertGroupOwnership: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@02-processes/measurements/services/measurement.service', () => ({
  isLegacyMeasurementActive: jest.fn(() => false),
  stopMeasurementService: jest.fn().mockResolvedValue({ allCompleted: false }),
}));

jest.mock('@07-shared/middlewares/authenticate.middleware', () => ({
  authenticate: (
    req: import('@07-shared/types').AuthedRequest,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.user = { id: 'operator-1' };
    next();
  },
}));

import { Session, type SessionDoc } from '@06-entities/sessions';
import { engineRegistryService } from '../services/engine-registry.service';
import engineRouter from './engine.routes';

const app = express();
app.use(express.json());
app.use('/api/engine', engineRouter);
app.use(
  (
    err: Error & { statusCode?: number },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    res.status(err.statusCode ?? 500).json({ message: err.message });
  }
);

/** 주어진 상태의 실제 세션 문서를 findOne 결과로 둠 */
function givenSession(status: string) {
  const doc = new Session({
    groupId: GROUP_ID,
    subjectIndex: 1,
    pairingToken: `token-${status}`,
    status,
    expiresAt: new Date(Date.now() + 60_000),
  });
  jest
    .spyOn(Session, 'findOne')
    .mockResolvedValue(doc as unknown as SessionDoc);
  jest.spyOn(Session, 'find').mockResolvedValue([doc]);
}

describe('stream/stop 상태 확인 순서', () => {
  let fetchMock: jest.SpyInstance;

  beforeAll(() => {
    // 그룹 등록이 없으면 legacy 엔진 URL 로 요청이 나감
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    engineRegistryService.register('http://engine-legacy', SECRET);
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: `실행 중인 스트림을 찾을 수 없음: ${GROUP_ID}:1`,
        }),
        { status: 404 }
      )
    );
  });

  it.each(['CANCELLED', 'CREATED', 'PAIRED', 'EXPIRED'])(
    '%s 세션에 stream/stop 을 보내면 엔진 fetch 0회, 400',
    async (status) => {
      givenSession(status);

      const res = await request(app)
        .post('/api/engine/stream/stop')
        .send({ groupId: GROUP_ID, subjectIndex: 1 });

      expect({
        status: res.status,
        fetchCalls: fetchMock.mock.calls.length,
        message: res.body.message,
      }).toEqual({
        status: 400,
        fetchCalls: 0,
        message: `현재 ${status} 상태에서는 측정을 완료할 수 없습니다.`,
      });
    }
  );

  it('세션이 없으면 엔진 fetch 0회, stopMeasurementService 와 같은 404', async () => {
    jest.spyOn(Session, 'findOne').mockResolvedValue(null);

    const res = await request(app)
      .post('/api/engine/stream/stop')
      .send({ groupId: GROUP_ID, subjectIndex: 2 });

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('COMPLETED 세션은 엔진 fetch 없이 200을 반환함', async () => {
    givenSession('COMPLETED');

    const res = await request(app)
      .post('/api/engine/stream/stop')
      .send({ groupId: GROUP_ID, subjectIndex: 1 });

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
