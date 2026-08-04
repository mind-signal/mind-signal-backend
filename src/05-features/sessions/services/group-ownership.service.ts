import { Session } from '@06-entities/sessions';
import { AppError } from '@07-shared/errors';

/**
 * 요청자가 해당 그룹의 참여자 또는 생성자인지 확인함 (AUTH-W002).
 *
 * groupId 는 QR 과 대시보드에서 평문으로 다루는 값이라 획득 난이도가 방어가
 * 되지 못함. 인증만 통과하면 아무 계정이나 남의 groupId 로 측정을 시작하거나
 * 중단하거나 분석 결과를 받아낼 수 있었음.
 *
 * 판정 기준은 이미 쓰이던 두 곳(`analysis.controller.ts` 의 결과 조회,
 * `session.controller.ts` 의 그룹 상태 조회)과 같음 — 세션의 `userId`(합류한
 * 피실험자) 또는 `creatorId`(세션을 만든 운영자)가 요청자와 일치하면 통과함.
 *
 * @param groupId - 측정 그룹 식별자임
 * @param userId - 요청자 사용자 식별자임
 * @throws AppError 404 - 해당 groupId 의 세션이 하나도 없을 때
 * @throws AppError 403 - 참여자도 생성자도 아닐 때
 */
export const assertGroupOwnership = async (
  groupId: string,
  userId: string
): Promise<void> => {
  // select 로 필드를 좁히지 않음. 그룹당 세션이 최대 2건이라 이득이 없고,
  // 쿼리 체인이 길어지면 호출부 테스트마다 mock 모양을 맞춰야 함
  const sessions = await Session.find({ groupId });

  if (sessions.length === 0) {
    throw new AppError('해당 그룹을 찾을 수 없습니다.', 404);
  }

  const isParticipant = sessions.some(
    (s) => s.userId?.toString() === userId || s.creatorId?.toString() === userId
  );

  if (!isParticipant) {
    throw new AppError('해당 그룹에 대한 접근 권한이 없습니다.', 403);
  }
};

/**
 * 세션 식별자로 소유권을 확인함 (AUTH-W002).
 *
 * 측정 라우트 일부가 groupId 가 아니라 sessionId 를 받으므로 그 세션의 groupId 를
 * 꺼내 같은 판정을 태움. 그룹 단위로 판정하는 이유는 2인 측정에서 상대 피실험자의
 * 세션도 같은 실험의 일부이기 때문임.
 *
 * @param sessionId - 세션 식별자임
 * @param userId - 요청자 사용자 식별자임
 * @throws AppError 404 - 세션이 없을 때
 * @throws AppError 403 - 참여자도 생성자도 아닐 때
 */
export const assertSessionOwnership = async (
  sessionId: string,
  userId: string
): Promise<void> => {
  const session = await Session.findById(sessionId);

  if (!session) {
    throw new AppError('해당 세션을 찾을 수 없습니다.', 404);
  }

  await assertGroupOwnership(session.groupId, userId);
};
