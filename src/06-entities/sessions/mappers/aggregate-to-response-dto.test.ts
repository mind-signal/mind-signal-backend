import { SessionAggregate } from '../domain/session.aggregate';
import { aggregateToPairingResponseDto } from './aggregate-to-response-dto';

describe('aggregateToPairingResponseDto', () => {
  // SessionAggregate.create() 7 인자 stub — Phase G G3 정합
  const baseParams = {
    id: '507f1f77bcf86cd799439020',
    groupId: '507f1f77bcf86cd799439030',
    subjectIndex: 1,
    pairingToken: 'test-token',
    operatorId: '507f1f77bcf86cd799439040',
    mode: 'DUAL_2PC' as const,
    expiresAt: new Date('2026-06-01T00:00:00Z'),
  };

  it('M-1: CREATED 상태 aggregate → DTO 매핑 (userId/pairedAt = null)함', () => {
    const aggregate = SessionAggregate.create(baseParams);
    const dto = aggregateToPairingResponseDto(aggregate);

    expect(dto.id).toBe(baseParams.id);
    expect(dto.status).toBe('CREATED');
    expect(dto.userId).toBeNull();
    expect(dto.pairedAt).toBeNull();
    expect(dto.measuredAt).toBeNull();
    expect(dto.stopReason).toBeNull();
    expect(dto.measuredDurationSeconds).toBeNull();
  });

  it('M-2: PAIRED 상태 aggregate → DTO 매핑 (userId/pairedAt 정상 + measuredAt null)함', () => {
    const aggregate = SessionAggregate.create(baseParams);
    const now = new Date('2026-05-15T10:00:00Z');
    aggregate.pair('507f1f77bcf86cd799439011', now);
    const dto = aggregateToPairingResponseDto(aggregate);

    expect(dto.status).toBe('PAIRED');
    expect(dto.userId).toBe('507f1f77bcf86cd799439011');
    expect(dto.pairedAt).toEqual(now);
    expect(dto.measuredAt).toBeNull();
    expect(dto.stopReason).toBeNull();
    expect(dto.measuredDurationSeconds).toBeNull();
  });

  it('M-3: operatorId(string) → creatorId(string) 필드명 변환함', () => {
    const aggregate = SessionAggregate.create(baseParams);
    const dto = aggregateToPairingResponseDto(aggregate);

    expect(dto.creatorId).toBe(baseParams.operatorId);
    expect(dto).not.toHaveProperty('operatorId');
  });

  it('M-4: mode → experimentMode 필드명 변환함 (2 enum 값)', () => {
    const modes = ['BTI', 'DUAL_2PC'] as const;
    for (const mode of modes) {
      const aggregate = SessionAggregate.create({ ...baseParams, mode });
      const dto = aggregateToPairingResponseDto(aggregate);
      expect(dto.experimentMode).toBe(mode);
      expect(dto).not.toHaveProperty('mode');
    }
  });

  it('M-5: operatorId = null → creatorId = null 변환함 (CX-1 nullable 보존)', () => {
    // SessionAggregate.create() invariant — operatorId null 허용됨 (pairingToken/subjectIndex만 검증)
    const aggregate = SessionAggregate.create({
      ...baseParams,
      operatorId: null,
    });
    const dto = aggregateToPairingResponseDto(aggregate);
    expect(dto.creatorId).toBeNull();
  });
});
