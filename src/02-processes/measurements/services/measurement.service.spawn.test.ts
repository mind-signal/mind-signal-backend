/**
 * measurement.service.ts — 엔진 프록시 방식 전환 검증
 *
 * 수정 이후 measurement.service.ts는:
 *   - child_process.spawn을 직접 사용하지 않음
 *   - engineProxyService.streamStart()를 통해 엔진에 HTTP 요청함
 *   - groupId와 subjectIndex를 전달함
 *   - Redis subscribe / Socket.io emit 로직은 유지함
 */

import * as fs from 'fs';
import * as path from 'path';

describe('measurement.service.ts: 엔진 프록시 방식 전환 검증', () => {
  let serviceSource: string;

  beforeAll(() => {
    const servicePath = path.resolve(__dirname, 'measurement.service.ts');
    serviceSource = fs.readFileSync(servicePath, 'utf-8');
  });

  it('서비스가 child_process spawn을 직접 사용하지 않음', () => {
    expect(serviceSource).not.toContain("from 'child_process'");
    expect(serviceSource).not.toContain('import { spawn }');
  });

  it('서비스가 engineProxyService를 import함', () => {
    expect(serviceSource).toContain('engineProxyService');
  });

  it('서비스가 streamStart를 호출함', () => {
    expect(serviceSource).toContain('streamStart');
  });

  it('서비스가 groupId를 전달함', () => {
    expect(serviceSource).toContain('groupId');
  });

  it('서비스가 subjectIndex를 전달함', () => {
    expect(serviceSource).toContain('subjectIndex');
  });

  it('서비스가 Redis subscribe 로직을 유지함', () => {
    expect(serviceSource).toContain('subscriber.subscribe');
    expect(serviceSource).toContain('mind-signal:');
  });

  it('서비스가 eeg-live를 세션 그룹 room으로 emit함', () => {
    // AUTH-W001 에서 전역 emitLiveEvent 를 그룹 room emitToGroup 으로 바꿨음.
    // emitter 와 room 인자와 이벤트명을 한 패턴으로 묶어 확인함 — 셋을 따로 찾으면
    // 다른 호출부의 문자열에 걸려 이 자리가 사라져도 통과함 (CodeRabbit PR #84)
    expect(serviceSource).toMatch(
      /SocketService\.emitToGroup\(\s*session\.groupId,\s*'eeg-live'/
    );
  });

  it('서비스가 스트림 시작 실패 시 세션을 CANCELLED로 롤백함', () => {
    expect(serviceSource).toContain("'CANCELLED'");
  });
});
