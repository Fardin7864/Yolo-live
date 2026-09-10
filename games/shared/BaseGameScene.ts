import Phaser from 'phaser';
import { AudioManager } from './AudioManager';
import { getRoundSecondsLeft } from './GameClock';
import { sdk } from './GameSDK';
import { GameStateMachine } from './GameStateMachine';
import type { GameSnapshot, NativeToGameMessage } from './types';

interface ViewerIdentity {
  userId: string | null;
  displayName: string;
  avatarUrl: string | null;
}

interface ActiveBetRequest {
  roundId: string;
  optionId: string;
  amount: number;
  queued: boolean;
}

export abstract class BaseGameScene extends Phaser.Scene {
  protected readonly sdk = sdk;
  protected readonly stateController = new GameStateMachine();
  protected readonly audio = new AudioManager();
  protected snapshot: GameSnapshot | null = null;
  protected selectedAmount = 1000;
  protected activeBetRequests = new Map<string, ActiveBetRequest>();
  protected viewer: ViewerIdentity = { userId: null, displayName: 'Player', avatarUrl: null };
  private displayWalletBalance: number | null = null;
  private wasDisconnected = false;
  private disposers: Array<() => void> = [];
  private resultFallbackTimers = new Set<number>();

  create() {
    this.disposers.push(
      sdk.onMessage('ROUND_STATE', (message) => this.receiveSnapshot(message.payload.snapshot)),
      sdk.onMessage('AUTH', (message) => { this.viewer = message.payload; }),
      sdk.onMessage('WALLET_UPDATE', (message) => {
        this.displayWalletBalance = message.payload.balance;
        this.onWalletUpdate(message.payload.balance);
      }),
      sdk.onMessage('PLACE_BET_RESULT', (message) => this.receiveBetResult(message)),
      sdk.onMessage('BET_BATCH_RESULT', (message) => this.receiveBetBatchResult(message)),
      sdk.onMessage('SOUND_SETTINGS', (message) => this.audio.configure(message.payload.enabled, message.payload.volume)),
      sdk.onMessage('APP_BACKGROUND', () => this.audio.pause()),
      sdk.onMessage('SCREEN_BLUR', () => this.audio.pause()),
      sdk.onMessage('APP_ACTIVE', () => this.audio.resume()),
      sdk.onMessage('SCREEN_FOCUS', () => this.audio.resume()),
      sdk.onMessage('NETWORK_STATE', (message) => {
        const { connected, synchronizing } = message.payload;
        if (!connected) this.wasDisconnected = true;
        else if (this.wasDisconnected) {
          this.wasDisconnected = false;
          this.sdk.requestRefresh('scene-network-reconnected');
        }
        this.onNetworkState(connected, synchronizing);
      }),
      sdk.onMessage('ERROR', (message) => this.showStatus(message.payload.message)),
    );
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
    this.build();
    this.applyEmbeddedLayout();
    this.sdk.requestRefresh('scene-created');
  }

