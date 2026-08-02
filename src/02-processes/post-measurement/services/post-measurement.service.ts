import { Session } from '@06-entities/sessions';
import { AnalysisResult } from '@06-entities/analysis-results';
import { MatchingPool } from '@06-entities/matching-pools';
import { EegRecord } from '@06-entities/eeg-records';
import { Consent } from '@06-entities/consents';
import { engineProxyService } from '@02-processes/engine/services/engine-proxy.service';
import { config } from '@07-shared/config/config';

/**
 * MongoDB 중복키 오류(E11000)인지 판정함.
 *
 * upsert는 문서가 없을 때만 삽입하지만, 같은 groupId에 대해 두 실행이
 * 거의 동시에 들어오면 둘 다 "없음"을 보고 삽입을 시도해 뒤늦은 쪽이
 * unique 인덱스에 걸림. 이 경우 실패가 아니라 다른 실행이 먼저 완료한
 * 것이므로 사용자에게 "분석 실패"로 보고하면 안 됨.
 *
 * @param err - 검사 대상 에러임
 * @returns 중복키 오류면 true 반환
 */
const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: number }).code === 11000;

/**
 * 동조율(-1..1)을 매칭 점수(0..100)로 변환함.
 *
 * **구 엔진 폴백 전용임.** ANALYSIS-W004 이후 엔진이 정본 수식 점수
 * `friendshipScore`를 직접 주므로 그 필드가 응답에 있으면 이 변환을 쓰지 않음.
 * 필드가 없는 구 엔진이 붙어 있는 동안만 유효함.
 *
 * 음수 동조율은 역상관(두 피실험자가 반대로 반응)이므로 0으로 클램프함.
 * 클램프 없이 저장하면 AnalysisResult/MatchingPool 스키마의 min:0 검증에 걸려
 * ValidationError가 발생하고 결과가 통째로 유실됨(2026-07-10 라이브 실측).
 * 원본 부호는 synchronyScore 필드에 그대로 보존됨.
 *
 * @param synchronyScore - 엔진이 계산한 동조율, null이면 미측정임
 * @returns 0 이상 100 이하 정수 매칭 점수 반환
 */
export const toMatchingScore = (synchronyScore: number | null): number => {
  if (synchronyScore === null) return 0;
  // 스키마 계약이 0..100이므로 양끝 모두 클램프함. Pearson 상관은 이론상 1을
  // 넘지 않으나 부동소수 오차나 향후 지표 교체로 상한을 넘으면 동일하게 유실됨.
  return Math.min(100, Math.max(0, Math.round(synchronyScore * 100)));
};

/**
 * 엔진이 준 friendshipScore를 검증해 반환함.
 *
 * 엔진 응답은 `Record<string, unknown>`이라 타입이 보장되지 않음. `undefined`는
 * 구 엔진(필드 없음), `null`은 신 엔진의 미측정으로 의미가 다르므로 둘 다
 * 보존하고, 그 외에는 유한한 수치만 통과시킴. 문자열이나 NaN이 그대로
 * 흘러가면 스키마 검증에서 결과가 통째로 유실됨.
 *
 * 값이 오염됐을 때 던지지 않는 이유: subjects와 markdown과 synchronyScore가
 * 전부 정상인데 필드 하나 때문에 결과를 통째로 버리게 됨. 그것은 이 함수가
 * 막으려던 실패 모드와 결과가 같으므로, 경고를 남기고 구 엔진 폴백으로 강등함.
 *
 * @param raw - 엔진 응답의 friendshipScore 값임
 * @returns 유한 수치, 미측정이면 null, 필드 부재나 오염이면 undefined 반환
 */
const parseFriendshipScore = (raw: unknown): number | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    console.error(
      `[postMeasurement] friendshipScore가 유한 수치가 아니라 폴백함: ${String(raw)}`
    );
    return undefined;
  }
  return raw;
};

/**
 * 포스트-측정 오케스트레이션 파이프라인 수행함
 * 트리거: 두 subject 모두 COMPLETED 감지 시
 */
