import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { config } from '@07-shared/config/config';

/**
 * Socket.io 서버 관리 유틸리티
 */
export class SocketService {
  private static io: Server;

  /**
   * HTTP 서버와 Socket.io를 연결하여 초기화
   * @param {HttpServer} server - Express 서버 객체
   */
  public static init(server: HttpServer): Server {
    this.io = new Server(server, {
      cors: {
        origin: '*', // 보안을 위해 운영 환경에서는 특정 도메인으로 제한 필요
        methods: ['GET', 'POST'],
      },
    });

    this.io.on('connection', (socket: Socket) => {
      console.log(`New client connected: ${socket.id}`);

      // 신규 — room join 핸들러 + ack 반환 (Phase 16 plan-review H-2 + v2 Medium 반영)
      socket.on(
        'join-room',
        (
          groupId: string,
          ack?: (response: {
            ok: boolean;
            groupId?: string;
            error?: string;
          }) => void
        ) => {
          if (typeof groupId !== 'string' || groupId.length === 0) {
            ack?.({ ok: false, error: 'invalid groupId' });
            return;
          }
          socket.join(groupId);
          console.log(`Socket ${socket.id} joined room ${groupId}`);
          ack?.({ ok: true, groupId });
        }
      );

      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
      });
    });

    // Phase 18.1 MVP - mind-signal-proxy의 be-forwarder 핸드셰이크 수용 처리함
    this._initProxyNamespace();

    return this.io;
  }

  /**
   * /proxy namespace handler 등록함.
   *
   * mind-signal-proxy의 `be-forwarder`가 ENGINE_SECRET 핸드셰이크로 connect 시도함
   * (`be-forwarder.ts` `auth: { engineSecret }`).
   * 현재 MVP 단계는 auth 검증만 활성화하고 `proxy:sample` 이벤트는
   * `{ok:false, retryable:false, error:'not_implemented'}` ack 반환함.
   * 후속 Phase 18.2에서 envelope 검증/persist/dedup 로직 구현 예정.
   *
   * @throws Error('invalid_engine_secret') 핸드셰이크 secret 미일치 시 발생
   */
  private static _initProxyNamespace(): void {
    const nsp = this.io.of('/proxy');

    // auth 핸드셰이크 - engineSecret 일치 검증함
    nsp.use((socket, next) => {
      const handshakeSecret = socket.handshake.auth?.engineSecret;
      if (typeof handshakeSecret !== 'string' || handshakeSecret.length === 0) {
        next(new Error('invalid_engine_secret'));
        return;
      }
      if (handshakeSecret !== config.dataEngine.secretKey) {
        next(new Error('invalid_engine_secret'));
        return;
      }
      next();
    });

    nsp.on('connection', (socket: Socket) => {
      console.log(`[/proxy] connected: ${socket.id}`);

      // proxy:sample 이벤트 - Phase 18.1 MVP는 persist 미구현 상태로 drop 반환함
      socket.on(
        'proxy:sample',
        (
          _envelope: unknown,
          ack?: (response: {
            ok: boolean;
            retryable?: boolean;
            error?: string;
          }) => void
        ) => {
          ack?.({
            ok: false,
            retryable: false,
            error: 'not_implemented',
          });
        }
      );

      socket.on('disconnect', () => {
        console.log(`[/proxy] disconnected: ${socket.id}`);
      });
    });
  }

  /**
   * 초기화된 Socket.io 인스턴스 반환
   * @throws {Error} 초기화되지 않았을 경우 에러 발생
   */
  public static getIO(): Server {
    if (!this.io) {
      throw new Error('Socket.io has not been initialized');
    }
    return this.io;
  }

  /**
   * 실시간 EEG 데이터를 프론트엔드로 전송
   * @param {string} event - 이벤트 명 (기본값: 'eeg-live')
   * @param {any} data - 전송할 뇌파 데이터 객체
   */
  public static emitLiveEvent(event: string = 'eeg-live', data: unknown): void {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  /**
   * 특정 groupId room에 이벤트 브로드캐스트 (Phase 16 DUAL_2PC 전용)
   * @param {string} groupId - 대상 room 식별자
   * @param {string} event - 이벤트 명
   * @param {unknown} data - 전송할 데이터 객체
   */
  public static emitToGroup(
    groupId: string,
    event: string,
    data: unknown
  ): void {
    if (this.io) {
      this.io.to(groupId).emit(event, data);
    }
  }
}
