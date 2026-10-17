/**
 * GET /api/analysis/:groupId — 등급(tier) 필드 검증 (SESSION-W008).
 *
 * 결과 화면이 isBTI 와 세션 수로 등급을 추측하지 않도록 세션에 저장한 등급을
 * 응답에 실음. ABORTED 처럼 분석 결과가 없는 그룹도 404 본문의 tier 로 알 수
 * 있어야 함.
 */

import express from 'express';
import request from 'supertest';

const GROUP_ID = '65c9f0b2a1b2c3d4e5f67890';
const OPERATOR_ID = 'operator-1';

const sessions: Array<{
  userId: null;
  creatorId: { toString: () => string };
  analysisTier: string | null;
}> = [];
let analysisResult: Record<string, unknown> | null = null;

jest.mock('@06-entities/sessions', () => ({
  Session: {
    find: jest.fn(() => ({ populate: jest.fn(async () => sessions) })),
  },
}));

jest.mock('@06-entities/analysis-results', () => ({
  AnalysisResult: {
    findOne: jest.fn(() => ({ populate: jest.fn(async () => analysisResult) })),
  },
}));

jest.mock('@07-shared/middlewares', () => ({
  authenticate: (
    req: import('@07-shared/types').AuthedRequest,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.user = { id: OPERATOR_ID };
    next();
  },
}));

import analysisRouter from './analysis.routes';

const app = express();
app.use('/api/analysis', analysisRouter);
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

/** 등급이 저장된 두 세션을 채움 */
function seedSessions(tier: string | null) {
  sessions.length = 0;
  for (let i = 0; i < 2; i++) {
    sessions.push({
      userId: null,
      creatorId: { toString: () => OPERATOR_ID },
      analysisTier: tier,
    });
  }
}

describe('GET /api/analysis/:groupId 등급 필드 (SESSION-W008)', () => {
  beforeEach(() => {
    analysisResult = null;
  });

  it('결과가 있으면 data.tier 에 저장된 등급을 실음', async () => {
    seedSessions('VALID');
    analysisResult = {
      groupId: GROUP_ID,
      matchingScore: 70,
      user1Id: { _id: 'u1', name: 'A' },
      user2Id: { _id: 'u2', name: 'B' },
      pipelineResult: {},
    };

    const res = await request(app).get(`/api/analysis/${GROUP_ID}`).expect(200);

    expect(res.body.data).toMatchObject({ tier: 'VALID', isBTI: false });
  });

  it('ABORTED 처럼 결과가 없으면 404 본문에 tier 를 실음', async () => {
    seedSessions('ABORTED');

    const res = await request(app).get(`/api/analysis/${GROUP_ID}`).expect(404);

    expect(res.body).toMatchObject({ status: 'fail', tier: 'ABORTED' });
  });

  it('판정 전이면 404 본문의 tier 는 null 임', async () => {
    seedSessions(null);

    const res = await request(app).get(`/api/analysis/${GROUP_ID}`).expect(404);

    expect(res.body.tier).toBeNull();
  });
});
