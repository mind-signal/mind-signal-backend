import { Session } from '@06-entities/sessions';
import { AnalysisResult } from '@06-entities/analysis-results';
import { MatchingPool } from '@06-entities/matching-pools';
import { EegRecord } from '@06-entities/eeg-records';
import { Consent } from '@06-entities/consents';
import { engineProxyService } from '@02-processes/engine/services/engine-proxy.service';
import { config } from '@07-shared/config/config';

/**
 * 동조율(-1..1)을 매칭 점수(0..100)로 변환함.
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
 * 포스트-측정 오케스트레이션 파이프라인 수행함
 * 트리거: 두 subject 모두 COMPLETED 감지 시
 */
export const runPostMeasurementPipeline = async (groupId: string) => {
  // 0. 멱등성 가드 (C-1): 이미 처리된 그룹이면 스킵함
  const existing = await MatchingPool.findOne({ groupId });
  if (existing) {
    console.log(`[postMeasurement] groupId=${groupId} 이미 처리됨, 스킵`);
    return;
  }

  // 세션 2건 조회함
  const sessions = await Session.find({ groupId }).populate('userId');
  const session1 = sessions.find((s) => s.subjectIndex === 1);
  const session2 = sessions.find((s) => s.subjectIndex === 2);

  if (!session1?.userId || !session2?.userId) {
    console.error(
      `[postMeasurement] groupId=${groupId} 세션 또는 유저 정보 부족`
    );
    return;
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

  const record1 = await EegRecord.create(record1Doc);
  const record2 = await EegRecord.create(record2Doc);

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
    matchingScore = toMatchingScore(synchronyScore);
  } catch (err) {
    console.error(`[postMeasurement] 엔진 파이프라인 분석 실패:`, err);
    // 엔진 실패 시 PENDING 상태로 생성하여 재시도 가능하도록 함
    await MatchingPool.create({
      groupId,
      user1Id,
      user2Id,
      matchingScore: 0,
      status: 'PENDING',
    });
    return;
  }

  // 3. AnalysisResult 1건 생성함 (그룹 단위)
  const analysisResult = await AnalysisResult.create({
    groupId,
    user1Id,
    user2Id,
    record1Id: record1._id,
    record2Id: record2._id,
    surveySummary: '',
    matchingScore,
    synchronyScore,
    yScore,
    aiComment: markdown
      ? '뇌파 분석이 완료되었습니다.'
      : '분석 데이터가 부족합니다.',
    markdown,
    pipelineResult,
  });

  // 4. MatchingPool 1건 생성함
  await MatchingPool.create({
    groupId,
    user1Id,
    user2Id,
    analysisId: analysisResult._id,
    matchingScore,
    status: 'COMPLETED',
  });

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
