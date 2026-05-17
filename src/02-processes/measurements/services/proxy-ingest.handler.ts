/* eslint-disable camelcase */
/**
 * proxy-ingest.handler.ts
 *
 * /proxy Socket.io 네임스페이스 인그레스 핸들러 등록 모듈 (Phase 18 T1-BE-G).
 * FSD 02-processes — 07-shared/socket.ts 직접 수정 금지 (depcruise FSD 경계 정합).
 * ADR §C: ingest-only 설계 — flush()가 aligned_pair 유일 emitter.
 */

import type { Socket } from 'socket.io';
import { SocketService } from '@07-shared/lib/socket';
import { config } from '@07-shared/config/config';
import {
  SampleEnvelopeSchema,
  type SampleEnvelope,
} from '@07-shared/schemas/measurement-envelope.schema';
import {
  measurementSampleRepository,
  type MeasurementSample,
} from '@06-entities/measurement-samples';
import { Session } from '@06-entities/sessions';
import { engineRegistryService } from '@02-processes/engine/services/engine-registry.service';
import { timestampAlignerRegistry } from './timestamp-aligner.service';

/**
 * /proxy Socket.io 네임스페이스 인그레스 핸들러 등록함.
 * SocketService.init(server) 직후 app.ts에서 1회 호출됨 (Phase 18 T1-BE-G).
 *
 * 동작 순서 (ADR §C ingest-only):
 * 1. 핸드셰이크 인증 미들웨어 — ENGINE_SECRET_KEY 검증함 (ADR §F, D14)
 * 2. proxy:sample 이벤트 수신 → Zod 검증 → MEASURING 게이트 → fail-closed 게이트
 * 3. MeasurementSample DB 저장 (E11000 멱등성 처리 포함)
 * 4. getOrCreate로 aligner 인스턴스 레지스트리 보장 후 ingest() 호출함
 *    — flush()가 aligned_pair 단독 emitter임
 *
 * @returns void
 */
export function registerProxyIngestNamespace(): void {
  const proxyNs = SocketService.getIO().of('/proxy');

  // 핸드셰이크 인증 미들웨어 — config.dataEngine.secretKey 검증함 (ADR §F)
  proxyNs.use((socket: Socket, next: (err?: Error) => void) => {
    if (socket.handshake.auth?.engineSecret !== config.dataEngine.secretKey) {
      return next(new Error('unauthorized'));
    }
    next();
  });

  proxyNs.on('connection', (socket) => {
    socket.on(
      'proxy:sample',
      async (
        frame: unknown,
        ack?: (r: {
          ok: boolean;
          error?: string;
          retryable?: boolean;
          duplicate?: boolean;
        }) => void
      ) => {
        // 1. Zod 검증 (07-shared 단일 소스)
        const parsed = SampleEnvelopeSchema.safeParse(frame);
        if (!parsed.success) {
          return ack?.({ ok: false, error: 'invalid_frame', retryable: false });
        }
        const envelope: SampleEnvelope = parsed.data;

        // 2-a. MEASURING 게이트 — Session 활성 조회함
        const session = await Session.findOne({
          groupId: envelope.group_id,
          subjectIndex: envelope.subject_idx,
          status: 'MEASURING',
        });
        if (!session) {
          return ack?.({
            ok: false,
            error: 'session_not_measuring',
            retryable: false,
          });
        }

        // 2-b. fail-closed 게이트 (group-level Map — ADR §D)
        const failClosedNs = engineRegistryService.getFailClosedNs(
          envelope.group_id
        );
        if (
          failClosedNs !== undefined &&
          BigInt(envelope.proxy_ingress_ts_ns) >= failClosedNs
        ) {
          return ack?.({
            ok: false,
            error: 'fail_closed',
            retryable: false,
          });
        }

        // 3. 저장 (dedupe — repository raw E11000 propagation, ADR §F CX3-6)
        try {
          const doc: MeasurementSample = {
            group_id: envelope.group_id,
            subject_idx: envelope.subject_idx,
            de_ts_ns: envelope.de_ts_ns,
            proxy_ingress_ts_ns: envelope.proxy_ingress_ts_ns,
            seq: envelope.seq,
            network_delay_ms: null, // envelope 미포함 — Stage-2 채움
            sync_meta: envelope.sync_meta,
          };
          await measurementSampleRepository.create(doc);
        } catch (err) {
          if ((err as { code?: number }).code === 11000) {
            return ack?.({ ok: true, duplicate: true }); // 멱등성
          }
          // 비-11000 DB 오류 — 프록시 무응답 hang 방지 위해 retryable ack 후 로그함
          console.error('proxy:sample 저장 오류:', err);
          return ack?.({
            ok: false,
            error: 'internal_error',
            retryable: true,
          });
        }

        // 4. ingest — flush()가 aligned_pair 유일 emitter (ADR §C)
        // CX4-2: getOrCreate를 ingest 직전 호출하여 레지스트리에 aligner 인스턴스를
        // 보장함 — wrapper ingest의 silent no-op(`if(!a) return`) 경로 차단함.
        // getOrCreate는 동기·비-null 반환(TimestampAligner)이라 race 윈도우 없음.
        timestampAlignerRegistry.getOrCreate(
          envelope.group_id,
          config.dualPc.timestampToleranceMs
        );
        // T1-BE-H sig: ingest(groupId, subjectIndex, sample, proxyIngressTsNs: string)
        // subject_idx 1-based 그대로 — +1/-1 변환 금지 (Wave1 Critical 정합)
        timestampAlignerRegistry.ingest(
          envelope.group_id,
          envelope.subject_idx,
          envelope.payload,
          envelope.proxy_ingress_ts_ns
        );

        ack?.({ ok: true });
      }
    );
  });
}
