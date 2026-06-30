import express from 'express';
import request from 'supertest';
import { registerStatic } from './static';

it('registerStatic 적용 후 GET /dashboard.html은 200 html을 반환함', async () => {
  const app = express();
  registerStatic(app);
  const res = await request(app).get('/dashboard.html');
  expect(res.status).toBe(200);
  expect(res.type).toMatch(/html/);
});

it('없는 정적 파일 요청은 404를 반환함', async () => {
  const app = express();
  registerStatic(app);
  const res = await request(app).get('/__missing__.html');
  expect(res.status).toBe(404);
});
