/**
 * /proxy가 처리 중이거나 publish한 샘플의 키 기록임 (EEG-W007).
 *
 * 엔진의 프록시 POST 재시도와 프록시의 재연결 replay가 같은 envelope을 다시
 * 보내므로 (group_id, subject_idx, seq, de_ts_ns)로 거름. 엔진이 같은 그룹에서
 * 재시작하면 seq가 처음부터 다시 매겨지므로 de_ts_ns까지 키에 넣음.
 * Map 삽입 순서로 가장 오래된 키와 그룹부터 버림.
 */

/**
 * 키 상태임. in_flight는 publish 중, done은 publish 완료임.
 * 둘을 나누는 이유: 처리 중 사본에 duplicate ack를 주면 프록시가 같은 큐 항목을
 * dequeue하고, 그 뒤 첫 publish가 실패하면 재전송 경로 없이 샘플이 사라짐
 */
export type SampleState = 'in_flight' | 'done';

/** 그룹과 subject마다 보관하는 최근 키 수임. 1Hz 기준 약 68분 분량임 */
export const MAX_KEYS_PER_SUBJECT = 4096;
/** 보관하는 최근 그룹 수임 */
export const MAX_GROUPS = 64;

const seen = new Map<string, Map<number, Map<string, SampleState>>>();

function sampleKey(seq: number, deTsNs: string): string {
  return `${seq}:${deTsNs}`;
}

/**
 * 샘플 키의 상태를 반환함.
 *
 * @param groupId - 실험 그룹 식별자임
 * @param subjectIndex - 1-based subject 번호임
 * @param seq - 엔진 샘플 순번임
 * @param deTsNs - 엔진 타임스탬프(ns 십진 문자열)임
 * @returns 기록된 상태, 처음 보는 키면 undefined 반환
 */
export function sampleState(
  groupId: string,
  subjectIndex: number,
  seq: number,
  deTsNs: string
): SampleState | undefined {
  return seen.get(groupId)?.get(subjectIndex)?.get(sampleKey(seq, deTsNs));
}

/**
 * 샘플 키의 상태를 기록함. 상한을 넘으면 가장 오래된 것부터 버림.
 *
 * @param groupId - 실험 그룹 식별자임
 * @param subjectIndex - 1-based subject 번호임
 * @param seq - 엔진 샘플 순번임
 * @param deTsNs - 엔진 타임스탬프(ns 십진 문자열)임
 * @param state - 기록할 상태임
 */
export function markSample(
  groupId: string,
  subjectIndex: number,
  seq: number,
  deTsNs: string,
  state: SampleState
): void {
  let group = seen.get(groupId);
  if (group) {
    // 최근 사용 그룹을 맨 뒤로 옮겨 제거 순서에서 미룸
    seen.delete(groupId);
  } else {
    group = new Map();
  }
  seen.set(groupId, group);
  const oldestGroup = seen.size > MAX_GROUPS && seen.keys().next().value;
  if (oldestGroup) seen.delete(oldestGroup);

  let keys = group.get(subjectIndex);
  if (!keys) {
    keys = new Map();
    group.set(subjectIndex, keys);
  }
  keys.set(sampleKey(seq, deTsNs), state);
  const oldestKey =
    keys.size > MAX_KEYS_PER_SUBJECT && keys.keys().next().value;
  if (oldestKey) keys.delete(oldestKey);
}

/**
 * publish 실패한 샘플 키를 지움. 프록시 재전송을 중복으로 버리지 않기 위함임.
 *
 * @param groupId - 실험 그룹 식별자임
 * @param subjectIndex - 1-based subject 번호임
 * @param seq - 엔진 샘플 순번임
 * @param deTsNs - 엔진 타임스탬프(ns 십진 문자열)임
 */
export function unmarkSample(
  groupId: string,
  subjectIndex: number,
  seq: number,
  deTsNs: string
): void {
  seen.get(groupId)?.get(subjectIndex)?.delete(sampleKey(seq, deTsNs));
}

/** 시험 간 기록 누수 방지용 초기화임 */
export function resetSampleDedupForTest(): void {
  seen.clear();
}
