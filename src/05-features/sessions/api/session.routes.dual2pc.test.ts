/**
 * session.routes.ts — DUAL_2PC 라우트 통합 테스트 (supertest)
 *
 * 검증 항목 (BE-1):
 *   - POST /:groupId/invite-operator — 유효 groupId → 201 + token/expiresAt
 *   - POST /:groupId/invite-operator — 세션 없음 → 404
 *   - POST /:groupId/invite-operator — 인증 없음 → 401
 *   - POST /join-as-operator — 유효 JWT → 소켓 인증 정보 포함 200
 *   - POST /join-as-operator — 만료 JWT → 401
 *   - POST /join-as-operator — 잘못된 서명 → 401
 */

import express from 'express';
import http from 'http';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { io as ioClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import {
  OPERATOR_SOCKET_TOKEN_TTL_SECONDS,
  OPERATOR_SOCKET_TOKEN_TYPE,
} from '@07-shared/constants/operator-socket-token';

// Session 모킹 — MongoDB 의존 제거함
jest.mock('@06-entities/sessions', () => ({
  Session: {
    find: jest.fn(),
    updateMany: jest.fn(),
  },
}));

// config 모킹
jest.mock('@07-shared/config/config', () => ({
  config: {
    jwtSecret: { secret: 'test-secret-key', expiresIn: '5m' },
    dataEngine: { secretKey: 'engine-secret' },
    dualPc: {
      timestampToleranceMs: 200,
      registrationTimeoutMs: 60000,
    },
  },
}));

jest.mock('@07-shared/lib/redis', () => ({
  redisService: {
    client: {
      publish: jest.fn(),
    },
    connect: jest.fn(() => Promise.resolve()),
  },
}));

// authenticate 모킹 — JWT 없이 req.user 주입
jest.mock('@07-shared/middlewares', () => {
  const actual = jest.requireActual('@07-shared/middlewares');
  return {
    ...actual,
    authenticate: (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction
    ) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return _res
          .status(401)
          .json({ status: 'fail', message: '인증이 필요합니다.' });
      }
      (req as any).user = { id: 'mock-operator-id' };
      next();
    },
  };
});

import { Session } from '@06-entities/sessions';
import { SocketService } from '@07-shared/lib/socket';
import sessionRouter from './session.routes';

const mockSession = Session as jest.Mocked<typeof Session>;

/** 테스트용 Express 앱 빌드 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionRouter);
  // 전역 에러 핸들러 — AppError statusCode 반영
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(err.statusCode || 500).json({
        status: err.status || 'error',
        message: err.message,
      });
    }
  );
  return app;
}

const app = buildApp();

/** 유효한 operator_invite JWT 생성 헬퍼 */
function makeInviteToken(groupId: string, opts?: jwt.SignOptions): string {
  return jwt.sign(
    { groupId, type: 'operator_invite' },
    'test-secret-key',
    opts ?? { expiresIn: '5m' }
  );
}

