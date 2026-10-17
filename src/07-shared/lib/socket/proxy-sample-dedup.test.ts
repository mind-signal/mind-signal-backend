import {
  hasSample,
  markSample,
  MAX_GROUPS,
  MAX_KEYS_PER_SUBJECT,
  resetSampleDedupForTest,
} from './proxy-sample-dedup';

describe('proxy-sample-dedup 상한 (EEG-W007)', () => {
  beforeEach(() => {
    resetSampleDedupForTest();
  });

  it('subject 상한을 넘으면 가장 오래된 키부터 제거함', () => {
    for (let seq = 0; seq <= MAX_KEYS_PER_SUBJECT; seq++) {
      markSample('g', 1, seq, `${seq}`);
    }
    expect(hasSample('g', 1, 0, '0')).toBe(false);
    expect(hasSample('g', 1, 1, '1')).toBe(true);
    expect(
      hasSample('g', 1, MAX_KEYS_PER_SUBJECT, `${MAX_KEYS_PER_SUBJECT}`)
    ).toBe(true);
  });

  it('그룹 상한을 넘으면 가장 오래 쓰지 않은 그룹부터 제거함', () => {
    for (let i = 0; i < MAX_GROUPS; i++) markSample(`g${i}`, 1, 0, '0');
    // g0을 다시 써서 최근 그룹으로 옮김
    markSample('g0', 1, 1, '1');
    markSample('g-new', 1, 0, '0');

    expect(hasSample('g0', 1, 0, '0')).toBe(true);
    expect(hasSample('g1', 1, 0, '0')).toBe(false);
    expect(hasSample('g-new', 1, 0, '0')).toBe(true);
  });
});
