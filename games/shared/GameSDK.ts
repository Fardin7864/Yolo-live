import Phaser from 'phaser';
import {
  createBridgeMessage,
  GAME_PROTOCOL_VERSION,
  NATIVE_MESSAGE_TYPES,
  type GameToNativeMessage,
  type NativeToGameMessage,
} from '../../src/game-platform/GameMessageTypes';
import type { GameBootstrap, GameId } from './types';

type MessageType = NativeToGameMessage['type'];
type MessageListener<T extends MessageType> = (message: Extract<NativeToGameMessage, { type: T }>) => void;

export class GameSDK extends Phaser.Events.EventEmitter {
  readonly gameId: GameId;
  private seenMessages = new Set<string>();
  private latestByType = new Map<MessageType, NativeToGameMessage>();

  constructor() {
    super();
    this.gameId = window.__GAME_ID__;
    window.addEventListener('message', this.handleMessage);
    document.addEventListener('message', this.handleMessage as EventListener);
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleRejection);
  }

  announceReady() {
    this.send('GAME_READY', { initializedAt: Date.now() });
  }

  onMessage<T extends MessageType>(type: T, listener: MessageListener<T>) {
    this.on(type, listener);
    const latest = this.latestByType.get(type) as Extract<NativeToGameMessage, { type: T }> | undefined;
    if (latest) queueMicrotask(() => listener(latest));
    return () => this.off(type, listener);
  }

  requestBet(roundId: string, optionId: string, amount: number) {
    const requestId = `${roundId}-${optionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.send('PLACE_BET', { requestId, roundId, optionId, amount });
    return requestId;
  }

  requestCrashBet(roundId: string, amount: number, autoCashoutBp?: number) {
    const requestId = `crash-bet-${roundId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.send('PLACE_CRASH_BET', { requestId, roundId, amount, autoCashoutBp });
    return requestId;
  }

  requestCashout(roundId: string, betId: string) {
    const requestId = `crash-cashout-${roundId}-${betId}-${Date.now()}`;
    this.send('CASH_OUT', { requestId, roundId, betId });
    return requestId;
  }

  requestRefresh(reason: string) {
    this.send('REQUEST_STATE_REFRESH', { reason });
  }

  send<T extends GameToNativeMessage['type']>(
    type: T,
    payload: Extract<GameToNativeMessage, { type: T }>['payload'],
  ) {
    const message = createBridgeMessage(
      this.gameId,
      type,
      payload,
    ) as Extract<GameToNativeMessage, { type: T }>;
    window.ReactNativeWebView?.postMessage(JSON.stringify(message));
  }

  destroy() {
    window.removeEventListener('message', this.handleMessage);
    document.removeEventListener('message', this.handleMessage as EventListener);
    window.removeEventListener('error', this.handleWindowError);
    window.removeEventListener('unhandledrejection', this.handleRejection);
    this.removeAllListeners();
  }

  private handleMessage = (event: MessageEvent) => {
    try {
      const message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (!message || message.protocolVersion !== GAME_PROTOCOL_VERSION) return;
      if (message.gameId !== this.gameId || !NATIVE_MESSAGE_TYPES.has(message.type)) return;
      if (this.seenMessages.has(message.messageId)) return;
      this.seenMessages.add(message.messageId);
      if (this.seenMessages.size > 200) {
        const oldest = this.seenMessages.values().next().value;
        if (oldest) this.seenMessages.delete(oldest);
      }
      this.latestByType.set(message.type, message);
      this.emit(message.type, message);
    } catch {
      this.send('BRIDGE_ERROR', { message: 'Native message was not valid JSON.' });
    }
  };

  private handleWindowError = (event: ErrorEvent) => {
    this.send('ERROR', {
      code: 'PHASER_RUNTIME',
      message: event.message || 'Unknown game error.',
      fatal: true,
      stack: event.error?.stack,
    });
  };

  private handleRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    this.send('ERROR', { code: 'UNHANDLED_PROMISE', message: reason.message, fatal: false, stack: reason.stack });
  };
}

export const sdk = new GameSDK();

export async function waitForBootstrap(): Promise<GameBootstrap> {
  return new Promise((resolve) => {
    const dispose = sdk.onMessage('INIT', (message) => {
      dispose();
      resolve({ gameId: message.gameId, ...message.payload });
    });
    sdk.announceReady();
  });
}