  private applyEmbeddedLayout() {
    if (window.__GAME_EMBEDDED__ !== true) return;

    const [background, ...remaining] = [...this.children.list];
    const backgroundOverlays = remaining.filter((object) => object.name === 'embedded-background-overlay');
    const content = remaining.filter((object) => object.name !== 'embedded-background-overlay');
    const viewportHeight = this.scale.height;
    if (background instanceof Phaser.GameObjects.Image) {
      // Keep one full-width, undistorted background and let the shorter live
      // viewport crop its top and bottom naturally.
      background.setPosition(270, viewportHeight / 2).setDisplaySize(540, 960);
    }
    backgroundOverlays.forEach((object) => {
      if (object instanceof Phaser.GameObjects.Rectangle) {
        object.setPosition(270, viewportHeight / 2).setDisplaySize(540, 960);
      }
    });
    if (!content.length) return;

    const contentScale = Phaser.Math.Clamp((viewportHeight - 12) / 960, 0.48, 0.86);
    content.forEach((object) => {
      const displayObject = object as Phaser.GameObjects.GameObject & {
        setY: (value: number) => unknown;
        setVisible: (visible: boolean) => unknown;
      };
      switch (object.name) {
        case 'embedded-history-panel':
          displayObject.setY(900);
          break;
        case 'embedded-history-label':
          displayObject.setY(858);
          break;
        case 'embedded-history-items':
          displayObject.setY(908);
          break;
        case 'embedded-network-status':
          displayObject.setY(950);
          break;
        case 'embedded-footer':
          displayObject.setVisible(false);
          break;
        default:
          break;
      }
    });
    const contentLayer = this.add.container(
      270 * (1 - contentScale),
      Math.max(6, (viewportHeight - 960 * contentScale) / 2),
      content,
    );
    contentLayer.setScale(contentScale).sort('depth');

    content.forEach((object) => {
      const transform = object as Phaser.GameObjects.GameObject & {
        x: number;
        scaleX: number;
        scaleY: number;
        setScale: (x: number, y?: number) => unknown;
        setX: (value: number) => unknown;
      };
      if (object.getData('embeddedPreserveX') === true) {
        transform.setX(270 + (transform.x - 270) / contentScale);
      }
      const finalScale = Number(object.getData('embeddedFinalScale') || 0);
      if (finalScale > 0) {
        transform.setScale(
          transform.scaleX * finalScale / contentScale,
          transform.scaleY * finalScale / contentScale,
        );
      }
    });
    this.afterEmbeddedLayout();
  }

  protected afterEmbeddedLayout() {}

  protected placeBet(optionId: string) {
    const round = this.snapshot?.round;
    if (!round || this.stateController.phase !== 'BETTING'
      || (round.endsAt && this.snapshot && getRoundSecondsLeft(this.snapshot) <= 0)) {
      this.showStatus('Betting is closed.');
      return;
    }
    // ROUND_STATE/WALLET_UPDATE already expose the projected spendable wallet
    // while requests are pending. Subtracting active requests here again
    // rejects valid rapid taps and can make the balance appear to hit zero.
    if (this.getDisplayWallet(this.snapshot.wallet) < this.selectedAmount) {
      this.showStatus('Insufficient balance.');
      return;
    }
    const requestId = this.sdk.requestBet(round.id, optionId, this.selectedAmount);
    this.activeBetRequests.set(requestId, {
      roundId: round.id,
      optionId,
      amount: this.selectedAmount,
      queued: false,
    });
    const currentDisplayBalance = this.displayWalletBalance ?? this.snapshot.wallet;
    this.displayWalletBalance = Math.max(0, currentDisplayBalance - this.selectedAmount);
    this.onWalletUpdate(this.displayWalletBalance);
    this.onOptimisticBet(optionId, this.selectedAmount, requestId);
    this.audio.play('bet');
  }

  private receiveSnapshot(snapshot: GameSnapshot) {
    const decision = this.stateController.applySnapshot(snapshot);
    if (!decision.accepted) return;
    this.snapshot = snapshot;
    if (decision.newRound) {
      this.activeBetRequests.forEach((request, requestId) => {
        if (request.roundId !== snapshot.round?.id) this.activeBetRequests.delete(requestId);
      });
    }
    if (!this.activeBetRequests.size) this.displayWalletBalance = snapshot.wallet;
    else if (this.displayWalletBalance === null) this.displayWalletBalance = snapshot.wallet;
    else this.displayWalletBalance = Math.min(this.displayWalletBalance, snapshot.wallet);
    this.renderSnapshot(snapshot, decision.newRound);
    if (decision.shouldAnimateResult && snapshot.round?.id && this.stateController.beginResultAnimation(snapshot.round.id)) {
      let completed = false;
      const finishResult = () => {
        if (completed) return;
        completed = true;
        window.clearTimeout(fallbackTimer);
        this.resultFallbackTimers.delete(fallbackTimer);
        const roundId = snapshot.round!.id;
        if (!this.stateController.completeResultAnimation(roundId)) return;
        this.showResult(snapshot);
        this.sdk.send('RESULT_ANIMATION_COMPLETE', { roundId });
      };
      const fallbackTimer = window.setTimeout(finishResult, this.resultAnimationTimeoutMs());
      this.resultFallbackTimers.add(fallbackTimer);
      try {
        this.animateResult(snapshot, finishResult);
      } catch {
        finishResult();
      }
    }
  }

