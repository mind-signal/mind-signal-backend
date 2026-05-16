/* eslint-disable camelcase */
import { Schema, model, HydratedDocument } from 'mongoose';

/**
 * MeasurementSample — per-sample provenance 도큐먼트 타입 정의
 *
 * de_ts_ns / proxy_ingress_ts_ns는 나노초 정밀도 정수 문자열로 저장함.
 * String decimal 방식 채택함 (ADR §E 정합).
 */
export interface MeasurementSample {
  group_id: string;
  subject_idx: number;
  de_ts_ns: string;
  proxy_ingress_ts_ns: string;
  seq: number;
  /** 진단용 네트워크 지연 (nullable — Stage-2 채움) */
  network_delay_ms: number | null;
  sync_meta: Record<string, unknown>;
}

/** Mongoose 편의 타입 */
export type MeasurementSampleDoc = HydratedDocument<MeasurementSample>;

/** MeasurementSample Mongoose 스키마 */
const measurementSampleSchema = new Schema<MeasurementSample>(
  {
    group_id: {
      type: String,
      required: true,
    },
    subject_idx: {
      type: Number,
      required: true,
    },
    // 나노초 정밀도 정수를 decimal String으로 저장함
    de_ts_ns: {
      type: String,
      required: true,
    },
    proxy_ingress_ts_ns: {
      type: String,
      required: true,
    },
    seq: {
      type: Number,
      required: true,
    },
    // 진단용 네트워크 지연 — nullable, Stage-2에서 채워짐
    network_delay_ms: {
      type: Number,
      default: null,
    },
    sync_meta: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: false,
    collection: 'measurement_samples',
  }
);

/**
 * 복합 유니크 인덱스 — 멱등성 키로 사용함 (group_id + subject_idx + seq).
 * E11000 중복 오류는 호출 측에서 처리함 (raw propagation).
 */
measurementSampleSchema.index(
  { group_id: 1, subject_idx: 1, seq: 1 },
  { unique: true, name: 'group_id_subject_idx_seq_unique' }
);

/** 모델 생성 및 수출 */
export const MeasurementSampleModel = model<MeasurementSample>(
  'MeasurementSample',
  measurementSampleSchema
);
export default MeasurementSampleModel;
