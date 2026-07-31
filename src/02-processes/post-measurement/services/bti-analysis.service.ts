import { Session } from '@06-entities/sessions';
import { AnalysisResult } from '@06-entities/analysis-results';
import { EegRecord } from '@06-entities/eeg-records';
import { Consent } from '@06-entities/consents';
import { engineProxyService } from '@02-processes/engine/services/engine-proxy.service';

/**
 * BTI(1인) 분석 파이프라인 수행함.
 *
 * 트리거는 둘이다. BTI 모드 측정 완료, 그리고 DUAL 측정에서 한쪽만 유효
 * 판정을 받은 PARTIAL 폴백이다.
 *
 * subjectIndex를 인자로 받는 이유: 이전에는 1로 하드코딩해, 유효한 쪽이
 * subject 2인데도 탈락한 subject 1을 분석하려다 실패했음(2026-07-31 실측).
 * 호출부가 이미 coverage로 유효 subject를 계산해 두므로 그 값을 넘겨받는다.
 *
 * @param groupId - 측정 그룹 식별자임
 * @param subjectIndex - 분석 대상 피실험자 순번임. 생략 시 1임
 */
export const runBTIAnalysisPipeline = async (
  groupId: string,
  subjectIndex: number = 1
) => {
  // 멱등성 가드: 이미 결과가 있으면 스킵함
  const existing = await AnalysisResult.findOne({ groupId });
  if (existing) {
    console.log(`[btiAnalysis] groupId=${groupId} 이미 처리됨, 스킵`);
    return;
  }

  // 대상 세션 1건 조회함
  const sessions = await Session.find({ groupId }).populate('userId');
  const targetSession = sessions.find((s) => s.subjectIndex === subjectIndex);

  if (!targetSession?.userId) {
    // 조용히 return하면 호출부가 실패를 모르고 프론트는 무한 폴링 끝에
    // "응답 시간 초과"만 보게 됨. 이 PR이 고치려는 바로 그 패턴이라 던짐
    throw new Error(
      `[btiAnalysis] groupId=${groupId} subject=${subjectIndex} 세션 정보 부족`
    );
  }

  const user1Id = (targetSession.userId as any)._id;

  // EegRecord 1건 생성함. 경로와 분석 대상이 어긋나지 않도록 같은
  // subjectIndex로 둘 다 결정함
  const consent1 = await Consent.findOne({ userId: user1Id });
  const record1Doc: any = {
    userId: user1Id,
    sessionId: targetSession._id,
    rawDataPath: `data/${groupId}/subject_${subjectIndex}.csv`,
    eegSummary: {},
  };
  if (consent1?._id) record1Doc.consentId = consent1._id;
  // sessionId 기준 upsert임. 엔진 실패 후 재시도가 들어오면 create는 같은
  // 세션의 EegRecord를 매번 새로 쌓음(제약이 없어 조용히 누적됨)
  const record1 = await EegRecord.findOneAndUpdate(
    { sessionId: targetSession._id },
    { $set: record1Doc },
    { upsert: true, new: true }
  );

  // 엔진 세션 분석 호출함 (/api/analyze — metricsMean/wavesMean 포함)
  let sessionResult: Record<string, unknown> = {};
  let markdown = '';

  try {
    sessionResult = await engineProxyService.analyzeSession(
      groupId,
      [subjectIndex],
      true
    );
    markdown = (sessionResult.markdown as string) ?? '';
  } catch (err) {
    // 삼키지 않고 다시 던짐. 호출부(triggerPostMeasurementByTier)가 실패를
    // 소켓으로 알림. 이전에는 여기서 return해 프론트가 무한 폴링 후
    // "응답 시간 초과"만 보게 됐음(2026-07-31 실측).
    // AnalysisResult를 만들지 않으므로 멱등성 가드가 실패를 성공으로 오인하지
    // 않고 재시도가 가능함
    console.error(`[btiAnalysis] groupId=${groupId} 엔진 분석 실패:`, err);
    throw err;
  }

  // AnalysisResult 생성함 (user2Id = user1Id — BTI 표시)
  await AnalysisResult.create({
    groupId,
    user1Id,
    user2Id: user1Id,
    record1Id: record1._id,
    record2Id: record1._id,
    surveySummary: '',
    matchingScore: 0,
    synchronyScore: null,
    yScore: null,
    aiComment: '개인 뇌파 분석이 완료되었습니다.',
    markdown,
    pipelineResult: sessionResult,
  });

  // EegRecord eegSummary 업데이트함
  const subjects = sessionResult.subjects as any[];
  if (subjects?.length >= 1) {
    await EegRecord.findByIdAndUpdate(record1._id, {
      eegSummary: {
        metricsMean: subjects[0]?.metricsMean,
        wavesMean: subjects[0]?.wavesMean,
      },
    });
  }

  console.log(`[btiAnalysis] groupId=${groupId} BTI 분석 완료`);
};
