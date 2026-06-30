import express from 'express';
import request from 'supertest';

jest.mock('@07-shared/lib/redis', () => ({
  redisService: {
    connect: jest.fn().mockResolvedValue(undefined),
    client: { ping: jest.fn().mockResolvedValue('PONG') },
  },
}));

// 모든 peer fetch는 실패로 모킹(서비스 미기동 가정), services 전부 down 처리함
const failFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
global.fetch = failFetch as unknown as typeof fetch;

import { healthCheck } from './health.controller';

function buildApp() {
  const app = express();
  app.get('/health', healthCheck);
  return app;
}

describe('GET /health', () => {
  it('redis가 살아있으면 200과 redis:ok를 반환함', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.redis).toBe('ok');
    expect(res.body.data.services).toHaveProperty('data-engine-A', 'down');
  });

  it('redis ping이 실패해도 200으로 redis:down을 표시함', async () => {
    const { redisService } = require('@07-shared/lib/redis');
    redisService.client.ping.mockRejectedValueOnce(new Error('down'));
    const res = await request(buildApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.redis).toBe('down');
    expect(res.body.data.services).toHaveProperty('proxy');
  });
});
