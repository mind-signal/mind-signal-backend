import { Schema, model, Model, HydratedDocument, Types } from 'mongoose';
import { ExperimentMode } from '@07-shared/constants/experiment';
import type { SessionStatus } from '../types/session.types';

// SessionStatus re-export — 외부에서 schema 또는 types 양쪽 경로로 import 호환함
export type { SessionStatus };

/** * 1. 문서 필드 타입 정의
 * ERD의 필드와 Note A 규칙을 반영함
 */
export interface Session {
  groupId: string; // 추가: 동일 실험 세션을 묶어주는 그룹 고유 식별자임
  subjectIndex: number | null; // 추가: 해당 그룹 내 피실험자 할당 번호(1 또는 2)임
  pairingToken: string; // 고유 페어링 토큰임
  userId: Types.ObjectId | null; // 페어링 성공 시 바인딩되는 사용자 ID임
  creatorId: Types.ObjectId | null; // 세션 생성자(운영자) ID임
  status: SessionStatus; // 세션 상태 6종 (session.types.ts 단일 정의 참조)
  pairedAt: Date | null; // 페어링 완료 시점
  expiresAt: Date; // 토큰 만료 시점
  measuredAt: Date | null; // 측정 시작 시점
  stopReason: 'Natural' | 'ManualEarly' | 'HeadsetLost' | 'ProcessError' | null;
  measuredDurationSeconds: number | null;
  experimentMode: ExperimentMode; // 실험 모드 (BTI | DUAL_2PC)
}

/** 2. 인스턴스 메서드 타입 정의 */
export interface SessionMethods {
  isExpired(): boolean;
  canTransitionTo(nextStatus: Session['status']): boolean;
}

/** 3. Mongoose 편의 타입 */
export type SessionDoc = HydratedDocument<Session, SessionMethods>;
export type SessionModel = Model<Session, {}, SessionMethods>;

/** * 4. 스키마 정의
 */
const sessionSchema = new Schema<Session, SessionModel, SessionMethods>(
  {
    groupId: {
      type: String,
      required: true,
      index: true, // 그룹 단위 상태 조회를 위한 인덱스 생성함
    },
    subjectIndex: {
      type: Number,
      default: null, // 페어링 프로세스 중 서비스 로직에서 할당함
    },
    pairingToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: [
        'CREATED',
        'PAIRED',
        'MEASURING',
        'COMPLETED',
        'EXPIRED',
        'CANCELLED',
      ],
      default: 'CREATED',
    },
    pairedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    measuredAt: {
      type: Date,
      default: null,
    },
    stopReason: {
      type: String,
      enum: ['Natural', 'ManualEarly', 'HeadsetLost', 'ProcessError', null],
      default: null,
    },
    measuredDurationSeconds: {
      type: Number,
      default: null,
    },
    experimentMode: {
      type: String,
      enum: ['BTI', 'DUAL_2PC'],
      required: true,
      default: 'DUAL_2PC',
    },
  },
  {
    timestamps: true, // createdAt, updatedAt 자동 생성
    collection: 'sessions', // 컬렉션 명은 복수형
  }
);

/** * 5. JSON 변환 로직 (일관성 유지)
 */
sessionSchema.methods.toJSON = function () {
  const obj = this.toObject() as any;
  obj.id = obj._id;
  // 레거시 문서 방어 1줄. 2026-08-04 마이그레이션으로 필드 부재 문서는 0이나,
  // 좁힌 enum 과 모순되지 않게 폴백 값도 DUAL_2PC 로 맞춤 (SESSION-W002)
  obj.experimentMode ??= 'DUAL_2PC';
  delete obj._id;
  delete obj.updatedAt;
  delete obj.createdAt;
  delete obj.__v;
  return obj;
};

/** 6. 인스턴스 메서드 구현 */
sessionSchema.methods.isExpired = function (this: SessionDoc): boolean {
  return this.expiresAt < new Date();
};

sessionSchema.methods.canTransitionTo = function (
  this: SessionDoc,
  nextStatus: Session['status']
): boolean {
  const current = this.status;

  // 1. 만료된 경우 EXPIRED 외에는 전이 불가 (Note A-1)
  if (this.isExpired() && current === 'CREATED') {
    return nextStatus === 'EXPIRED';
  }

  // 2. 상태별 전이 규칙 (Note A-2)
  const transitions: Record<Session['status'], Session['status'][]> = {
    CREATED: ['PAIRED', 'EXPIRED', 'CANCELLED'],
    PAIRED: ['MEASURING', 'CANCELLED'],
    MEASURING: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [], // 측정 종료 요청
    EXPIRED: [], // 유효 시간 초과
    CANCELLED: [], // 통신 오류 또는 강제 종료
  };

  return transitions[current].includes(nextStatus);
};

/** * 6.5 복합 유니크 인덱스 선언 (groupId + subjectIndex 충돌 방지함) */
sessionSchema.index(
  { groupId: 1, subjectIndex: 1 },
  { unique: true, sparse: true, name: 'groupId_subjectIndex_unique' }
);

/** 조회 성능 개선을 위한 복합 인덱스 선언함 */
sessionSchema.index({ userId: 1, status: 1 });
sessionSchema.index({ creatorId: 1, status: 1 });

/** 7. 모델 생성 및 수출 */
export const Session = model<Session, SessionModel>('Session', sessionSchema);
export default Session;
