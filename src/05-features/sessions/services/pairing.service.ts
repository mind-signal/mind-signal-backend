import { Session } from '@06-entities/sessions';
import { Types } from 'mongoose';
import mongoose from 'mongoose';
import { AppError } from '@07-shared/errors';
import { ExperimentMode } from '@07-shared/constants/experiment';
import crypto from 'crypto';

// ===== 페어링 완료 listener registry =====

type PairingCallback = (data: {
  groupId: string;
  subjectIndex: number | null;
}) => void | Promise<void>;
const pairingListeners = new Set<PairingCallback>();

/**
 * 페어링 완료 시 호출될 콜백 등록함.
 *
 * @param cb - groupId + subjectIndex를 받는 콜백 함수
 */
export function addPairingCompleteListener(cb: PairingCallback): void {
  pairingListeners.add(cb);
}

/**
 * [Service] 운영자용 그룹 세션 생성 프로세스 정의함
 * $inc 원자적 연산으로 동시 요청 시에도 고유한 subjectIndex 보장함
 * @param groupId 기존 그룹에 추가할 경우 제공하며, 없을 경우 신규 생성함
 * @param creatorId 세션 생성자(운영자) ID — 제공 시 바인딩함
 * @param experimentMode 실험 모드 — 미제공 시 스키마 default(DUAL_2PC) 적용함
 */
export const createGroupSessionProcess = async (
  groupId?: string,
  creatorId?: string,
  experimentMode?: ExperimentMode
) => {
  // 1. 그룹 식별자 결정함 (제공되지 않으면 24자리 ObjectId hex 신규 생성함)
  // session.schema.ts:8-11의 24자리 HEX regex와 정합 보장. 8자리 단축 형식은
  // FE 재전송 시 schema 거부되어 DUAL 2인 페어링 차단되는 회귀 박제됨
  const effectiveGroupId = groupId || new Types.ObjectId().toHexString();

  // 2. 원자적 $inc 연산으로 고유 subjectIndex 획득함 (경쟁 조건 방지함)
  const counter = await mongoose.connection
    .db!.collection<{ groupId: string; seq: number }>('group_counters')
    .findOneAndUpdate(
      { groupId: effectiveGroupId },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
  const nextSubjectIndex = counter?.seq ?? null;

  // 3. 할당된 subjectIndex 유효성 검사 수행함
  if (!nextSubjectIndex || nextSubjectIndex <= 0) {
    throw new AppError('subjectIndex 할당에 실패했습니다.', 500);
  }

  // 4. 6자리 무작위 페어링 토큰 생성 수행함
  const pairingToken = crypto.randomBytes(3).toString('hex').toUpperCase();

  // 5. 확장된 스키마 기반으로 세션 엔티티 생성 및 저장함
  const newSession = new Session({
    groupId: effectiveGroupId,
    subjectIndex: nextSubjectIndex,
    pairingToken,
    status: 'CREATED',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5분 유효함
    ...(creatorId ? { creatorId: new Types.ObjectId(creatorId) } : {}),
    // experimentMode 제공 시 명시 저장, 미제공 시 스키마 default(DUAL_2PC) 적용함
    ...(experimentMode ? { experimentMode } : {}),
  });

  return await newSession.save();
};

/**
 * Phase 1.5: 모바일 기기 페어링 프로세스
 * 1. 토큰 유효성 및 만료 확인
 * 2. 원자적 상태 변경 (CREATED -> PAIRED)
 * 3. 사용자 ID 바인딩
 *
 * @deprecated Use PairSubjectService.execute() instead — to be removed in Phase L
 */
export const pairDeviceProcess = async (
  pairingToken: string,
  userId: string
) => {
  // 0. userId 유효성 검사 수행함
  if (!Types.ObjectId.isValid(userId)) {
    throw new AppError('유효하지 않은 사용자 ID 형식입니다', 400);
  }

  // 1. 토큰 유효성 및 만료 확인 수행함
  // DB에서 페어링 토큰에 해당하는 세션 데이터 조회함
  const session = await Session.findOne({ pairingToken });
  if (!session) {
    throw new AppError('존재하지 않거나 유효하지 않은 토큰입니다', 404);
  }

  // 2. 만료 및 상태 전이 가능 여부 체크 수행함
  // 토큰 만료 시 상태를 EXPIRED로 변경하고 에러 발생시킴
  if (session.isExpired()) {
    session.status = 'EXPIRED';
    await session.save();
    throw new AppError('페어링 토큰이 만료되었습니다. 다시 시도해주세요.', 401);
  }

  // 스키마에 정의된 전이 규칙에 따라 PAIRED 상태 전환 가능 여부 확인함
  if (!session.canTransitionTo('PAIRED')) {
    throw new AppError(
      `현재 세션 상태(${session.status})에서는 페어링할 수 없습니다.`,
      400
    );
  }

  // 3. 페어링 정보 업데이트 완료함
  // 세션 상태를 PAIRED로 변경하고 사용자 ID 및 완료 시점 기록함
  session.status = 'PAIRED';
  session.userId = new Types.ObjectId(userId);
  session.pairedAt = new Date();

  // RC5-H-3 fix: return await 단일 expr 분리 필수
  const saved = await session.save();

  // 페어링 완료 listener 호출 (LD-12 대안 D)
  // fire-and-forget — listener 내부 retry/timeout이 응답 블로킹 방지함
  firePairingCompleteListeners(session.groupId, session.subjectIndex);

  return saved;
};

/**
 * 페어링 완료 listener 발화 helper — HOLD-1 β G9 예외 (ADR-008 §2)
 *
 * 행위 동등성 3조건 (mechanical refactor 보장 — baseline 정합):
 *  1. 동일 Set(`pairingListeners`) 순회함
 *  2. 동일 `void Promise.resolve(cb({...})).catch(console.error)` 패턴 사용함
 *  3. 동일 인자 shape (`{groupId, subjectIndex}`) 전달함 (PairingCallback type 정합)
 *
 * async rejection best-effort catch; sync throw behavior intentionally preserved until Phase L
 */
export function firePairingCompleteListeners(
  groupId: string,
  subjectIndex: number | null
): void {
  for (const cb of pairingListeners) {
    void Promise.resolve(cb({ groupId, subjectIndex })).catch((err) => {
      console.error('pairingListener 에러:', err);
    });
  }
}
