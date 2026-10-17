/**
 * /proxy가 처리 중이거나 publish한 샘플의 키 기록임 (EEG-W007).
 *
 * 엔진의 프록시 POST 재시도와 프록시의 재연결 replay가 같은 envelope을 다시
 * 보내므로 (group_id, subject_idx, seq, de_ts_ns)로 거름. 엔진이 같은 그룹에서
 * 재시작하면 seq가 처음부터 다시 매겨지므로 de_ts_ns까지 키에 넣음.
 * 완료 키는 Map/Set 삽입 순서로 가장 오래된 키와 그룹부터 버림.
 * 처리 중 키는 따로 보관해 이 제거에서 빠짐. 함께 버리면 그 키의 재전송이 신규로
 * 판정되어 다시 publish됨 (CodeRabbit PR #122).
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
/** 동시에 처리 중일 수 있는 키 수임. 넘으면 새 요청에 재시도를 요청함 */
export const MAX_IN_FLIGHT = 1024;

/** 완료 키 기록임 */
const seen = new Map<string, Map<number, Set<string>>>();
/** 처리 중 키 기록임. 키는 inFlightKey 형식임 */
const inFlight = new Set<string>();

function sampleKey(seq: number, deTsNs: string): string {
  return `${seq}:${deTsNs}`;
}

// 뒤 세 필드가 숫자라 groupId에 구분자가 있어도 키가 겹치지 않음
function inFlightKey(
  groupId: string,
  subjectIndex: number,
  seq: number,
  deTsNs: string
): string {
  return `${groupId}|${subjectIndex}|${sampleKey(seq, deTsNs)}`;
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
  if (inFlight.has(inFlightKey(groupId, subjectIndex, seq, deTsNs))) {
    return 'in_flight';
  }
  return seen.get(groupId)?.get(subjectIndex)?.has(sampleKey(seq, deTsNs))
    ? 'done'
    : undefined;
}

/**
 * 샘플 키의 상태를 기록함.
 * in_flight는 처리 중 상한(MAX_IN_FLIGHT)에 걸리면 기록하지 않음.
 * done은 처리 중 기록을 지우고 완료 기록에 넣으며, 완료 기록 상한을 넘으면
 * 가장 오래된 것부터 버림.
 *
 * @param groupId - 실험 그룹 식별자임
 * @param subjectIndex - 1-based subject 번호임
 * @param seq - 엔진 샘플 순번임
 * @param deTsNs - 엔진 타임스탬프(ns 십진 문자열)임
 * @param state - 기록할 상태임
 * @returns 기록했으면 true, 처리 중 상한에 걸리면 false 반환
 */
export function markSample(
  groupId: string,
  subjectIndex: number,
  seq: number,
  deTsNs: string,
  state: SampleState
): boolean {
  const key = inFlightKey(groupId, subjectIndex, seq, deTsNs);
  if (state === 'in_flight') {
    if (inFlight.size >= MAX_IN_FLIGHT) return false;
    inFlight.add(key);
    return true;
  }
  inFlight.delete(key);

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
    keys = new Set();
    group.set(subjectIndex, keys);
  }
  keys.add(sampleKey(seq, deTsNs));
  const oldestKey =
    keys.size > MAX_KEYS_PER_SUBJECT && keys.values().next().value;
  if (oldestKey) keys.delete(oldestKey);
  return true;
}

/**
 * publish 실패한 샘플의 처리 중 기록을 지움. 프록시 재전송을 중복으로 버리지 않기 위함임.
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
  inFlight.delete(inFlightKey(groupId, subjectIndex, seq, deTsNs));
}

/** 시험 간 기록 누수 방지용 초기화임 */
export function resetSampleDedupForTest(): void {
  seen.clear();
  inFlight.clear();
}
