/**
 * socket.repro-proxy-namespace.test.ts
 *
 * Phase 18.1 MVP handler 회귀 박제 테스트함.
 * mind-signal-proxy의 be-forwarder가 BE `/proxy` namespace에 ENGINE_SECRET
 * 핸드셰이크로 connect 시도하나 namespace handler 미등록으로 `Invalid namespace`
 * retry 누적되던 blocker (HANDOFF 1-6절) 해소 검증함.
 *
 * Scenario A (happy) - 정확한 engineSecret으로 connect 성공함
 * Scenario B (regression sentinel) - 잘못된 secret 거부함
 * Scenario C (regression sentinel) - secret 미전송 거부함
 * Scenario D - proxy:sample 이벤트는 not_implemented ack 반환함 (MVP stub)
 * Scenario E - 기본 namespace join-room 동작 영향 없음
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

import { SocketService } from './socket';

jest.setTimeout(10_000);

describe('SocketService /proxy namespace MVP handler (Phase 18.1)', () => {
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

  it('Scenario D: proxy:sample 이벤트는 not_implemented ack 반환함 (MVP stub)', (done) => {
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
                error: 'not_implemented',
              });
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
});
