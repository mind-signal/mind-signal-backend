import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';
import { config } from '@07-shared/config/config';
import { OPERATOR_SOCKET_TOKEN_TYPE } from '@07-shared/constants/operator-socket-token';
import { redisService } from '@07-shared/lib/redis';
import { ProxySampleSchema, ProxyStatusSchema } from './proxy-envelope.schema';

/**
 * /proxy 수신 요약을 남기는 주기(ms).
 *
 * 샘플은 subject당 1Hz라 샘플마다 찍으면 로그가 못 쓰게 커진다. 필요한 것은
 * "이 subject가 지금도 들어오고 있나"이므로 창 단위 집계로 충분하다.
 */
const PROXY_SUMMARY_INTERVAL_MS = 10_000;

/**
 * 운영자 전용 room 이름 생성함.
 * 피실험자가 합류하는 `{groupId}` room과 분리해 경보 전송 경계를 만듦.
 *
 * @param groupId - 실험 그룹 식별자임
 * @returns 운영자 room 이름 반환
 */
export function operatorRoom(groupId: string): string {
  return `${groupId}:operator`;
}

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
      //
      // 로그인 JWT를 요구함 (AUTH-W001). 이 room으로 aligned_pair(정렬된 원시 EEG)와
      // stimulus_start와 measurement-complete가 나가므로, 무인증이면 groupId만 아는
      // 누구나 타인의 측정 뇌파를 실시간으로 받음. groupId는 QR과 대시보드에서
      // 평문으로 다루는 값이라 획득 난이도가 방어가 되지 못함.
      //
      // 검증 범위는 토큰 유효성까지임. "이 사용자가 그 그룹의 참여자인가"는
      // AUTH-W002의 소유권 검증 계층에서 함께 넣음 — 계약을 두 번 바꾸지 않기 위함.
      socket.on(
        'join-room',
        (
          payload: { groupId?: string; token?: string } | string,
          ack?: (response: {
            ok: boolean;
            groupId?: string;
            error?: string;
          }) => void
        ) => {
          const groupId =
            typeof payload === 'string' ? payload : payload?.groupId;
          const token =
            typeof payload === 'string' ? undefined : payload?.token;

          if (typeof groupId !== 'string' || groupId.length === 0) {
            ack?.({ ok: false, error: 'invalid groupId' });
            return;
          }
          if (!token) {
            ack?.({ ok: false, error: 'unauthorized' });
            return;
          }
          try {
            const verifiedPayload = jwt.verify(token, config.jwtSecret.secret);
            // 로그인 토큰만 통과시킴. 문자열 payload와 id 없는 토큰은 거부함
            if (
              typeof verifiedPayload === 'string' ||
              typeof verifiedPayload.id !== 'string'
            ) {
              ack?.({ ok: false, error: 'unauthorized' });
              return;
            }
          } catch {
            ack?.({ ok: false, error: 'unauthorized' });
            return;
          }

          socket.join(groupId);
          console.log(`Socket ${socket.id} joined room ${groupId}`);
          ack?.({ ok: true, groupId });
        }
      );

      // 운영자 전용 room join. 스트림 건강 경보는 이 room으로만 emit함.
      // 피실험자 소켓은 합류하지 않으므로 경보가 도달하지 않음 —
      // 측정 대상 신호에 stress 지표가 포함되어(streamer.py MET 6종),
      // 경고로 유발된 불안이 종속변수를 직접 오염시키기 때문임.
      //
      // JWT를 요구함. 무인증이면 피실험자 브라우저가 이벤트명만 알아도
      // 합류해 경보를 관측할 수 있어 위 격리가 무의미해짐 (CodeRabbit PR #74).
      socket.on(
        'join-operator-room',
        (
          payload: { groupId?: string; token?: string } | string,
          ack?: (response: { ok: boolean; error?: string }) => void
        ) => {
          const groupId =
            typeof payload === 'string' ? payload : payload?.groupId;
          const token =
            typeof payload === 'string' ? undefined : payload?.token;

          if (typeof groupId !== 'string' || groupId.length === 0) {
            ack?.({ ok: false, error: 'invalid groupId' });
            return;
          }
          if (!token) {
            ack?.({ ok: false, error: 'unauthorized' });
            return;
          }
          try {
            const verifiedPayload = jwt.verify(token, config.jwtSecret.secret);
            if (
              typeof verifiedPayload === 'string' ||
              verifiedPayload.type !== OPERATOR_SOCKET_TOKEN_TYPE ||
              verifiedPayload.groupId !== groupId
            ) {
              ack?.({ ok: false, error: 'unauthorized' });
              return;
            }
          } catch {
            ack?.({ ok: false, error: 'unauthorized' });
            return;
          }

          socket.join(operatorRoom(groupId));
          console.log(`Socket ${socket.id} joined operator room ${groupId}`);
          ack?.({ ok: true });
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
   * auth 검증 후 `proxy:sample` 이벤트는 envelope을 검증하여 Redis로 publish함으로써
   * 기존 `subscribeWithAligner` 소비 경로에 합류시킴 (Phase 18.2).
   *
   * @throws Error('invalid_engine_secret') 핸드셰이크 secret 미일치 시 발생
   */
  private static _initProxyNamespace(): void {
    const nsp = this.io.of('/proxy');

    // proxy:sample은 공유 redis client로 publish함. app 시작 시 이 client는 연결되지
    // 않으므로(subscribe 경로는 전부 client.duplicate() 경유) 여기서 연결을 보장함.
    // 실패해도 핸들러 try/catch가 retryable ack로 처리해 be-forwarder가 재시도함.
    void redisService.connect().catch((err) => {
      console.error('[/proxy] redis 연결 실패:', err);
    });

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
      // 이 소켓이 이번 창에서 받은 것과 publish한 채널을 subject별로 센다.
      // 2026-09-03에 subject 1이 화면에서 사라졌을 때 여기에 로그가 없어
      // "프록시가 안 보냈나 / BE가 안 받았나 / 아무도 안 듣는 채널에 실었나"를
      // 가르지 못했다. 특히 채널명은 group_id 불일치를 드러내는 유일한 단서다.
      const window = new Map<
        number,
        {
          received: number;
          published: number;
          invalid: number;
          channels: Set<string>;
        }
      >();
      const tallyFor = (subjectIndex: number) => {
        let t = window.get(subjectIndex);
        if (!t) {
          t = {
            received: 0,
            published: 0,
            invalid: 0,
            channels: new Set<string>(),
          };
          window.set(subjectIndex, t);
        }
        return t;
      };
      const summaryTimer = setInterval(() => {
        if (window.size === 0) return;
        for (const [subjectIndex, t] of [...window.entries()].sort(
          (a, b) => a[0] - b[0]
        )) {
          console.log(
            `[/proxy] summary subject=${subjectIndex} received=${t.received} ` +
              `published=${t.published} invalid=${t.invalid} ` +
              `channels=[${[...t.channels].join(',')}]`
          );
          // 값만 비우고 키는 남긴다. 0으로 떨어진 subject가 목록에서 사라지면
          // 침묵과 정상을 구분할 수 없다.
          window.set(subjectIndex, {
            received: 0,
            published: 0,
            invalid: 0,
            channels: new Set<string>(),
          });
        }
      }, PROXY_SUMMARY_INTERVAL_MS);
      summaryTimer.unref?.();

      // proxy:sample 이벤트 - envelope 검증 후 Redis publish로 aligner 경로에 합류시킴 (Phase 18.2)
      socket.on(
        'proxy:sample',
        async (
          envelope: unknown,
          ack?: (response: {
            ok: boolean;
            retryable?: boolean;
            error?: string;
          }) => void
        ) => {
          const parsed = ProxySampleSchema.safeParse(envelope);
          if (!parsed.success) {
            // 형태 오류는 재시도 무의미함 - non-retryable drop 반환함.
            // 어느 필드가 틀렸는지 남기지 않으면 프록시 쪽 drop 로그만으로는
            // 원인을 못 찾는다. 프레임 자체는 싣지 않는다(용량과 개인정보).
            console.warn(
              '[/proxy] invalid_frame:',
              parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')
            );
            tallyFor(-1).invalid++;
            ack?.({ ok: false, retryable: false, error: 'invalid_frame' });
            return;
          }

          const {
            group_id: groupId,
            subject_idx: subjectIndex,
            payload,
            metrics,
          } = parsed.data;
          const channel = `mind-signal:${groupId}:subject:${subjectIndex}`;
          tallyFor(subjectIndex).received++;
          try {
            // redisService.client는 publish 전용 - 모든 subscribe는 duplicate() 경유라
            // 이 공유 client는 PubSub 모드에 진입하지 않음 (measurement.service.ts 정합).
            // dedup 미수행이라 duplicate 필드 미emit - be-forwarder는 ok:true로 dequeue함.
            // 소비자가 요구하는 형태({type, waves, metrics})로 감싸 publish함.
            // metrics는 구버전 DE 프레임에서 없을 수 있어 있을 때만 실음.
            await redisService.client.publish(
              channel,
              JSON.stringify({
                type: 'brain_sync_all',
                waves: payload,
                ...(metrics ? { metrics } : {}),
              })
            );
            // await 사이에 요약 타이머가 돌면 위에서 잡아 둔 tally 객체는
            // 맵에서 교체된 뒤다. 그 낡은 객체를 올리면 성공한 publish가
            // 다음 요약에서 사라진다. 성공 시점에 다시 조회함 (CodeRabbit PR #102).
            // 채널도 여기서 기록해 실패한 publish가 성공처럼 보이지 않게 함
            const publishedTally = tallyFor(subjectIndex);
            publishedTally.published++;
            publishedTally.channels.add(channel);
            ack?.({ ok: true });
          } catch (err) {
            // Redis 일시 장애는 재시도 허용함 - 소켓은 죽이지 않음
            console.error(`[/proxy] publish 실패 ${channel}:`, err);
            ack?.({ ok: false, retryable: true, error: 'publish_failed' });
          }
        }
      );

      // proxy:status 이벤트 - 헤드셋 상태 통보를 엔진의 직접 publish와 같은 형태로
      // 같은 채널에 실음. Redis 없는 구성에서 엔진 경보가 지나는 유일한 경로임
      socket.on(
        'proxy:status',
        async (
          envelope: unknown,
          ack?: (response: {
            ok: boolean;
            retryable?: boolean;
            error?: string;
          }) => void
        ) => {
          const parsed = ProxyStatusSchema.safeParse(envelope);
          if (!parsed.success) {
            console.warn(
              '[/proxy] invalid_status:',
              parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')
            );
            ack?.({ ok: false, retryable: false, error: 'invalid_frame' });
            return;
          }

          const {
            group_id: groupId,
            subject_idx: subjectIndex,
            status,
            silent_seconds: silentSeconds,
          } = parsed.data;
          const channel = `mind-signal:${groupId}:subject:${subjectIndex}`;
          try {
            // silentSeconds가 undefined면 JSON.stringify가 키를 생략함
            await redisService.client.publish(
              channel,
              JSON.stringify({
                type: 'headset_status',
                status,
                subjectIndex,
                groupId,
                silentSeconds,
              })
            );
            ack?.({ ok: true });
          } catch (err) {
            console.error(`[/proxy] status publish 실패 ${channel}:`, err);
            ack?.({ ok: false, retryable: true, error: 'publish_failed' });
          }
        }
      );

      socket.on('disconnect', (reason: string) => {
        clearInterval(summaryTimer);
        console.log(`[/proxy] disconnected: ${socket.id} reason=${reason}`);
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

  /**
   * 운영자 전용 room에만 이벤트 브로드캐스트함.
   * 피실험자 소켓은 이 room에 없으므로 페이로드가 전달되지 않음
   * (렌더 차단이 아니라 전송 차단임).
   *
   * @param {string} groupId - 대상 그룹 식별자
   * @param {string} event - 이벤트 명
   * @param {unknown} data - 전송할 데이터 객체
   */
  public static emitToOperators(
    groupId: string,
    event: string,
    data: unknown
  ): void {
    if (this.io) {
      this.io.to(operatorRoom(groupId)).emit(event, data);
    }
  }
}