export const runPostMeasurementPipeline = async (groupId: string) => {
  // 0. 멱등성 가드 (C-1): 이미 완료된 그룹이면 스킵함.
  // status를 COMPLETED로 한정하는 이유: 엔진 실패 시 아래에서 PENDING을
  // 남기는데, 그것까지 "이미 처리됨"으로 읽으면 재시도가 영구히 막힘.
  // PENDING을 남기는 목적 자체가 재시도 가능 상태 표시임
  const existing = await MatchingPool.findOne({ groupId, status: 'COMPLETED' });
  if (existing) {
    console.log(`[postMeasurement] groupId=${groupId} 이미 처리됨, 스킵`);
    return;
  }

  // 세션 2건 조회함
  const sessions = await Session.find({ groupId }).populate('userId');
  const session1 = sessions.find((s) => s.subjectIndex === 1);
  const session2 = sessions.find((s) => s.subjectIndex === 2);

  if (!session1?.userId || !session2?.userId) {
    // 조용히 return하면 호출부가 실패를 모르고 프론트는 무한 폴링 끝에
    // "응답 시간 초과"만 보게 됨. 이 PR이 고치려는 바로 그 패턴이라 던짐
    throw new Error(
      `[postMeasurement] groupId=${groupId} 세션 또는 유저 정보 부족`
    );
  }

  const user1Id = (session1.userId as any)._id;
  const user2Id = (session2.userId as any)._id;

  // 1. EegRecord 2건 생성함 (C-3: Consent 조회)
  const consent1 = await Consent.findOne({ userId: user1Id });
  const consent2 = await Consent.findOne({ userId: user2Id });

  const record1Doc: any = {
    userId: user1Id,
    sessionId: session1._id,
    rawDataPath: `data/${groupId}/subject_1.csv`,
    eegSummary: {},
  };
  if (consent1?._id) record1Doc.consentId = consent1._id;

  const record2Doc: any = {
    userId: user2Id,
    sessionId: session2._id,
    rawDataPath: `data/${groupId}/subject_2.csv`,
    eegSummary: {},
  };
  if (consent2?._id) record2Doc.consentId = consent2._id;

  // create가 아니라 sessionId 기준 upsert임. 엔진 실패 후 재시도가 들어오면
  // create는 같은 세션의 EegRecord를 매번 새로 쌓음(제약이 없어 조용히 누적됨)
  const [record1, record2] = await Promise.all([
    EegRecord.findOneAndUpdate(
      { sessionId: session1._id },
      { $set: record1Doc },
      { upsert: true, new: true }
    ),
    EegRecord.findOneAndUpdate(
      { sessionId: session2._id },
      { $set: record2Doc },
      { upsert: true, new: true }
    ),
  ]);

  // 2. 엔진 파이프라인 분석 호출함
  let pipelineResult: Record<string, unknown> = {};
  let synchronyScore: number | null = null;
  let yScore: number | null = null;
  let markdown = '';
  let matchingScore = 0;

  try {
    // DUAL_2PC는 CSV가 operator로 집계되므로 분석을 operator 로컬 DE로 고정함.
    // (양쪽 DE가 legacy 단일 slot에 등록해 getEngineUrl()이 레이스이기 때문)
    const analysisEngineUrl =
      session1.experimentMode === 'DUAL_2PC'
        ? config.dataEngine.baseUrl
        : undefined;
    pipelineResult = await engineProxyService.analyzePipeline(
      groupId,
      [1, 2],
      undefined,
      undefined,
      true,
      analysisEngineUrl
    );

    synchronyScore = (pipelineResult.synchronyScore as number) ?? null;
    yScore = (pipelineResult.yScore as number) ?? null;
    markdown = (pipelineResult.markdown as string) ?? '';

    // 엔진이 정본 수식 점수를 주면 그대로 씀. undefined(필드 자체 없음)와
    // null(신 엔진의 미측정)을 반드시 구분할 것 — undefined를 값으로 다루면
    // Math.round(undefined)가 NaN이 되고 스키마 min/max 검증에서 결과가
    // 통째로 유실됨(toMatchingScore JSDoc의 2026-07-10 사례와 같은 실패)
    const friendshipScore = parseFriendshipScore(
      pipelineResult.friendshipScore
    );
    const hasFriendship = friendshipScore !== undefined;
    // 미측정(null)은 0으로 저장할 수밖에 없음(스키마 required). 완전 역상관과
    // 구분해야 하면 synchronyScore가 null인지로 판별함
    matchingScore = hasFriendship
      ? friendshipScore === null
        ? 0
        : Math.min(100, Math.max(0, Math.round(friendshipScore)))
      : toMatchingScore(synchronyScore);
    console.log(
      `[postMeasurement] groupId=${groupId} 점수 경로=${
        hasFriendship ? 'friendshipScore' : 'legacy-synchrony'
      }`
    );
  } catch (err) {
    console.error(`[postMeasurement] groupId=${groupId} 엔진 분석 실패:`, err);
    // 엔진 실패 시 PENDING 상태로 남겨 재시도 가능하도록 함.
    // create가 아니라 upsert인 이유: groupId에 unique 인덱스가 걸려 있어
    // 두 번째 실패에서 create가 중복키로 터지고, 그러면 아래 throw에 도달하지
    // 못해 보고되는 사유가 엔진 에러가 아니라 Mongo 에러가 됨
    await MatchingPool.findOneAndUpdate(
      { groupId },
      { $set: { user1Id, user2Id, matchingScore: 0, status: 'PENDING' } },
      { upsert: true }
    );
    // 삼키지 않고 다시 던짐. 호출부가 실패를 소켓으로 알림. 이전에는 여기서
    // return해 프론트가 무한 폴링 후 "응답 시간 초과"만 보게 됐음
    throw err;
  }

  // 3~4. 결과 문서 저장함.
  // 같은 groupId에 두 실행이 거의 동시에 들어오면 둘 다 "문서 없음"을 보고
  // 삽입을 시도해 뒤늦은 쪽이 unique 인덱스에 걸림. 그것은 실패가 아니라
  // 다른 실행이 먼저 끝낸 것이므로 사용자에게 실패로 보고하지 않음
  try {
    await persistAnalysisOutcome({
      groupId,
      user1Id,
      user2Id,
      record1Id: record1._id,
      record2Id: record2._id,
      matchingScore,
      synchronyScore,
      yScore,
      markdown,
      pipelineResult,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    console.log(
      `[postMeasurement] groupId=${groupId} 동시 실행 감지, 다른 실행이 완료함`
    );
    return;
  }

  // 5. EegRecord eegSummary 업데이트함
  const subjects = pipelineResult.subjects as any[];
  if (subjects?.length >= 2) {
    await EegRecord.findByIdAndUpdate(record1._id, {
      eegSummary: {
        baseline: subjects[0]?.baseline,
        features: subjects[0]?.features,
      },
    });
    await EegRecord.findByIdAndUpdate(record2._id, {
      eegSummary: {
        baseline: subjects[1]?.baseline,
        features: subjects[1]?.features,
      },
    });
  }

  console.log(
    `[postMeasurement] groupId=${groupId} 파이프라인 완료, matchingScore=${matchingScore}`
  );
};

/** 분석 결과 저장에 필요한 값 묶음임 */
interface AnalysisOutcome {
  groupId: string;
  user1Id: unknown;
  user2Id: unknown;
  record1Id: unknown;
  record2Id: unknown;
  matchingScore: number;
  synchronyScore: number | null;
  yScore: number | null;
  markdown: string;
  pipelineResult: Record<string, unknown>;
}

/**
 * AnalysisResult와 MatchingPool을 groupId 기준으로 저장함.
 *
 * 둘 다 groupId에 unique 인덱스가 있어 create는 재시도에서 중복키로 터짐.
 * upsert로 두어 실패 후 재시도가 같은 문서를 갱신하게 함.
 *
 * @param outcome - 저장할 분석 결과 값 묶음임
 * @throws MongoServerError 11000 — 동시 실행이 먼저 삽입한 경우임
 */
async function persistAnalysisOutcome(outcome: AnalysisOutcome): Promise<void> {
  const {
    groupId,
    user1Id,
    user2Id,
    record1Id,
    record2Id,
    matchingScore,
    synchronyScore,
    yScore,
    markdown,
    pipelineResult,
  } = outcome;

  const analysisResult = await AnalysisResult.findOneAndUpdate(
    { groupId },
    {
      $set: {
        user1Id,
        user2Id,
        record1Id,
        record2Id,
        surveySummary: '',
        matchingScore,
        synchronyScore,
        yScore,
        aiComment: markdown
          ? '뇌파 분석이 완료되었습니다.'
          : '분석 데이터가 부족합니다.',
        markdown,
        pipelineResult,
      },
    },
    { upsert: true, new: true }
  );

  // 4. MatchingPool 1건 생성함.
  // 실패 후 재시도 경로에서는 PENDING 문서가 이미 있으므로 create가 아니라
  // upsert여야 함. create로 두면 분석이 실제로 성공했는데도 중복키 에러가
  // 호출부로 전파돼 사용자에게 "분석 실패"로 보고됨
  await MatchingPool.findOneAndUpdate(
    { groupId },
    {
      $set: {
        user1Id,
        user2Id,
        analysisId: analysisResult._id,
        matchingScore,
        status: 'COMPLETED',
      },
    },
    { upsert: true }
  );
}