  private receiveBetResult(message: Extract<NativeToGameMessage, { type: 'PLACE_BET_RESULT' }>) {
    const { requestId, accepted, queued, message: errorMessage } = message.payload;
    const request = this.activeBetRequests.get(requestId);
    if (!request) return;
    request.queued = accepted && queued === true;
    if (!accepted || !queued) this.activeBetRequests.delete(requestId);
    this.onBetResponse(requestId, accepted, message.payload.betId, queued);
    if (!accepted) {
      this.recalculateDisplayWallet();
      this.showStatus(errorMessage || 'Bet failed.');
      this.sdk.requestRefresh('bet-rejected');
    } else {
      // "Queued" is an internal detail of the commit debounce, not something the
      // player did wrong: the chip is already on the board and already broadcast
      // to the other seats. Saying "queued" for the length of the debounce read
      // as the bet being stuck. Failures still surface through the !accepted
      // branch above and through BET_BATCH_RESULT.
      this.showStatus('Bet placed');
    }
  }

  private receiveBetBatchResult(message: Extract<NativeToGameMessage, { type: 'BET_BATCH_RESULT' }>) {
    message.payload.requestIds.forEach((requestId) => this.activeBetRequests.delete(requestId));
    if (typeof message.payload.balance === 'number') this.displayWalletBalance = message.payload.balance;
    else this.recalculateDisplayWallet();
    this.onBetBatchResult(message.payload);
    this.onWalletUpdate(this.getDisplayWallet(message.payload.balance ?? this.snapshot?.wallet ?? 0));
    this.sdk.requestRefresh(message.payload.accepted ? 'bet-batch-reconcile' : 'bet-batch-failed');
    if (this.stateController.phase === 'BETTING' || this.stateController.phase === 'BETTING_CLOSED') {
      this.showStatus(message.payload.accepted
        ? 'Bets accepted'
        : message.payload.message || 'Bet batch failed.');
    }
  }

  private cleanup() {
    this.disposers.forEach((dispose) => dispose());
    this.disposers = [];
    this.activeBetRequests.clear();
    this.resultFallbackTimers.forEach((timer) => window.clearTimeout(timer));
    this.resultFallbackTimers.clear();
    this.audio.destroy();
    this.tweens.killAll();
    this.time.removeAllEvents();
  }

  protected abstract build(): void;
  protected getDisplayWallet(authoritativeBalance: number) {
    return this.displayWalletBalance ?? authoritativeBalance;
  }

  private recalculateDisplayWallet() {
    // The native snapshot already contains the projected spendable wallet.
    // Failed requests have been removed before this runs, so use it directly.
    this.displayWalletBalance = Math.max(0, this.snapshot?.wallet ?? this.displayWalletBalance ?? 0);
  }
  protected resultAnimationTimeoutMs() { return 1800; }
  protected abstract renderSnapshot(snapshot: GameSnapshot, newRound: boolean): void;
  protected abstract animateResult(snapshot: GameSnapshot, complete: () => void): void;
  protected abstract showResult(snapshot: GameSnapshot): void;
  protected abstract onOptimisticBet(optionId: string, amount: number, requestId: string): void;
  protected onBetResponse(_requestId: string, _accepted: boolean, _betId?: string, _queued?: boolean): void {}
  protected onBetBatchResult(_result: Extract<NativeToGameMessage, { type: 'BET_BATCH_RESULT' }>['payload']): void {}
  protected abstract onWalletUpdate(balance: number): void;
  protected abstract onNetworkState(connected: boolean, synchronizing: boolean): void;
  protected abstract showStatus(message: string): void;
}
