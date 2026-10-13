/**
 * MESSAGE_BUS=memory 전용 프로세스 내부 pub/sub 클라이언트.
 *
 * Redis 없이 PC 앱으로 배포하기 위한 대체 구현임. 호출부가 실제로 쓰는
 * 동작(publish, subscribe/unsubscribe, pSubscribe/pUnsubscribe, ping,
 * duplicate, connect, quit)만 node-redis와 같은 이름으로 제공함.
 * 전달 범위는 같은 프로세스 안으로 한정됨 — 다른 프로세스는 받지 못함.
 */

import type { BusClient } from './message-bus.types';

type Listener = (message: string, channel: string) => void;
type Handler = (channel: string, message: string) => boolean;

// 프로세스 전체가 공유하는 구독 핸들러 집합임
const handlers = new Set<Handler>();

/** glob 패턴의 `*`만 지원함 (호출부가 쓰는 `mind-signal:*` 범위). */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`);
}

export class MemoryBusClient implements BusClient {
  /** redisService.connect()가 실제 연결을 시도하지 않도록 항상 true임. */
  public readonly isOpen = true;

  // 키: `c:{channel}` 또는 `p:{pattern}` — 해제 시 대상 식별에 사용함
  private readonly owned = new Map<string, Handler>();

  /** 구독 전용 연결을 흉내 내는 독립 클라이언트 반환. */
  public duplicate(): MemoryBusClient {
    return new MemoryBusClient();
  }

  public async connect(): Promise<void> {
    // 연결 대상 없음
  }

  public async ping(): Promise<string> {
    return 'PONG';
  }

  /**
   * 채널 구독자에게 메시지를 동기 전달함.
   *
   * @param channel - 발행 채널명
   * @param message - 전달할 문자열
   * @returns 메시지를 받은 구독 수 반환
   */
  public async publish(channel: string, message: string): Promise<number> {
    let delivered = 0;
    // 전달 도중 해제되어도 순회가 깨지지 않게 복사본 사용함
    for (const handler of [...handlers]) {
      if (handler(channel, message)) delivered += 1;
    }
    return delivered;
  }

  public async subscribe(channel: string, listener: Listener): Promise<void> {
    this.add(`c:${channel}`, (c) => c === channel, listener);
  }

  public async unsubscribe(channel?: string): Promise<void> {
    this.remove('c:', channel);
  }

  public async pSubscribe(pattern: string, listener: Listener): Promise<void> {
    const regExp = patternToRegExp(pattern);
    this.add(`p:${pattern}`, (c) => regExp.test(c), listener);
  }

  public async pUnsubscribe(pattern?: string): Promise<void> {
    this.remove('p:', pattern);
  }

  /** 이 클라이언트의 모든 구독 해제함. */
  public async quit(): Promise<void> {
    this.remove('');
  }

  public async disconnect(): Promise<void> {
    this.remove('');
  }

  private add(
    key: string,
    matches: (channel: string) => boolean,
    listener: Listener
  ): void {
    const previous = this.owned.get(key);
    if (previous) handlers.delete(previous);
    const handler: Handler = (channel, message) => {
      if (!matches(channel)) return false;
      try {
        listener(message, channel);
      } catch (err) {
        // 구독자 예외가 발행자(/proxy ack)로 번지지 않게 격리함
        console.error(`[memory-bus] ${channel} 구독자 에러:`, err);
      }
      return true;
    };
    this.owned.set(key, handler);
    handlers.add(handler);
  }

  // name 생략 시 prefix로 시작하는 구독 전부 해제함
  private remove(prefix: string, name?: string): void {
    for (const [key, handler] of [...this.owned]) {
      const hit =
        name === undefined ? key.startsWith(prefix) : key === prefix + name;
      if (!hit) continue;
      handlers.delete(handler);
      this.owned.delete(key);
    }
  }
}
