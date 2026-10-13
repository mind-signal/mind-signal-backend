/* eslint-disable camelcase */
/**
 * socket.proxy-status.test.ts
 *
 * `/proxy` namespace의 `proxy:status` 핸들러와 MESSAGE_BUS=memory 전달 경로 검증함.
 * redis 모듈은 mock하되 redisService는 실제 구현을 써서, 프록시가 보낸 이벤트가
 * Redis 연결 없이 채널 구독자까지 도달하는지 확인함.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

const mockCreateClient = jest.fn();
jest.mock('redis', () => ({ createClient: mockCreateClient }));

jest.mock('@07-shared/config/config', () => ({
  config: {
    messageBus: 'memory',
    dataEngine: { secretKey: 'test-engine-secret-abc123' },
    jwtSecret: { secret: 'test-secret-key' },
  },
}));

import { redisService } from '@07-shared/lib/redis';
import { SocketService } from './socket';

type Ack = { ok: boolean; retryable?: boolean; error?: string };

jest.setTimeout(10_000);

describe('SocketService /proxy proxy:status (MESSAGE_BUS=memory)', () => {
  let httpServer: http.Server;
  let client: ClientSocket;
  let received: Array<{ channel: string; message: unknown }>;
  const subscriber = redisService.client.duplicate();

  beforeAll(async () => {
    httpServer = http.createServer();
    SocketService.init(httpServer);
    await new Promise<void>((resolve) =>
      httpServer.listen(0, '127.0.0.1', resolve)
    );
    const { port } = httpServer.address() as AddressInfo;
    await subscriber.pSubscribe(
      'mind-signal:*',
      (message: string, channel: string) => {
        received.push({ channel, message: JSON.parse(message) });
      }
    );
    client = ioClient(`http://127.0.0.1:${port}/proxy`, {
      transports: ['websocket'],
      auth: { engineSecret: 'test-engine-secret-abc123' },
      forceNew: true,
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', reject);
    });
  });

  beforeEach(() => {
    received = [];
  });

  afterAll(async () => {
    client.disconnect();
    await subscriber.quit();
    await new Promise<void>((resolve) => {
      SocketService.getIO().close(() => httpServer.close(() => resolve()));
    });
  });

  const send = (event: string, envelope: unknown): Promise<Ack> =>
    client.timeout(2_000).emitWithAck(event, envelope);

  it('정상 입력은 headset_status를 채널에 싣고 {ok:true} 반환함', async () => {
    const ack = await send('proxy:status', {
      group_id: 'g-abc',
      subject_idx: 2,
      status: 'disconnected',
      silent_seconds: 12.5,
    });

    expect(ack).toEqual({ ok: true });
    expect(received).toEqual([
      {
        channel: 'mind-signal:g-abc:subject:2',
        message: {
          type: 'headset_status',
          status: 'disconnected',
          subjectIndex: 2,
          groupId: 'g-abc',
          silentSeconds: 12.5,
        },
      },
    ]);
  });

  it('silent_seconds가 없으면 silentSeconds 키를 넣지 않음', async () => {
    const ack = await send('proxy:status', {
      group_id: 'g-abc',
      subject_idx: 1,
      status: 'stale',
    });

    expect(ack).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe('mind-signal:g-abc:subject:1');
    expect(received[0].message).toEqual({
      type: 'headset_status',
      status: 'stale',
      subjectIndex: 1,
      groupId: 'g-abc',
    });
    expect(received[0].message).not.toHaveProperty('silentSeconds');
  });

  it.each([
    ['status 누락', { group_id: 'g-abc', subject_idx: 1 }],
    ['범위 밖 subject_idx', { group_id: 'g-abc', subject_idx: 3, status: 's' }],
    ['빈 group_id', { group_id: '', subject_idx: 1, status: 's' }],
    [
      '숫자가 아닌 silent_seconds',
      { group_id: 'g-abc', subject_idx: 1, status: 's', silent_seconds: '3' },
    ],
  ])(
    '잘못된 입력(%s)은 invalid_frame으로 거부하고 publish하지 않음',
    async (_name, envelope) => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const ack = await send('proxy:status', envelope);

      expect(ack).toEqual({
        ok: false,
        retryable: false,
        error: 'invalid_frame',
      });
      expect(received).toEqual([]);
      warnSpy.mockRestore();
    }
  );

  it('proxy:sample도 메모리 버스로 구독자에게 전달됨', async () => {
    const ack = await send('proxy:sample', {
      group_id: 'g-abc',
      subject_idx: 2,
      payload: { delta: 1, theta: 2, alpha: 3, beta: 4, gamma: 5 },
    });

    expect(ack).toEqual({ ok: true });
    expect(received).toEqual([
      {
        channel: 'mind-signal:g-abc:subject:2',
        message: {
          type: 'brain_sync_all',
          waves: { delta: 1, theta: 2, alpha: 3, beta: 4, gamma: 5 },
        },
      },
    ]);
  });

  it('전 과정에서 Redis 클라이언트를 만들지 않음', () => {
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
