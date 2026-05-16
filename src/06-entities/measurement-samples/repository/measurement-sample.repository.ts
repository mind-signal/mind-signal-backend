/**
 * measurement-sample.repository.ts — MeasurementSample DB 접근 어댑터
 *
 * FSD 06-entities 레이어 — 상위 레이어 import 0건.
 * E11000 중복 키 오류는 raw propagation — 호출 측(02-processes)이 처리함.
 */

import { MeasurementSampleModel } from '../model/measurement-sample.schema';
import type { MeasurementSample } from '../model/measurement-sample.schema';

export class MeasurementSampleRepository {
  /**
   * 샘플 도큐먼트를 DB에 삽입함.
   *
   * @param doc - 삽입할 MeasurementSample 필드 객체
   * @returns 생성된 도큐먼트
   * @throws Mongoose E11000 — 복합 유니크 인덱스 충돌 시 raw propagation
   */
  async create(doc: MeasurementSample) {
    return MeasurementSampleModel.create(doc);
  }
}
