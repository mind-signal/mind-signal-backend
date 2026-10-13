/**
 * 메시지 버스의 두 구현(node-redis, MemoryBusClient)이 함께 만족하는 타입임.
 * 호출부가 실제로 쓰는 동작만 선언함.
 */

export type BusListener = (message: string, channel: string) => void;

/** 구독 전용 연결이 제공하는 동작임 */
export interface BusSubscriber {
  connect(): Promise<unknown>;
  subscribe(channel: string, listener: BusListener): Promise<void>;
  unsubscribe(channel?: string): Promise<void>;
  pSubscribe(pattern: string, listener: BusListener): Promise<void>;
  pUnsubscribe(pattern?: string): Promise<void>;
  quit(): Promise<unknown>;
}

/** 발행과 상태 확인에 쓰는 클라이언트가 제공하는 동작임 */
export interface BusClient {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  ping(): Promise<string>;
  publish(channel: string, message: string): Promise<number>;
  duplicate(): BusSubscriber;
}
