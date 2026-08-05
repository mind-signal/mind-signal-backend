/**
 * chat.routes.ts — validate 미들웨어 Zod 스키마 검증 + 라우트 통합 테스트
 *
 * 검증 항목:
 *   - chatMessageSchema: message 필수, groupId 선택(ObjectId 정규식)
 *   - chatAskSchema: email 형식, message 필수
 *   - 유효하지 않은 입력 시 safeParse 실패함
 *   - validate 미들웨어가 POST / 및 POST /ask 라우트에 실제로 연결됨
 */

import express from 'express';
import request from 'supertest';
import { chatMessageSchema, chatAskSchema } from './chat.schema';
import { optionalAuthenticate, validate } from '@07-shared/middlewares';
import { handleChat, handleAskChat } from './chat.controller';

// chatService 모킹 — 외부 인프라(Gemini, MongoDB, SMTP) 의존 제거
jest.mock('../services/chat.service', () => ({
  chatService: {
    processMessage: jest
      .fn()
      .mockResolvedValue({ status: 'success', message: 'ok', url: '' }),
    sendInquiryEmail: jest
      .fn()
      .mockResolvedValue({ status: 'success', message: 'sent' }),
  },
}));

// 라우트 통합 테스트용 경량 Express 앱 생성
function buildChatApp() {
  const app = express();
  app.use(express.json());
  app.post('/', optionalAuthenticate, validate(chatMessageSchema), handleChat);
  app.post('/ask', validate(chatAskSchema), handleAskChat);
  return app;
}

describe('[TS-CHAT-03] chatMessageSchema 검증', () => {
  it('message 있으면 검증 통과함', () => {
    const result = chatMessageSchema.safeParse({
      message: '소개 어디서 봐요?',
    });
    expect(result.success).toBe(true);
  });

  it('message와 groupId(ObjectId) 함께 있으면 검증 통과함', () => {
    const result = chatMessageSchema.safeParse({
      message: '소개 어디서 봐요?',
      groupId: '507f1f77bcf86cd799439011',
    });
    expect(result.success).toBe(true);
  });

  it('message 빈 문자열이면 검증 실패함', () => {
    const result = chatMessageSchema.safeParse({ message: '' });
    expect(result.success).toBe(false);
  });

  it('message 누락 시 검증 실패함', () => {
    const result = chatMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('message 1000자 초과 시 검증 실패함', () => {
    const result = chatMessageSchema.safeParse({ message: 'a'.repeat(1001) });
    expect(result.success).toBe(false);
  });

  it('groupId가 ObjectId 형식이 아니면 검증 실패함', () => {
    const result = chatMessageSchema.safeParse({
      message: '안녕',
      groupId: 'not-an-objectid',
    });
    expect(result.success).toBe(false);
  });
});

describe('chatAskSchema 검증', () => {
  it('email, message 모두 유효하면 검증 통과함', () => {
    const result = chatAskSchema.safeParse({
      email: 'user@example.com',
      message: '문의드립니다.',
    });
    expect(result.success).toBe(true);
  });

  it('email 형식 잘못되면 검증 실패함', () => {
    const result = chatAskSchema.safeParse({
      email: 'not-an-email',
      message: '문의드립니다.',
    });
    expect(result.success).toBe(false);
  });

  it('message 빈 문자열이면 검증 실패함', () => {
    const result = chatAskSchema.safeParse({
      email: 'user@example.com',
      message: '',
    });
    expect(result.success).toBe(false);
  });

  it('message 2000자 초과 시 검증 실패함', () => {
    const result = chatAskSchema.safeParse({
      email: 'user@example.com',
      message: 'a'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it('email 누락 시 검증 실패함', () => {
    const result = chatAskSchema.safeParse({ message: '문의드립니다.' });
    expect(result.success).toBe(false);
  });

  it('message 누락 시 검증 실패함', () => {
    const result = chatAskSchema.safeParse({ email: 'user@example.com' });
    expect(result.success).toBe(false);
  });
});

describe('[TS-CHAT-01] POST / — validate 미들웨어 라우트 통합', () => {
  const app = buildChatApp();

  it('유효한 message 전송 시 200 반환함', async () => {
    const res = await request(app)
      .post('/')
      .send({ message: '소개 어디서 봐요?' });
    expect(res.status).toBe(200);
  });

  it('message 누락 시 400 반환함 (validate 미들웨어 체인 확인)', async () => {
    const res = await request(app).post('/').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /ask — validate 미들웨어 라우트 통합', () => {
  const app = buildChatApp();

  it('유효한 email, message 전송 시 200 반환함', async () => {
    const res = await request(app)
      .post('/ask')
      .send({ email: 'user@example.com', message: '문의드립니다.' });
    expect(res.status).toBe(200);
  });

  it('email 누락 시 400 반환함 (validate 미들웨어 체인 확인)', async () => {
    const res = await request(app)
      .post('/ask')
      .send({ message: '문의드립니다.' });
    expect(res.status).toBe(400);
  });
});
