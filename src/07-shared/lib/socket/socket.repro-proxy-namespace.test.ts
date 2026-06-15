/* eslint-disable camelcase */
/**
 * socket.repro-proxy-namespace.test.ts
 *
 * Phase 18.1 핸드셰이크 + Phase 18.2 envelope persist 회귀 박제 테스트함.
 * mind-signal-proxy의 be-forwarder가 BE `/proxy` namespace에 ENGINE_SECRET
 * 핸드셰이크로 connect하고 `proxy:sample` envelope을 송신하는 경로를 검증함.
 *
 * Scenario A (happy) - 정확한 engineSecret으로 connect 성공함
 * Scenario B (regression sentinel) - 잘못된 secret 거부함
 * Scenario C (regression sentinel) - secret 미전송 거부함
 * Scenario D - 유효 envelope은 Redis publish 후 {ok:true} 반환함 (Phase 18.2)
 * Scenario E - 기본 namespace join-room 동작 영향 없음
 * Scenario F - 비정상 envelope은 invalid_frame non-retryable 반환 + publish 미호출함
 * Scenario G - 범위 밖 subject_idx(3+)는 invalid_frame 거부 + publish 미호출함
 */

import http from 'http';
import { AddressInfo } from 'net';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

jest.mock('@07-shared/config/config', () => ({
  config: {
    dataEngine: {
      secretKey: 'test-engine-secret-abc123',
    },
  },
}));

// redis는 mock - 팩토리 내부에서 jest.fn 생성(외부 const 미참조로 TDZ 차단), import로 참조 회수함
jest.mock('@07-shared/lib/redis', () => ({
  redisService: {
    client: { publish: jest.fn() },
    connect: jest.fn(() => Promise.resolve()),
  },
}));

import { redisService } from '@07-shared/lib/redis';
import { SocketService } from './socket';

const mockPublish = jest.mocked(redisService.client.publish);

jest.setTimeout(10_000);

