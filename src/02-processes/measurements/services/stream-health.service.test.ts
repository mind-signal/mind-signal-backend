/**
 * stream-health.service.ts — 스트림 건강 경보 회귀 검증
 *
 * 회귀 배경(2026-07-10 라이브, groupId 6a508a6b1048b553eea41778):
 *   subject_1의 EEG 스트림이 227초 지점에서 끊겼으나 core.main 프로세스는
 *   604.8초까지 살아 있었다. DE watchdog이 headset_status를 발행했지만
 *   measurement.service.ts가 brain_sync_all 외 타입을 전부 버려 어느 화면에도
 *   표시되지 않았고, 운영자는 5분 33초를 헛측정했다.
 *
 * 설계 제약: 경보는 운영자 room으로만 보낸다. 피실험자 화면에 경고를 띄우면
 *   그 불안이 stress 지표(측정 대상 종속변수)를 직접 오염시킨다.
 */

import { StreamHealthTracker } from './stream-health.service';
import { SocketService } from '@07-shared/lib/socket';

jest.mock('@07-shared/lib/socket', () => ({
  SocketService: {
    emitToOperators: jest.fn(),
    emitToGroup: jest.fn(),
  },
}));

const emitToOperators = SocketService.emitToOperators as jest.Mock;
const emitToGroup = SocketService.emitToGroup as jest.Mock;

const GROUP = 'group-abc';
const THRESHOLD = 20_000;

describe('StreamHealthTracker', () => {
  beforeEach(() => jest.clearAllMocks());

  it('정상 수신 중에는 아무 경보도 보내지 않음', () => {
    const t = new StreamHealthTracker(GROUP, THRESHOLD);
    t.recordSample(1, 1000);
    t.checkStale(1500);
    expect(emitToOperators).not.toHaveBeenCalled();
  });

  it('임계 시간 초과 시 stale 경보를 1회만 보냄 (중복 억제)', () => {
    const t = new StreamHealthTracker(GROUP, THRESHOLD);
    t.recordSample(1, 0);

    t.checkStale(THRESHOLD + 1);
    t.checkStale(THRESHOLD + 5000);
    t.checkStale(THRESHOLD + 9000);

    expect(emitToOperators).toHaveBeenCalledTimes(1);
    expect(t.statusOf(1)).toBe('stale');
  });

  it('경보는 운영자 전용 채널로만 나감 (피실험자 room 미사용)', () => {
    const t = new StreamHealthTracker(GROUP, THRESHOLD);
    t.recordSample(2, 0);
    t.checkStale(THRESHOLD + 1);

    expect(emitToOperators).toHaveBeenCalledWith(
      GROUP,
      'stream-health',
      expect.objectContaining({ subjectIndex: 2, status: 'stale' })
    );
    // 그룹 전체(피실험자 포함) 브로드캐스트는 절대 사용하지 않음
    expect(emitToGroup).not.toHaveBeenCalled();
  });

  it('stale 이후 샘플이 다시 오면 복구를 통보함', () => {
    const t = new StreamHealthTracker(GROUP, THRESHOLD);
    t.recordSample(1, 0);
    t.checkStale(THRESHOLD + 1);
    emitToOperators.mockClear();

    t.recordSample(1, THRESHOLD + 2000);

    expect(t.statusOf(1)).toBe('healthy');
    expect(emitToOperators).toHaveBeenCalledWith(
      GROUP,
      'stream-health',
      expect.objectContaining({ status: 'healthy', recovered: true })
    );
  });

  it('정상 수신 중 복구 이벤트를 남발하지 않음', () => {
    const t = new StreamHealthTracker(GROUP, THRESHOLD);
    t.recordSample(1, 0);
    t.recordSample(1, 1000);
    t.recordSample(1, 2000);
    expect(emitToOperators).not.toHaveBeenCalled();
  });

  it('DE가 보낸 disconnected 상태를 반영하고 중복 억제함', () => {
    const t = new StreamHealthTracker(GROUP, THRESHOLD);
    t.recordHeadsetStatus(1, 'disconnected', 100);
    t.recordHeadsetStatus(1, 'disconnected', 200);

    expect(t.statusOf(1)).toBe('disconnected');
    expect(emitToOperators).toHaveBeenCalledTimes(1);
  });

  it('DE의 no_data는 stale로 매핑함', () => {
    const t = new StreamHealthTracker(GROUP, THRESHOLD);
    t.recordHeadsetStatus(2, 'no_data', 100);
    expect(t.statusOf(2)).toBe('stale');
  });

  it('한 subject의 stale이 다른 subject 상태에 영향을 주지 않음', () => {
    const t = new StreamHealthTracker(GROUP, THRESHOLD);
    t.recordSample(1, 0);
    t.recordSample(2, 0);

    // subject 2만 계속 수신함
    t.recordSample(2, THRESHOLD + 1);
    t.checkStale(THRESHOLD + 1);

    expect(t.statusOf(1)).toBe('stale');
    expect(t.statusOf(2)).toBe('healthy');
    expect(emitToOperators).toHaveBeenCalledTimes(1);
  });
});
