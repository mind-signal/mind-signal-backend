export { MeasurementSampleModel } from './model/measurement-sample.schema';
export type {
  MeasurementSample,
  MeasurementSampleDoc,
} from './model/measurement-sample.schema';
export { MeasurementSampleRepository } from './repository/measurement-sample.repository';

import { MeasurementSampleRepository } from './repository/measurement-sample.repository';

/**
 * Production singleton 인스턴스 — 상위 레이어에서 import함.
 * Stateless wrapper — 인스턴스 상태 0건.
 */
export const measurementSampleRepository = new MeasurementSampleRepository();
