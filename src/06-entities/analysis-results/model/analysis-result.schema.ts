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
  // 분석 파이프라인 이름표임. Session.experimentMode 와 다른 축이고 값도 다름.
  // 여기 'DUAL' 은 experimentMode 의 DUAL 이 아니라 2인 대조 분석 파이프라인을
  // 가리킴 — DUAL_2PC 측정 결과가 이 값으로 저장됨 (ADR-14-002)
  analysis_mode?: 'DUAL' | 'SEQUENTIAL' | 'BTI';
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
    // 이 enum 은 experimentMode 와 별개 축임. SESSION-W002 에서 experimentMode
    // 의 DUAL 과 SEQUENTIAL 을 제거해도 여기는 좁히지 않음 — 과거 분석 결과
    // 문서가 그 값으로 저장돼 있어 좁히면 읽은 뒤 저장에서 깨짐. SEQUENTIAL 은
    // legacy value 로 남기고 신규 쓰기만 금지함
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
