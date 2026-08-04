/**
 * socket.ts — join-room 핸들러 + emitToGroup 정적/행동 검증 (BE-socket)
 *
 * 검증 항목:
 *   - socket.on('join-room', ...) 핸들러가 socket.ts에 등록됨 (정적)
 *   - emit('join-room', groupId) → socket.join(groupId) 호출됨 (행동)
 *   - 빈 문자열 groupId → ack({ ok: false }) 반환됨
 *   - SocketService.emitToGroup 메서드가 존재함
 */

import * as fs from 'fs';
import * as path from 'path';

const SOCKET_PATH = path.resolve(
  __dirname,
  '../07-shared/lib/socket/socket.ts'
);

// ============================================================
// 정적 검증 — socket.ts 소스 분석
// ============================================================

describe('socket.ts — BE-socket: join-room 핸들러 정적 검증', () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(SOCKET_PATH, 'utf-8');
  });

  it("socket.on('join-room', ...) 핸들러가 등록됨", () => {
    expect(source).toContain("'join-room'");
  });

  it('socket.join(groupId) 호출이 존재함', () => {
    expect(source).toContain('socket.join');
    expect(source).toContain('groupId');
  });

  it('emitToGroup 메서드가 SocketService에 정의됨', () => {
    expect(source).toContain('emitToGroup');
    expect(source).toContain('io.to(groupId)');
  });

  it('join-room 핸들러에 ack 콜백 지원 존재함 (v2 Medium 반영)', () => {
    // ack 함수 선택적 파라미터 존재함
    expect(source).toContain('ack');
    expect(source).toContain('ok: true');
    expect(source).toContain('ok: false');
  });

  it('빈 groupId 유효성 검사가 존재함', () => {
    // groupId.length === 0 또는 typeof 검사 존재함
    expect(source).toMatch(/groupId.*length.*0|typeof.*groupId/s);
  });

  it('disconnect 핸들러가 존재함 (기존 기능 보존)', () => {
    expect(source).toContain("'disconnect'");
  });
});

// join-room 핸들러의 실제 행동 검증은 socket.join-room.test.ts 에 있음.
// 여기 있던 시뮬레이션 describe 는 핸들러 로직을 테스트 안에서 재구현해
// 실제 핸들러를 부르지 않았고, AUTH-W001 로 인증이 추가된 뒤에도 구 계약
// (문자열 payload 를 성공으로 처리)을 그대로 재현하고 있었음. 회귀를 잡지
// 못하면서 틀린 계약을 고정하고 있어 제거함 (CodeRabbit PR #84)
