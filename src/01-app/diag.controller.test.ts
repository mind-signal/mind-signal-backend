import express from 'express';
import request from 'supertest';

jest.mock('@07-shared/lib/redis', () => ({
  redisService: {
    connect: jest.fn(),
    client: { ping: jest.fn(), duplicate: jest.fn() },
  },
}));

import { diagStatus, diagAction } from './diag.controller';

// 모든 외부 fetch(DE_A/DE_B)는 실패로 모킹함 (서비스 미기동 가정)
const failFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
const originalFetch = global.fetch;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/diag', diagStatus);
  app.post('/diag/action/:name', diagAction);
  return app;
}

beforeEach(() => {
  failFetch.mockReset().mockRejectedValue(new Error('ECONNREFUSED'));
  global.fetch = failFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('GET /diag', () => {
  it('DE 미도달 시에도 200 + match 구조 반환함', async () => {
    const res = await request(buildApp()).get('/diag');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.dataEngineA.reachable).toBe(false);
    expect(res.body.data.match).toHaveProperty('matched');
  });
});

describe('POST /diag/action/:name', () => {
  it('알 수 없는 액션은 404 반환함', async () => {
    const res = await request(buildApp()).post('/diag/action/bogus');
    expect(res.status).toBe(404);
  });

  it('registry-status는 groupId로 기본 status 반환함', async () => {
    const res = await request(buildApp()).post(
      '/diag/action/registry-status?groupId=abc'
    );
    expect(res.status).toBe(200);
    expect(res.body.data.groupId).toBe('abc');
    expect(res.body.data.status).toHaveProperty('registered', 0);
  });

  it('registry-status는 groupId 누락 시 error 필드 반환함', async () => {
    const res = await request(buildApp()).post('/diag/action/registry-status');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('error');
  });
});
