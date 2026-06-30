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