describe('SocketService /proxy namespace handler (Phase 18.1 + 18.2)', () => {
  let httpServer: http.Server;
  let serverUrl: string;

  beforeAll((done) => {
    httpServer = http.createServer();
    SocketService.init(httpServer);
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address() as AddressInfo;
      serverUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  beforeEach(() => {
    // 시나리오 간 mock 호출 이력 누수 방지함
    jest.clearAllMocks();
  });

  afterAll((done) => {
    SocketService.getIO().close(() => {
      httpServer.close(() => done());
    });
  });

  it('Scenario A: 정확한 engineSecret으로 /proxy namespace connect 성공함', (done) => {
    const client: ClientSocket = ioClient(`${serverUrl}/proxy`, {
      transports: ['websocket'],
      auth: { engineSecret: 'test-engine-secret-abc123' },
      forceNew: true,
      reconnection: false,
    });

    client.once('connect', () => {
      expect(client.connected).toBe(true);
      client.disconnect();
      done();
    });

    client.once('connect_error', (err: Error) => {
      done(new Error(`unexpected connect_error: ${err.message}`));
    });
  });

  it('Scenario B: 잘못된 engineSecret으로 connect_error invalid_engine_secret 반환함', (done) => {
    const client: ClientSocket = ioClient(`${serverUrl}/proxy`, {
      transports: ['websocket'],
      auth: { engineSecret: 'wrong-secret' },
      forceNew: true,
      reconnection: false,
    });

    client.once('connect', () => {
      client.disconnect();
      done(new Error('unexpected connect succeeded with wrong secret'));
    });

    client.once('connect_error', (err: Error) => {
      expect(err.message).toBe('invalid_engine_secret');
      done();
    });
  });

  it('Scenario C: engineSecret 미전송 시 connect_error invalid_engine_secret 반환함', (done) => {
    const client: ClientSocket = ioClient(`${serverUrl}/proxy`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });

    client.once('connect', () => {
      client.disconnect();
      done(new Error('unexpected connect succeeded without secret'));
    });

    client.once('connect_error', (err: Error) => {
      expect(err.message).toBe('invalid_engine_secret');
      done();
    });
  });

  it('Scenario D: 유효 envelope은 Redis publish 후 {ok:true} 반환함 (Phase 18.2)', (done) => {
    mockPublish.mockResolvedValue(1);
    const client: ClientSocket = ioClient(`${serverUrl}/proxy`, {
      transports: ['websocket'],
      auth: { engineSecret: 'test-engine-secret-abc123' },
      forceNew: true,
      reconnection: false,
    });
    const envelope = {
      group_id: 'g-abc',
      subject_idx: 2,
      payload: { delta: 1, theta: 2, alpha: 3, beta: 4, gamma: 5 },
    };

    client.once('connect', () => {
      client
        .timeout(2_000)
        .emit(
          'proxy:sample',
          envelope,
          (
            err: Error | null,
            ack: { ok: boolean; retryable?: boolean; error?: string }
          ) => {
            try {
              expect(err).toBeNull();
              expect(ack).toEqual({ ok: true });
              // 채널 키(계약 A) + 메시지 형태(계약 B) 동시 검증
              expect(mockPublish).toHaveBeenCalledWith(
                'mind-signal:g-abc:subject:2',
                JSON.stringify({
                  type: 'brain_sync_all',
                  waves: { delta: 1, theta: 2, alpha: 3, beta: 4, gamma: 5 },
                })
              );
              client.disconnect();
              done();
            } catch (e) {
              client.disconnect();
              done(e as Error);
            }
          }
        );
    });

    client.once('connect_error', (err: Error) => {
      done(new Error(`unexpected connect_error: ${err.message}`));
    });
  });

  it('Scenario E: 기본 namespace의 join-room은 변경 없이 정상 동작함', (done) => {
    const client: ClientSocket = ioClient(serverUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });

    client.once('connect', () => {
      client.emit(
        'join-room',
        'test-group-id',
        (ack: { ok: boolean; groupId?: string; error?: string }) => {
          try {
            expect(ack).toEqual({ ok: true, groupId: 'test-group-id' });
            client.disconnect();
            done();
          } catch (e) {
            client.disconnect();
            done(e as Error);
          }
        }
      );
    });

    client.once('connect_error', (err: Error) => {
      done(new Error(`unexpected connect_error: ${err.message}`));
    });
  });

  it('Scenario F: 비정상 envelope은 invalid_frame non-retryable 반환 + publish 미호출함', (done) => {
    const client: ClientSocket = ioClient(`${serverUrl}/proxy`, {
      transports: ['websocket'],
      auth: { engineSecret: 'test-engine-secret-abc123' },
      forceNew: true,
      reconnection: false,
    });

    client.once('connect', () => {
      client
        .timeout(2_000)
        .emit(
          'proxy:sample',
          { dummy: 'envelope' },
          (
            err: Error | null,
            ack: { ok: boolean; retryable?: boolean; error?: string }
          ) => {
            try {
              expect(err).toBeNull();
              expect(ack).toEqual({
                ok: false,
                retryable: false,
                error: 'invalid_frame',
              });
              expect(mockPublish).not.toHaveBeenCalled();
              client.disconnect();
              done();
            } catch (e) {
              client.disconnect();
              done(e as Error);
            }
          }
        );
    });

    client.once('connect_error', (err: Error) => {
      done(new Error(`unexpected connect_error: ${err.message}`));
    });
  });

  it('Scenario G: 범위 밖 subject_idx는 invalid_frame 거부 + publish 미호출함', (done) => {
    const client: ClientSocket = ioClient(`${serverUrl}/proxy`, {
      transports: ['websocket'],
      auth: { engineSecret: 'test-engine-secret-abc123' },
      forceNew: true,
      reconnection: false,
    });
    // subject_idx 3은 구독자 없는 채널이라 silent drop 위험 - 검증 단계에서 거부해야 함
    const envelope = {
      group_id: 'g-abc',
      subject_idx: 3,
      payload: { delta: 1, theta: 2, alpha: 3, beta: 4, gamma: 5 },
    };

    client.once('connect', () => {
      client
        .timeout(2_000)
        .emit(
          'proxy:sample',
          envelope,
          (
            err: Error | null,
            ack: { ok: boolean; retryable?: boolean; error?: string }
          ) => {
            try {
              expect(err).toBeNull();
              expect(ack).toEqual({
                ok: false,
                retryable: false,
                error: 'invalid_frame',
              });
              expect(mockPublish).not.toHaveBeenCalled();
              client.disconnect();
              done();
            } catch (e) {
              client.disconnect();
              done(e as Error);
            }
          }
        );
    });

    client.once('connect_error', (err: Error) => {
      done(new Error(`unexpected connect_error: ${err.message}`));
    });
  });
});
