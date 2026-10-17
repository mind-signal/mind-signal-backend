/**
 * GET /api/sessions/group/:groupId/status — stopReason, analysisTier 필드 검증
 * (SESSION-W008). 재생 하네스가 자연 종료와 등급을 이 응답으로 확인함.
 */

import express from 'express';
import request from 'supertest';

const OPERATOR_ID = 'mock-operator-id';

jest.mock('@06-entities/sessions', () => ({
  Session: { find: jest.fn() },
}));

jest.mock('@07-shared/config/config', () => ({
  config: {
    jwtSecret: { secret: 'test-secret-key', expiresIn: '5m' },
    dataEngine: { secretKey: 'engine-secret' },
    dualPc: { timestampToleranceMs: 200, registrationTimeoutMs: 60000 },
  },
}));

jest.mock('@07-shared/lib/redis', () => ({
  redisService: {
    client: { publish: jest.fn() },
    connect: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('@07-shared/middlewares', () => {
  const actual = jest.requireActual('@07-shared/middlewares');
  return {
    ...actual,
    authenticate: (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (!req.headers.authorization?.startsWith('Bearer ')) {
        return res
          .status(401)
          .json({ status: 'fail', message: '인증이 필요합니다.' });
      }
      (req as express.Request & { user: { id: string } }).user = {
        id: OPERATOR_ID,
      };
      next();
    },
  };
});

import { Session } from '@06-entities/sessions';
import sessionRouter from './session.routes';

const app = express();
app.use(express.json());
app.use('/api/sessions', sessionRouter);

/** populate 체인을 흉내 낸 find 결과 설정함 */
function mockSessions(rows: Array<Record<string, unknown>>) {
  (Session.find as jest.Mock).mockReturnValue({
    populate: jest.fn().mockResolvedValue(rows),
  });
}

describe('GET /api/sessions/group/:groupId/status 종료 사유와 등급 (SESSION-W008)', () => {
  it('완료 세션의 stopReason 과 analysisTier 를 실음', async () => {
    mockSessions(
      [1, 2].map((subjectIndex) => ({
        subjectIndex,
        status: 'COMPLETED',
        userId: null,
        creatorId: OPERATOR_ID,
        stopReason: 'Natural',
        analysisTier: 'VALID',
      }))
    );

    const res = await request(app)
      .get('/api/sessions/group/grp-1/status')
      .set('Authorization', 'Bearer t')
      .expect(200);

    expect(res.body.data.sessions).toEqual([
      expect.objectContaining({
        subjectIndex: 1,
        stopReason: 'Natural',
        analysisTier: 'VALID',
      }),
      expect.objectContaining({
        subjectIndex: 2,
        stopReason: 'Natural',
        analysisTier: 'VALID',
      }),
    ]);
  });

  it('필드가 없는 측정 중 세션은 둘 다 null 임', async () => {
    mockSessions([
      { subjectIndex: 1, status: 'MEASURING', userId: null, creatorId: null },
    ]);

    const res = await request(app)
      .get('/api/sessions/group/grp-1/status')
      .set('Authorization', 'Bearer t')
      .expect(200);

    expect(res.body.data.sessions[0]).toMatchObject({
      stopReason: null,
      analysisTier: null,
    });
  });

  it('인증 없으면 401 임', async () => {
    await request(app).get('/api/sessions/group/grp-1/status').expect(401);
  });
});
