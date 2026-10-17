import {
  holdManualStop,
  isManualStopping,
  withGroupLock,
} from './stop-guard.service';

describe('stop-guard — 수동 중지 표시와 그룹 직렬화 (SESSION-W008)', () => {
  it('표시는 subject 단위라 다른 subject 는 표시되지 않음', () => {
    const release = holdManualStop('g1', [1]);

    expect(isManualStopping('g1', 1)).toBe(true);
    expect(isManualStopping('g1', 2)).toBe(false);
    release();
    expect(isManualStopping('g1', 1)).toBe(false);
  });

  it('겹친 수동 중지는 먼저 끝난 쪽이 다른 쪽 표시를 지우지 않음', () => {
    const first = holdManualStop('g2', [1, 2]);
    const second = holdManualStop('g2', [1, 2]);

    first();
    // 같은 해제 함수를 두 번 불러도 참조 횟수를 두 번 깎지 않음
    first();
    expect(isManualStopping('g2', 1)).toBe(true);
    second();
    expect(isManualStopping('g2', 1)).toBe(false);
  });

  it('같은 그룹 작업은 순서대로 실행하고 앞 작업 실패가 뒤를 막지 않음', async () => {
    const order: string[] = [];
    const slow = withGroupLock('g3', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('a');
      throw new Error('실패');
    });
    const fast = withGroupLock('g3', async () => {
      order.push('b');
    });

    await expect(slow).rejects.toThrow('실패');
    await fast;
    expect(order).toEqual(['a', 'b']);
  });
});
