import http from 'http';
import jwt from 'jsonwebtoken';
import { io as ioClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { OPERATOR_SOCKET_TOKEN_TYPE } from '@07-shared/constants/operator-socket-token';

jest.mock('@07-shared/config/config', () => ({
  config: {
    jwtSecret: {
      secret: 'test-secret-key',
    },
    dataEngine: {
      secretKey: 'test-engine-secret',
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

import { operatorRoom, SocketService } from './socket';

type OperatorRoomAck = {
  ok: boolean;
  error?: string;
};

type JoinOperatorRoomResult = {
  ack: OperatorRoomAck;
  joinedOperatorRoom: boolean;
};

jest.setTimeout(10_000);

describe('SocketService join-operator-room 인증', () => {
  let httpServer: http.Server;
  let serverUrl: string;

  beforeAll(async () => {
    httpServer = http.createServer();
    SocketService.init(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', resolve);
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('테스트 소켓 서버 주소를 확인할 수 없습니다.');
    }
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      SocketService.getIO().close(() => resolve());
    });

    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  async function joinOperatorRoom(
    payload: { groupId?: string; token?: string } | string,
    expectedGroupId: string
  ): Promise<JoinOperatorRoomResult> {
    return new Promise((resolve, reject) => {
      const client: ClientSocket = ioClient(serverUrl, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });

      const fail = (error: Error) => {
        client.disconnect();
        reject(error);
      };

      client.once('connect_error', fail);
      client.once('connect', () => {
        client
          .timeout(2_000)
          .emit(
            'join-operator-room',
            payload,
            (error: Error | null, ack: OperatorRoomAck) => {
              if (error) {
                fail(error);
                return;
              }

              const serverSocket = SocketService.getIO().sockets.sockets.get(
                client.id ?? ''
              );
              const joinedOperatorRoom =
                serverSocket?.rooms.has(operatorRoom(expectedGroupId)) ?? false;

              client.disconnect();
              resolve({ ack, joinedOperatorRoom });
            }
          );
      });
    });
  }

  it('유효한 소켓 토큰과 일치하는 groupId로 합류함', async () => {
    const groupId = 'group-abc';
    const token = jwt.sign(
      { groupId, type: OPERATOR_SOCKET_TOKEN_TYPE },
      'test-secret-key',
      { expiresIn: '30m' }
    );

    const result = await joinOperatorRoom({ groupId, token }, groupId);

    expect(result.ack).toEqual({ ok: true });
    expect(result.joinedOperatorRoom).toBe(true);
  });

  it.each([
    ['operator_invite', { groupId: 'group-abc', type: 'operator_invite' }],
    ['타입 없는 로그인 JWT', { id: 'user-123' }],
  ])('%s 토큰을 unauthorized로 거부함', async (_label, claims) => {
    const groupId = 'group-abc';
    const token = jwt.sign(claims, 'test-secret-key', {
      expiresIn: '30m',
    });

    const result = await joinOperatorRoom({ groupId, token }, groupId);

    expect(result.ack).toEqual({ ok: false, error: 'unauthorized' });
    expect(result.joinedOperatorRoom).toBe(false);
  });

  it('토큰과 요청의 groupId가 다르면 unauthorized로 거부함', async () => {
    const requestedGroupId = 'group-requested';
    const token = jwt.sign(
      {
        groupId: 'group-claimed',
        type: OPERATOR_SOCKET_TOKEN_TYPE,
      },
      'test-secret-key',
      { expiresIn: '30m' }
    );

    const result = await joinOperatorRoom(
      { groupId: requestedGroupId, token },
      requestedGroupId
    );

    expect(result.ack).toEqual({ ok: false, error: 'unauthorized' });
    expect(result.joinedOperatorRoom).toBe(false);
  });

  it('문자열 페이로드를 unauthorized로 거부함', async () => {
    const groupId = 'group-abc';

    const result = await joinOperatorRoom(groupId, groupId);

    expect(result.ack).toEqual({ ok: false, error: 'unauthorized' });
    expect(result.joinedOperatorRoom).toBe(false);
  });

  it('만료된 소켓 토큰을 unauthorized로 거부함', async () => {
    const groupId = 'group-abc';
    const token = jwt.sign(
      { groupId, type: OPERATOR_SOCKET_TOKEN_TYPE },
      'test-secret-key',
      { expiresIn: -1 }
    );

    const result = await joinOperatorRoom({ groupId, token }, groupId);

    expect(result.ack).toEqual({ ok: false, error: 'unauthorized' });
    expect(result.joinedOperatorRoom).toBe(false);
  });
});
