/**
 * 측정 종료 경합 가드임 (SESSION-W008).
 *
 * 엔진은 측정을 끝낼 때 CSV 를 올리고 백엔드는 그 업로드로 세션을 자연
 * 종료함. 운영자 수동 중지와 측정 시작 실패 정리도 엔진을 멈추므로 같은
 * 업로드가 생김. 이 모듈은 세션 전이를 그룹 단위로 직렬화하고, 수동 중지가
 * 진행 중인 subject 의 업로드가 세션을 자연 종료로 끝내지 않게 표시함.
 *
 * ponytail: 프로세스 안 가드만 있음. 백엔드를 여러 프로세스로 띄우면 DB
 * 조건부 갱신(findOneAndUpdate)으로 바꿔야 함
 */

/** 그룹별 직렬화 체인임 */
const groupLocks = new Map<string, Promise<unknown>>();

/** 수동 중지 진행 중인 `${groupId}:${subjectIndex}` 별 참조 횟수임 */
const manualStops = new Map<string, number>();

/**
 * 같은 그룹의 작업을 프로세스 안에서 순서대로 실행함.
 *
 * @param groupId - 실험 그룹 ID
 * @param fn - 직렬화할 작업
 * @returns 작업 결과 반환
 */
export function withGroupLock<T>(
  groupId: string,
  fn: () => Promise<T>
): Promise<T> {
  const run = (groupLocks.get(groupId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  groupLocks.set(groupId, tail);
  void tail.then(() => {
    if (groupLocks.get(groupId) === tail) groupLocks.delete(groupId);
  });
  return run;
}

/**
 * subject 들에 수동 중지 표시를 걸고 해제 함수를 반환함.
 * 참조 횟수로 관리하므로 겹친 수동 중지가 서로의 표시를 지우지 않음.
 *
 * @param groupId - 실험 그룹 ID
 * @param subjectIndices - 표시할 subject 순번 목록
 * @returns 한 번만 부르는 해제 함수 반환
 */
export function holdManualStop(
  groupId: string,
  subjectIndices: number[]
): () => void {
  const keys = subjectIndices.map((i) => `${groupId}:${i}`);
  keys.forEach((k) => manualStops.set(k, (manualStops.get(k) ?? 0) + 1));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    keys.forEach((k) => {
      const left = (manualStops.get(k) ?? 1) - 1;
      if (left > 0) manualStops.set(k, left);
      else manualStops.delete(k);
    });
  };
}

/**
 * subject 에 수동 중지 표시가 있는지 반환함.
 *
 * @param groupId - 실험 그룹 ID
 * @param subjectIndex - 피실험자 순번
 * @returns 표시 여부 반환
 */
export function isManualStopping(
  groupId: string,
  subjectIndex: number
): boolean {
  return manualStops.has(`${groupId}:${subjectIndex}`);
}
