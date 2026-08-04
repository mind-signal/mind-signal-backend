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

import { SocketService } from './socket';

type JoinRoomAck = {
  ok: boolean;
  groupId?: string;
  error?: string;
};

type JoinRoomResult = {
  ack: JoinRoomAck;
  joinedRoom: boolean;
};

jest.setTimeout(10_000);

/**
 * AUTH-W001 회귀 방어.
 *
 * `join-room` 은 원래 groupId 가 빈 문자열인지만 보고 통과시켰음. 이 room 으로
 * `aligned_pair`(정렬된 원시 EEG)와 `stimulus_start`와 `measurement-complete`가
 * 나가므로, 무인증이면 groupId 만 아는 누구나 타인의 측정 뇌파를 실시간으로 받음.
 *
 * 이 스위트를 지우거나 약화시키면 그 구멍이 조용히 되돌아옴.
 */
describe('SocketService join-room 인증 (AUTH-W001)', () => {
  let httpServer: http.Server;
  let serverUrl: string;

  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  async function joinRoom(
    payload: { groupId?: string; token?: string } | string,
    expectedGroupId: string
  ): Promise<JoinRoomResult> {
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
            'join-room',
            payload,
            (error: Error | null, ack: JoinRoomAck) => {
              if (error) {
                fail(error);
                return;
              }

              const serverSocket = SocketService.getIO().sockets.sockets.get(
                client.id ?? ''
              );
              const joinedRoom =
                serverSocket?.rooms.has(expectedGroupId) ?? false;

              client.disconnect();
              resolve({ ack, joinedRoom });
            }
          );
      });
    });
  }

  it('유효한 로그인 토큰으로 합류함', async () => {
    const groupId = 'group-abc';
    const token = jwt.sign({ id: 'user-123' }, 'test-secret-key', {
      expiresIn: '30m',
    });

    const result = await joinRoom({ groupId, token }, groupId);

    expect(result.ack).toEqual({ ok: true, groupId });
    expect(result.joinedRoom).toBe(true);
  });

  it('토큰 없는 페이로드를 unauthorized로 거부함', async () => {
    const groupId = 'group-abc';

    const result = await joinRoom({ groupId }, groupId);

    expect(result.ack).toEqual({ ok: false, error: 'unauthorized' });
    expect(result.joinedRoom).toBe(false);
  });

  it('문자열 페이로드를 unauthorized로 거부함 (구 호출 규약)', async () => {
    // 고치기 전 프론트가 보내던 형태임. 토큰이 없으므로 거부돼야 함
    const groupId = 'group-abc';

    const result = await joinRoom(groupId, groupId);

    expect(result.ack).toEqual({ ok: false, error: 'unauthorized' });
    expect(result.joinedRoom).toBe(false);
  });

  it('서명이 다른 토큰을 unauthorized로 거부함', async () => {
    const groupId = 'group-abc';
    const token = jwt.sign({ id: 'user-123' }, 'another-secret', {
      expiresIn: '30m',
    });

    const result = await joinRoom({ groupId, token }, groupId);

    expect(result.ack).toEqual({ ok: false, error: 'unauthorized' });
    expect(result.joinedRoom).toBe(false);
  });

  it('만료된 토큰을 unauthorized로 거부함', async () => {
    const groupId = 'group-abc';
    const token = jwt.sign({ id: 'user-123' }, 'test-secret-key', {
      expiresIn: -1,
    });

    const result = await joinRoom({ groupId, token }, groupId);

    expect(result.ack).toEqual({ ok: false, error: 'unauthorized' });
    expect(result.joinedRoom).toBe(false);
  });

  it('id 없는 토큰을 unauthorized로 거부함', async () => {
    // 운영자 소켓 토큰은 id 대신 groupId 와 type 을 담음. 그것으로는
    // 피실험자 room 에 들어올 수 없어야 함
    const groupId = 'group-abc';
    const token = jwt.sign(
      { groupId, type: OPERATOR_SOCKET_TOKEN_TYPE },
      'test-secret-key',
      { expiresIn: '30m' }
    );

    const result = await joinRoom({ groupId, token }, groupId);

    expect(result.ack).toEqual({ ok: false, error: 'unauthorized' });
    expect(result.joinedRoom).toBe(false);
  });

  it('groupId가 빈 문자열이면 invalid groupId로 거부함', async () => {
    const token = jwt.sign({ id: 'user-123' }, 'test-secret-key', {
      expiresIn: '30m',
    });

    const result = await joinRoom({ groupId: '', token }, '');

    expect(result.ack).toEqual({ ok: false, error: 'invalid groupId' });
  });
});

/**
 * 전역 브로드캐스트 회귀 방어.
 *
 * `emitLiveEvent` 는 `io.emit` 이라 room 구분이 없음. room 가입조차 없이 접속만
 * 하면 받으므로, 측정 이벤트 발행에 이것을 다시 쓰면 안 됨.
 */
describe('SocketService 브로드캐스트 경계 (AUTH-W001)', () => {
  let httpServer: http.Server;
  let serverUrl: string;

  // 이 describe 의 SocketService.init 도 mock 된 redisService 를 건드리므로
  // 앞 describe 의 호출 이력을 물고 시작하지 않도록 초기화함
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it('합류한 소켓만 emitToGroup 이벤트를 받음', async () => {
    // 미수신만 확인하면 emitToGroup 이 아무에게도 안 보내거나 엉뚱한 room 을
    // 골라도 통과함. 대상 room 의 정상 수신을 함께 봐야 판정이 성립함
    const groupId = 'group-secret';
    const payload = { data: { focus: 1 } };

    const member: ClientSocket = ioClient(serverUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    const outsider: ClientSocket = ioClient(serverUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });

    try {
      await Promise.all(
        [member, outsider].map(
          (c) =>
            new Promise<void>((resolve, reject) => {
              c.once('connect', () => resolve());
              c.once('connect_error', reject);
            })
        )
      );

      const token = jwt.sign({ id: 'user-123' }, 'test-secret-key', {
        expiresIn: '30m',
      });
      await new Promise<void>((resolve, reject) => {
        member
          .timeout(2_000)
          .emit(
            'join-room',
            { groupId, token },
            (error: Error | null, ack: { ok: boolean }) => {
              if (error || !ack.ok) {
                reject(error ?? new Error('join 실패'));
                return;
              }
              resolve();
            }
          );
      });

      const memberReceived: unknown[] = [];
      const outsiderReceived: unknown[] = [];
      member.on('eeg-live', (data: unknown) => memberReceived.push(data));
      outsider.on('eeg-live', (data: unknown) => outsiderReceived.push(data));

      SocketService.emitToGroup(groupId, 'eeg-live', payload);

      // 소켓 왕복 시간을 줌
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(memberReceived).toEqual([payload]);
      expect(outsiderReceived).toEqual([]);
    } finally {
      member.disconnect();
      outsider.disconnect();
    }
  });
});
