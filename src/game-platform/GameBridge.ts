import type { WebView } from 'react-native-webview';
import {
  createBridgeMessage,
  isGameToNativeMessage,
  type GameId,
  type GameToNativeMessage,
  type NativeToGameMessage,
} from './GameMessageTypes';

type Listener = (message: GameToNativeMessage) => void;

export class NativeGameBridge {
  private webView: WebView | null = null;
  private ready = false;
  private queue: NativeToGameMessage[] = [];
  private listeners = new Set<Listener>();

  constructor(private readonly gameId: GameId) {}

  attach(webView: WebView | null) {
    this.webView = webView;
    if (webView && this.ready) this.flush();
  }

  reset() {
    this.ready = false;
    this.queue = [];
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receive(raw: string) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isGameToNativeMessage(parsed) || parsed.gameId !== this.gameId) return false;
      if (parsed.type === 'GAME_READY') {
        this.ready = true;
        this.flush();
      }
      this.listeners.forEach((listener) => listener(parsed));
      return true;
    } catch {
      return false;
    }
  }

  send<T extends NativeToGameMessage['type']>(
    type: T,
    payload: Extract<NativeToGameMessage, { type: T }>['payload'],
  ) {
    const message = createBridgeMessage(
      this.gameId,
      type,
      payload,
    ) as Extract<NativeToGameMessage, { type: T }>;
    if (!this.ready || !this.webView) {
      this.queue.push(message);
      return;
    }
    this.post(message);
  }

  private flush() {
    const queued = this.queue;
    this.queue = [];
    queued.forEach((message) => this.post(message));
  }

  private post(message: NativeToGameMessage) {
    this.webView?.postMessage(JSON.stringify(message));
  }
}
