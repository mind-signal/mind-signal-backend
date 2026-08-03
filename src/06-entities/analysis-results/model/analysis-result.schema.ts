import { Schema, model, Model, HydratedDocument, Types } from 'mongoose';

/** 1. 문서 필드 타입 정의 */
export interface AnalysisResult {
  groupId: string; // 그룹 식별자
  user1Id: Types.ObjectId; // Subject 1 User 참조
  user2Id: Types.ObjectId; // Subject 2 User 참조
  record1Id: Types.ObjectId; // Subject 1 EEG 기록 참조
  record2Id: Types.ObjectId; // Subject 2 EEG 기록 참조
  matchingScore: number; // 매칭 점수 (0-100)
  synchronyScore: number | null; // 뇌파 동기화 점수
  yScore: number | null; // 파이프라인 Y 점수
  aiComment: string; // AI 분석 코멘트
  markdown: string; // 엔진 분석 markdown 원문
  pipelineResult: Record<string, unknown>; // analyzePipeline 전체 응답 저장
  analysis_mode?: 'DUAL' | 'SEQUENTIAL' | 'BTI'; // 실험 모드 (ADR-14-002)
  similarity_features?: Record<string, unknown>; // 유사도 지표 (ADR-14-009 Mixed type)
}

export interface AnalysisResultMethods {}

export type AnalysisResultDoc = HydratedDocument<
  AnalysisResult,
  AnalysisResultMethods
>;
export type AnalysisResultModel = Model<
  AnalysisResult,
  {},
  AnalysisResultMethods
>;

/** 2. 스키마 정의 */
const analysisResultSchema = new Schema<
  AnalysisResult,
  AnalysisResultModel,
  AnalysisResultMethods
>(
  {
    groupId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    user1Id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    user2Id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    record1Id: {
      type: Schema.Types.ObjectId,
      ref: 'EegRecord',
      required: true,
    },
    record2Id: {
      type: Schema.Types.ObjectId,
      ref: 'EegRecord',
      required: true,
    },
    matchingScore: { type: Number, required: true, min: 0, max: 100 },
    synchronyScore: { type: Number, default: null },
    yScore: { type: Number, default: null },
    aiComment: { type: String, required: true },
    markdown: { type: String, default: '' },
    pipelineResult: { type: Schema.Types.Mixed, default: {} },
    // eslint-disable-next-line camelcase
    analysis_mode: {
      type: String,
      enum: ['DUAL', 'SEQUENTIAL', 'BTI'],
      default: 'DUAL',
    },
    // eslint-disable-next-line camelcase
    similarity_features: {
      type: Schema.Types.Mixed,
      required: false,
      // 예시: { algorithm: "cosine_pearson_faa", similarity_score: 0.73, ... }
      // ADR-14-009: 새 알고리즘 추가 시 shape 변경 자유, 마이그레이션 불필요
    },
  },
  {
    timestamps: true,
    collection: 'analysisResults',
  }
);

/** 3. JSON 변환 로직 */
analysisResultSchema.methods.toJSON = function () {
  const obj = this.toObject() as any;
  obj.id = obj._id;
  delete obj._id;
  delete obj.updatedAt;
  delete obj.createdAt;
  delete obj.__v;
  return obj;
};

export const AnalysisResult = model<AnalysisResult, AnalysisResultModel>(
  'AnalysisResult',
  analysisResultSchema
);
export default AnalysisResult;