describe('[TS-SESSION-16] POST /api/sessions/:groupId/invite-operator (BE-1-invite)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('유효 groupId + 인증 + 소유권 → 201 + token + expiresAt 반환함', async () => {
    // Arrange
    // creatorId 를 요청자와 맞춤. 소유권 검증이 붙어(AUTH-W002) 세션을 만든
    // 운영자가 아니면 이 핸들러가 403 을 냄
    (mockSession.find as jest.Mock).mockResolvedValue([
      { groupId: 'grp-001', creatorId: 'mock-operator-id' },
    ]);
    (mockSession.updateMany as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });

    // Act
    const res = await request(app)
      .post('/api/sessions/grp-001/invite-operator')
      .set('Authorization', 'Bearer mock-user-token');

    // Assert
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data).toHaveProperty('expiresAt');
    expect(typeof res.body.data.token).toBe('string');
    expect(typeof res.body.data.expiresAt).toBe('number');
  });

  it('존재하지 않는 groupId → 404 반환함', async () => {
    // Arrange
    (mockSession.find as jest.Mock).mockResolvedValue([]);

    // Act
    const res = await request(app)
      .post('/api/sessions/nonexistent-group/invite-operator')
      .set('Authorization', 'Bearer mock-user-token');

    // Assert
    expect(res.status).toBe(404);
  });

  it('Authorization 헤더 없음 → 401 반환함', async () => {
    // Act — 인증 헤더 없이 요청
    const res = await request(app).post(
      '/api/sessions/grp-001/invite-operator'
    );

    // Assert
    expect(res.status).toBe(401);
  });

  it('그룹과 무관한 사용자 → 403 반환하고 세션을 변조하지 않음 (AUTH-W002)', async () => {
    // 이 핸들러는 조회가 아니라 updateMany 로 세션을 바꾼 뒤 invite 토큰을 냄.
    // 그 토큰이 무인증 join-as-operator 를 거쳐 운영자 권한이 되므로, 소유권을
    // 확인하지 않으면 아무 계정이나 남의 실험 운영자가 됨
    (mockSession.find as jest.Mock).mockResolvedValue([
      { groupId: 'grp-001', creatorId: 'someone-else', userId: 'subject-1' },
    ]);
    (mockSession.updateMany as jest.Mock).mockClear();

    const res = await request(app)
      .post('/api/sessions/grp-001/invite-operator')
      .set('Authorization', 'Bearer mock-user-token');

    expect(res.status).toBe(403);
    // 거부가 변조보다 먼저 일어나야 함
    expect(mockSession.updateMany as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('[TS-SESSION-16][TS-SESSION-17] POST /api/sessions/join-as-operator (BE-1-join)', () => {
  let socketHttpServer: http.Server;
  let socketServerUrl: string;

  beforeAll(async () => {
    socketHttpServer = http.createServer();
    SocketService.init(socketHttpServer);

    await new Promise<void>((resolve) => {
      socketHttpServer.listen(0, '127.0.0.1', resolve);
    });

    const address = socketHttpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('테스트 소켓 서버 주소를 확인할 수 없습니다.');
    }
    socketServerUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      SocketService.getIO().close(() => resolve());
    });

    if (socketHttpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        socketHttpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  function joinOperatorRoom(
    groupId: string,
    token: string
  ): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
      const client: ClientSocket = ioClient(socketServerUrl, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });

      client.once('connect_error', (error: Error) => {
        client.disconnect();
        reject(error);
      });
      client.once('connect', () => {
        client
          .timeout(2_000)
          .emit(
            'join-operator-room',
            { groupId, token },
            (error: Error | null, ack: { ok: boolean; error?: string }) => {
              client.disconnect();
              if (error) {
                reject(error);
                return;
              }
              resolve(ack);
            }
          );
      });
    });
  }

  it('유효 JWT → 소켓 인증 정보를 포함하고 실제 room 합류에 성공함', async () => {
    // Arrange
    const token = makeInviteToken('grp-001');
    (mockSession.find as jest.Mock).mockResolvedValue([{ groupId: 'grp-001' }]);

    // Act
    const res = await request(app)
      .post('/api/sessions/join-as-operator')
      .send({ token });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.groupId).toBe('grp-001');
    expect(res.body.data.experimentMode).toBe('DUAL_2PC');
    expect(typeof res.body.data.socketToken).toBe('string');
    expect(typeof res.body.data.socketTokenExpiresAt).toBe('number');

    const socketToken = res.body.data.socketToken;
    const decoded = jwt.verify(socketToken, 'test-secret-key');
    if (typeof decoded === 'string' || !decoded.exp || !decoded.iat) {
      throw new Error('소켓 토큰 claim을 확인할 수 없습니다.');
    }
    expect(decoded.groupId).toBe('grp-001');
    expect(decoded.type).toBe(OPERATOR_SOCKET_TOKEN_TYPE);
    expect(res.body.data.socketTokenExpiresAt).toBe(decoded.exp * 1000);
    expect(decoded.exp - decoded.iat).toBe(OPERATOR_SOCKET_TOKEN_TTL_SECONDS);

    await expect(joinOperatorRoom('grp-001', socketToken)).resolves.toEqual({
      ok: true,
    });
  });

  it('만료 토큰 → 401 반환함', async () => {
    // Arrange — 즉시 만료 토큰
    const expiredToken = jwt.sign(
      { groupId: 'grp-001', type: 'operator_invite' },
      'test-secret-key',
      { expiresIn: 0 }
    );

    // Act
    const res = await request(app)
      .post('/api/sessions/join-as-operator')
      .send({ token: expiredToken });

    // Assert
    expect(res.status).toBe(401);
  });

  it('잘못된 서명 → 401 반환함', async () => {
    // Arrange — 다른 시크릿으로 서명
    const wrongToken = jwt.sign(
      { groupId: 'grp-001', type: 'operator_invite' },
      'wrong-secret'
    );

    // Act
    const res = await request(app)
      .post('/api/sessions/join-as-operator')
      .send({ token: wrongToken });

    // Assert
    expect(res.status).toBe(401);
  });

  it('token 필드 누락 → 400 반환함', async () => {
    // Act
    const res = await request(app)
      .post('/api/sessions/join-as-operator')
      .send({});

    // Assert
    expect(res.status).toBe(400);
  });
});
