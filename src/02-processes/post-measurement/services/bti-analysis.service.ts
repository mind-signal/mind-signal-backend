import { Session } from '@06-entities/sessions';
import { AnalysisResult } from '@06-entities/analysis-results';
import { EegRecord } from '@06-entities/eeg-records';
import { Consent } from '@06-entities/consents';
import { engineProxyService } from '@02-processes/engine/services/engine-proxy.service';

/**
 * BTI(1인) 분석 파이프라인 수행함
 * 트리거: BTI 모드에서 Subject 1 COMPLETED 감지 시
 */
export const runBTIAnalysisPipeline = async (groupId: string) => {
  // 멱등성 가드: 이미 결과가 있으면 스킵함
  const existing = await AnalysisResult.findOne({ groupId });
  if (existing) {
    console.log(`[btiAnalysis] groupId=${groupId} 이미 처리됨, 스킵`);
    return;
  }

  // 세션 1건 조회함
  const sessions = await Session.find({ groupId }).populate('userId');
  const session1 = sessions.find((s) => s.subjectIndex === 1);

  if (!session1?.userId) {
    console.error(`[btiAnalysis] groupId=${groupId} Subject 1 세션 정보 부족`);
    return;
  }

  const user1Id = (session1.userId as any)._id;

  // EegRecord 1건 생성함
  const consent1 = await Consent.findOne({ userId: user1Id });
  const record1Doc: any = {
    userId: user1Id,
    sessionId: session1._id,
    rawDataPath: `data/${groupId}/subject_1.csv`,
    eegSummary: {},
  };
  if (consent1?._id) record1Doc.consentId = consent1._id;
  const record1 = await EegRecord.create(record1Doc);

  // 엔진 세션 분석 호출함 (/api/analyze — metricsMean/wavesMean 포함)
  let sessionResult: Record<string, unknown> = {};
  let markdown = '';

  try {
    sessionResult = await engineProxyService.analyzeSession(groupId, [1], true);
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
