import type Phaser from 'phaser';
import type { GameSDK } from './GameSDK';

export class PerformanceManager {
  private frameCount = 0;
  private frameTimeTotal = 0;
  private lastFrameAt = performance.now();
  private lastReportAt = performance.now();
  private initializedAt = performance.now();

  constructor(private readonly game: Phaser.Game, private readonly sdk: GameSDK, private readonly debug: boolean) {
    game.events.on('step', this.onFrame);
  }

  destroy() {
    this.game.events.off('step', this.onFrame);
  }

  private onFrame = () => {
    const now = performance.now();
    this.frameCount += 1;
    this.frameTimeTotal += now - this.lastFrameAt;
    this.lastFrameAt = now;
    const interval = this.debug ? 15000 : 60000;
    if (now - this.lastReportAt < interval) return;
    const elapsedSeconds = (now - this.lastReportAt) / 1000;
    this.sdk.send('PERFORMANCE_METRICS', {
      fps: Math.round((this.frameCount / elapsedSeconds) * 10) / 10,
      frameTimeMs: Math.round((this.frameTimeTotal / Math.max(1, this.frameCount)) * 10) / 10,
      heapBytes: performance.memory?.usedJSHeapSize,
      initializedInMs: Math.round(now - this.initializedAt),
    });
    this.frameCount = 0;
    this.frameTimeTotal = 0;
    this.lastReportAt = now;
  };
}
