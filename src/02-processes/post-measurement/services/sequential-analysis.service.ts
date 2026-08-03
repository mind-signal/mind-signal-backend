import { Session } from '@06-entities/sessions';
import { AnalysisResult } from '@06-entities/analysis-results';
import { EegRecord } from '@06-entities/eeg-records';
import { Consent } from '@06-entities/consents';
import { engineProxyService } from '@02-processes/engine/services/engine-proxy.service';
import { AppError } from '@07-shared/errors';
import type { AnalysisResultDoc } from '@06-entities/analysis-results';
import type { EegRecordDoc } from '@06-entities/eeg-records';

/**
 * SEQUENTIAL 모드 분석 파이프라인 수행함
 * operator "Analyze" 버튼 클릭 시 호출됨
 * 두 subject 모두 COMPLETED 상태여야 실행 가능함
 */
export const runSequentialAnalysisPipeline = async (
  groupId: string,
  algorithm: string = 'default'
): Promise<AnalysisResultDoc> => {
  // 멱등성 가드: 이미 SEQUENTIAL 결과가 있으면 스킵함
  const existing = await AnalysisResult.findOne({
    groupId,
    // eslint-disable-next-line camelcase
    analysis_mode: 'SEQUENTIAL',
  });
  if (existing) {
    console.log(
      `[sequentialAnalysis] groupId=${groupId} 이미 처리됨, 기존 결과 반환`
    );
    return existing;
  }

  // 두 subject 세션 조회 + COMPLETED 상태 검증함
  const sessions = await Session.find({ groupId }).populate('userId');
  const session1 = sessions.find((s) => s.subjectIndex === 1);
  const session2 = sessions.find((s) => s.subjectIndex === 2);

  if (!session1 || !session2) {
    throw new AppError(
      `[sequentialAnalysis] groupId=${groupId} subject 1 또는 2 세션 미발견`,
      404
    );
  }

  if (session1.status !== 'COMPLETED') {
    throw new AppError(
      `[sequentialAnalysis] groupId=${groupId} subject 1 세션이 COMPLETED 상태가 아님 (현재: ${session1.status})`,
      422
    );
  }

  if (session2.status !== 'COMPLETED') {
    throw new AppError(
      `[sequentialAnalysis] groupId=${groupId} subject 2 세션이 COMPLETED 상태가 아님 (현재: ${session2.status})`,
      422
    );
  }

  if (!session1.userId || !session2.userId) {
    throw new AppError(
      `[sequentialAnalysis] groupId=${groupId} 세션에 userId가 바인딩되지 않음`,
      422
    );
  }

  const user1Id = (session1.userId as any)._id;
  const user2Id = (session2.userId as any)._id;

  // EegRecord 문서 초기화 (실제 create는 try 블록 내에서 수행함)
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

  // DE /analyze/pipeline (mode=SEQUENTIAL) 호출 + AnalysisResult 생성함
  // EegRecord 생성 후 이후 단계 실패 시 롤백 필요함 — try 블록 내에서 통합 처리함
  let pipelineResult: Record<string, unknown> = {};
  let similarityFeatures: Record<string, unknown> | undefined;
  let record1: EegRecordDoc | undefined;
  let record2: EegRecordDoc | undefined;

  try {
    record1 = await EegRecord.create(record1Doc);
    record2 = await EegRecord.create(record2Doc);

    pipelineResult = await engineProxyService.analyzeSequentialPipeline(
      groupId,
      algorithm
    );
    similarityFeatures = (pipelineResult.similarityFeatures ??
      pipelineResult.similarity_features) as
      | Record<string, unknown>
      | undefined;

    // AnalysisResult 생성함 (analysis_mode: SEQUENTIAL)
    const analysisResult = await AnalysisResult.create({
      groupId,
      user1Id,
      user2Id,
      record1Id: record1._id,
      record2Id: record2._id,
      matchingScore:
        typeof similarityFeatures?.similarity_score === 'number'
          ? Math.round(similarityFeatures.similarity_score * 100)
          : 0,
      synchronyScore: null, // SEQUENTIAL 모드에서 PLV/coherence 미계산 (ADR-14-004)
      yScore: null,
      aiComment: '뇌파 반응 유사도 분석이 완료되었습니다.',
      markdown: (pipelineResult.markdown as string) ?? '',
      pipelineResult,
      // eslint-disable-next-line camelcase
      analysis_mode: 'SEQUENTIAL',
      // eslint-disable-next-line camelcase
      similarity_features: similarityFeatures ?? undefined,
    });

    console.log(
      `[sequentialAnalysis] groupId=${groupId} SEQUENTIAL 분석 완료, algorithm=${algorithm}`
    );

    return analysisResult;
  } catch (err) {
    // EegRecord 롤백 후 에러 전파함
    await EegRecord.deleteMany({
      _id: { $in: [record1?._id, record2?._id].filter(Boolean) },
    });
    throw err;
  }
};
