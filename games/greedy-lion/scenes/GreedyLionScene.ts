import Phaser from 'phaser';
import { BaseGameScene } from '../../shared/BaseGameScene';
import { loadEmbeddedAssets } from '../../shared/AssetLoader';
import type { GamePublicBet, GameSnapshot, NativeToGameMessage } from '../../shared/types';
import background from '../assets/background.webp';
import wheel from '../assets/wheel.webp';
import crownedLion from '../assets/crowned-lion.webp';
import corn from '../assets/corn.webp';
import chicken from '../assets/chicken.webp';
import shrimp from '../assets/shrimp.webp';
import tomato from '../assets/tomato.webp';
import ham from '../assets/ham.webp';
import pepper from '../assets/pepper.webp';
import fish from '../assets/fish.webp';
import carrot from '../assets/carrot.webp';
import pizzaFood from '../assets/pizza-food.webp';
import saladFood from '../assets/salad-food.webp';
import balanceDiamond from '../assets/balance-diamond.webp';
import chip1k from '../../shared/assets/chip_1k.webp';
import chip5k from '../../shared/assets/chip_5k.webp';
import chip50k from '../../shared/assets/chip_50k.webp';
import chip100k from '../../shared/assets/chip_100k.webp';
import { CHIP_AMOUNTS, GREEDY_ITEMS } from '../config';
import { createInfoOverlay } from '../../shared/InfoOverlay';
import { createPlayerBetFeed, createRankingOverlay, type PlayerBetFeed, type RankingOverlay } from '../../shared/GameHud';
import { getRoundSecondsLeft } from '../../shared/GameClock';

const money = (value: number) => Math.round(value || 0).toLocaleString('en-US');
const compact = (value: number) => value >= 1000 ? `${value / 1000}K` : String(value);
const compactItemAmount = (value: number) => {
  const amount = Math.round(Number(value) || 0);
  const format = (divisor: number, suffix: string) => {
    const scaled = amount / divisor;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${suffix}`;
  };
  if (Math.abs(amount) >= 1e15) return format(1e15, 'q');
  if (Math.abs(amount) >= 1e12) return format(1e12, 't');
  if (Math.abs(amount) >= 1e9) return format(1e9, 'b');
  if (Math.abs(amount) >= 1e6) return format(1e6, 'm');
  if (Math.abs(amount) >= 1e3) return format(1e3, 'k');
  return String(amount);
};
const compactBalanceAmount = (value: number) => {
  const amount = Math.round(Number(value) || 0);
  const format = (divisor: number, suffix: string) => {
    const scaled = amount / divisor;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${suffix}`;
  };
  if (Math.abs(amount) >= 1e15) return format(1e15, 'q');
  if (Math.abs(amount) >= 1e12) return format(1e12, 't');
  if (Math.abs(amount) >= 1e9) return format(1e9, 'b');
  if (Math.abs(amount) >= 1e6) return format(1e6, 'm');
  return amount.toLocaleString('en-US');
};
const itemLayout = (embedded: boolean) => ({
  halfWidth: embedded ? 56 : 48,
  top: embedded ? -58 : -47,
  height: embedded ? 144 : 110,
});

interface ItemView {
  container: Phaser.GameObjects.Container;
  frame: Phaser.GameObjects.Graphics;
  total: Phaser.GameObjects.Text;
  mine: Phaser.GameObjects.Text;
}

export class GreedyLionScene extends BaseGameScene {
  private itemViews = new Map<string, ItemView>();
  private chipSelectionRings = new Map<number, Phaser.GameObjects.Graphics>();
  private chipSelectionMarks = new Map<number, Phaser.GameObjects.Text>();
  private wheelImage!: Phaser.GameObjects.Image;
  private timerText!: Phaser.GameObjects.Text;
  private walletText?: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private historyItems!: Phaser.GameObjects.Container;
  private networkText!: Phaser.GameObjects.Text;
  private resultOverlay!: Phaser.GameObjects.Container;
  private resultTitle!: Phaser.GameObjects.Text;
  private resultDetail!: Phaser.GameObjects.Text;
  private resultWinnerImage!: Phaser.GameObjects.Image;
  private resultCountdownText!: Phaser.GameObjects.Text;
  private rulesOverlay!: Phaser.GameObjects.Container;
  private rankingOverlay!: RankingOverlay;
  private bettorFeed!: PlayerBetFeed;
  private soundButton!: Phaser.GameObjects.Text;
  private optimisticFeed: Array<GamePublicBet & { requestId: string }> = [];
  private settlementStep?: Phaser.Time.TimerEvent;
  private resultCountdown?: Phaser.Time.TimerEvent;
  private resultRoundId: string | null = null;
  private bettingOpen = false;
  private highlightIndex = -1;
  private highlightStep = 0;
  private lastTimerSecond = -1;

  constructor() {
    super({ key: 'GreedyLionScene' });
  }

  preload() {
    loadEmbeddedAssets(this, {
      background, wheel, crownedLion, corn, chicken, shrimp, tomato, ham, pepper, fish, carrot,
      pizzaFood, saladFood, balanceDiamond, chip1k, chip5k, chip50k, chip100k,
    });
  }

  protected build() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    this.add.image(270, 480, 'background').setDisplaySize(540, 960);
    if (embedded) this.add.rectangle(270, 480, 540, 960, 0x020309, 0.67).setName('embedded-background-overlay');
    if (embedded) {
      const balanceBackground = this.add.graphics().setPosition(52, 48)
        .setData('embeddedPreserveX', true)
        .setData('embeddedFinalScale', 1)
        .setDepth(18);
      balanceBackground.fillStyle(0x130d20, 0.96).fillRoundedRect(-46, -18, 92, 36, 18)
        .lineStyle(2, 0xe6bd55, 0.9).strokeRoundedRect(-46, -18, 92, 36, 18);
      this.add.image(21, 48, 'balanceDiamond').setDisplaySize(22, 22)
        .setData('embeddedPreserveX', true)
        .setData('embeddedFinalScale', 1)
        .setDepth(19);
      this.walletText = this.add.text(63, 48, '0', {
        fontFamily: 'Arial', fontSize: '16px', color: '#FFFFFF', fontStyle: 'bold',
        align: 'center',
      }).setOrigin(0.5).setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1).setDepth(19);
    }
    this.bettorFeed = createPlayerBetFeed(this, embedded ? 190 : 80, { showAmount: !embedded, showChrome: !embedded, vertical: embedded });
    this.wheelImage = this.add.image(270, embedded ? 395 : 390, 'wheel').setDisplaySize(embedded ? 440 : 430, embedded ? 480 : 465).setAlpha(0.9).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.94 : 0);
    GREEDY_ITEMS.forEach((item, index) => this.createItem(item, index));
    this.add.image(270, embedded ? 395 : 390, 'crownedLion').setDisplaySize(embedded ? 116 : 104, embedded ? 116 : 104).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    this.add.circle(270, embedded ? 464 : 454, embedded ? 38 : 34, 0x21152c, 0.96).setStrokeStyle(2, 0xffd76a, 0.9);
    this.timerText = this.add.text(270, embedded ? 464 : 454, '--', {
      fontFamily: 'Arial', fontSize: embedded ? '23px' : '20px', color: '#FFE075', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.statusText = this.add.text(270, embedded ? 512 : 498, 'Place your bets', {
      fontFamily: 'Arial', fontSize: embedded ? '15px' : '13px', color: '#FFF5D2', fontStyle: 'bold',
      backgroundColor: '#291631', padding: { x: 10, y: 5 },
    }).setOrigin(0.5);

    this.add.image(62, embedded ? 682 : 650, 'saladFood').setDisplaySize(embedded ? 88 : 108, embedded ? 63 : 77).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.9 : 0);
    this.add.image(478, embedded ? 682 : 650, 'pizzaFood').setDisplaySize(embedded ? 88 : 108, embedded ? 61 : 74).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.9 : 0);

    this.add.text(270, embedded ? 718 : 696, 'SELECT CHIP', { fontFamily: 'Arial', fontSize: embedded ? '13px' : '11px', color: '#D6CEE0', fontStyle: 'bold' }).setOrigin(0.5).setVisible(!embedded);
    if (embedded) {
      const chipTray = this.add.graphics().setPosition(270, 772).setDepth(5)
        .setData('embeddedPreserveX', true)
        .setData('embeddedFinalScale', 1);
      chipTray.fillStyle(0x130d20, 0.46).fillRoundedRect(-155, -25, 310, 50, 18);
    }
    CHIP_AMOUNTS.forEach((amount, index) => this.createChip(amount, embedded ? 150 + index * 80 : 108 + index * 108, embedded ? 754 : 748));

    const historyPanel = embedded
      ? this.add.graphics().setPosition(270, 842)
        .fillStyle(0x140f24, 0.92).fillRoundedRect(-250, -32, 500, 64, 20)
        .lineStyle(1, 0xe4b958, 0.45).strokeRoundedRect(-250, -32, 500, 64, 20)
      : this.add.rectangle(270, 842, 500, 82, 0x140f24, 0.92).setStrokeStyle(1, 0xe4b958, 0.45);
    historyPanel.setName('embedded-history-panel').setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    this.add.text(embedded ? 270 : 34, 807, 'RESULT HISTORY', { fontFamily: 'Arial', fontSize: embedded ? '11px' : '10px', color: '#D1B77A', fontStyle: 'bold' }).setOrigin(embedded ? 0.5 : 0, 0.5).setName('embedded-history-label').setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    this.historyItems = this.add.container(0, embedded ? 843 : 0).setName('embedded-history-items').setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0).setInteractive(new Phaser.Geom.Rectangle(20, embedded ? -38 : 805, 500, 78), Phaser.Geom.Rectangle.Contains);
    this.historyItems.on('pointerdown', () => this.sdk.send('OPEN_HISTORY', {}));
    this.networkText = this.add.text(270, 904, '', { fontFamily: 'Arial', fontSize: '12px', color: '#FFDD82', fontStyle: 'bold' }).setOrigin(0.5).setName('embedded-network-status');

    this.add.text(270, 934, 'Tap an item to bet • Backend controls every result', { fontFamily: 'Arial', fontSize: '10px', color: '#D6D0DD', fontStyle: 'bold' }).setOrigin(0.5).setName('embedded-footer');
    this.createResultOverlay();
    this.rulesOverlay = createInfoOverlay(this, 'HOW TO PLAY', [
      'Choose a chip and tap up to six different items during betting.',
      'You can add more bets to an item you already selected.',
      'The backend selects and settles the winner. The wheel is visual only.',
      'Your wallet updates after the backend accepts and settles each bet.',
    ], { largeText: true, scrollable: true, fullScreen: embedded });
    this.rankingOverlay = createRankingOverlay(this, { largeText: true, scrollable: true, fullScreen: embedded });
    this.createHeaderButton('RANK', embedded ? 510 : 392, () => this.rankingOverlay.show(), embedded ? 46 : 66, embedded ? 95 : undefined);
    this.createHeaderButton('?', embedded ? 510 : 460, () => {
      this.sdk.send('OPEN_RULES', {});
      this.rulesOverlay.setVisible(true);
      this.children.bringToTop(this.rulesOverlay);
    }, embedded ? 38 : 34, embedded ? 215 : undefined);
    this.soundButton = this.createHeaderButton('♪', embedded ? 510 : 505, () => {
      const enabled = this.audio.toggle();
      this.soundButton.setText(enabled ? '♪' : '×');
      this.showStatus(enabled ? 'Sound enabled' : 'Sound muted');
    }, embedded ? 38 : 34, embedded ? 335 : undefined);
  }

  update() {
    const snapshot = this.snapshot;
    if (!snapshot?.round?.endsAt || snapshot.phase === 'RESULT_RECEIVED') return;
    const seconds = getRoundSecondsLeft(snapshot);
    if (seconds === this.lastTimerSecond) return;
    this.lastTimerSecond = seconds;
    this.timerText.setText(`${seconds}s`);
    if (seconds === 0) {
      this.setBettingEnabled(false);
      this.startSettlementSpin();
      this.sdk.requestRefresh('countdown-ended');
    }
  }

  protected renderSnapshot(snapshot: GameSnapshot, newRound: boolean) {
    this.walletText?.setText(compactBalanceAmount(snapshot.wallet));
    if (newRound) {
      this.stopSettlementSpin();
      this.resultCountdown?.remove(false);
      this.resultCountdown = undefined;
      this.resultRoundId = null;
      this.tweens.killAll();
      this.time.removeAllEvents();
      this.resultOverlay.setVisible(false);
      this.setBettingEnabled(true);
      this.setHighlight(-1);
      this.statusText.setText('Place your bets');
      this.lastTimerSecond = -1;
      this.optimisticFeed = [];
    }
    const unmatchedServerBets = [...snapshot.publicBets];
    this.optimisticFeed = this.optimisticFeed.filter((pending) => {
      const matchIndex = unmatchedServerBets.findIndex((serverBet) => (
        (!!pending.id && !!serverBet.id && String(serverBet.id) === String(pending.id))
        || (
          !!this.viewer.userId
          && serverBet.userId === this.viewer.userId
          && serverBet.position === pending.position
          && serverBet.amount === pending.amount
          && Math.abs((Date.parse(serverBet.createdAt || '') || 0) - (Date.parse(pending.createdAt || '') || 0)) < 15000
        )
      ));
      if (matchIndex < 0) return true;
      unmatchedServerBets.splice(matchIndex, 1);
      return false;
    });
    const displayBets = snapshot.publicBets.flatMap((bet) => {
      if (this.viewer.userId && bet.userId === this.viewer.userId) {
        return [{
          ...bet,
          name: bet.name === 'Player' ? this.viewer.displayName : bet.name,
          avatarUrl: bet.avatarUrl || this.viewer.avatarUrl,
        }];
      }
      // Realtime rows arrive before their profile lookup. Keep pot totals
      // immediate, but do not flash a second anonymous "Player" identity.
      if (bet.name === 'Player' && !bet.avatarUrl) return [];
      return [bet];
    });
    this.bettorFeed.update([...this.optimisticFeed, ...displayBets]);
    this.rankingOverlay.update(snapshot.dailyRanking);
    snapshot.options.forEach((option) => {
      const view = this.itemViews.get(option.id);
      if (!view) return;
      const pending = this.optimisticFeed
        .filter((bet) => bet.position === option.id)
        .reduce((sum, bet) => sum + bet.amount, 0);
      view.total.setText(`Total ${compactItemAmount(option.totalAmount + pending)}`);
      view.mine.setText(`My: ${compactItemAmount(option.myAmount + pending)}`);
    });
    this.renderHistory(snapshot.history);
    if (snapshot.phase === 'RESULT_RECEIVED'
      && this.resultRoundId === snapshot.round?.id
      && this.resultOverlay.visible) {
      this.updateResultDetails(snapshot);
    }
    if (snapshot.phase === 'BETTING_CLOSED' || snapshot.phase === 'RESULT_PENDING') {
      this.timerText.setText('0s');
      this.setBettingEnabled(false);
      this.startSettlementSpin();
    }
  }

  protected animateResult(snapshot: GameSnapshot, complete: () => void) {
    this.stopSettlementSpin();
    this.setBettingEnabled(false);
    const roundId = snapshot.round!.id;
    const winnerId = snapshot.round!.winnerId!;
    let targetIndex = GREEDY_ITEMS.findIndex((item) => item.id === winnerId);
    if (targetIndex < 0 && (winnerId === 'pizza' || winnerId === 'salad')) {
      const candidates = snapshot.options
        .map((option, index) => ({ option, index }))
        .filter(({ option }) => option.category === winnerId);
      const hash = [...roundId].reduce((value, char) => value + char.charCodeAt(0), 0);
      targetIndex = candidates[hash % Math.max(1, candidates.length)]?.index ?? 0;
    }
    this.setWinnerState(winnerId, targetIndex);
    this.statusText.setText('Winner selected');
    this.audio.play('win');
    complete();
  }

  protected showResult(snapshot: GameSnapshot) {
    const roundId = snapshot.round?.id;
    if (!roundId || this.resultRoundId === roundId) return;
    this.resultRoundId = roundId;
    this.updateResultDetails(snapshot);
    this.resultOverlay.setVisible(true).setAlpha(0);
    this.tweens.add({ targets: this.resultOverlay, alpha: 1, duration: 240, ease: 'Quad.easeOut' });
    let secondsLeft = 5;
    this.resultCountdownText.setText(`Next round in ${secondsLeft}s`);
    this.resultCountdown?.remove(false);
    this.resultCountdown = this.time.addEvent({
      delay: 1000,
      repeat: 4,
      callback: () => {
        secondsLeft -= 1;
        this.resultCountdownText.setText(`Next round in ${Math.max(0, secondsLeft)}s`);
        if (secondsLeft === 0) {
          this.resultOverlay.setVisible(false);
          this.statusText.setText('Preparing next round...');
          this.sdk.requestRefresh('result-popup-complete');
        }
      },
    });
  }

  protected onOptimisticBet(optionId: string, amount: number, requestId: string) {
    const view = this.itemViews.get(optionId);
    const pending = this.optimisticFeed
      .filter((bet) => bet.position === optionId)
      .reduce((sum, bet) => sum + bet.amount, amount);
    const option = this.snapshot?.options.find((entry) => entry.id === optionId);
    if (view) {
      view.total.setText(`Total ${compactItemAmount((option?.totalAmount || 0) + pending)}`);
      view.mine.setText(`My: ${compactItemAmount((option?.myAmount || 0) + pending)}`);
      this.tweens.add({ targets: view.container, scale: this.itemScale(1.08), yoyo: true, duration: 100 });
    }
    const optimisticBet = {
      id: requestId,
      requestId,
      userId: this.viewer.userId || 'current-player',
      position: optionId,
      amount,
      name: this.viewer.displayName || 'Player',
      avatarUrl: this.viewer.avatarUrl,
      createdAt: new Date().toISOString(),
    };
    this.optimisticFeed.unshift(optimisticBet);
    this.bettorFeed.update([...this.optimisticFeed, ...(this.snapshot?.publicBets || [])]);
    this.showStatus(`Bet ${money(amount)} pending...`);
  }

  protected onBetResponse(requestId: string, accepted: boolean, betId?: string) {
    if (accepted) {
      const pending = this.optimisticFeed.find((bet) => bet.requestId === requestId);
      if (pending) {
        pending.id = betId || pending.id;
        pending.userId = this.viewer.userId || pending.userId;
        pending.name = this.viewer.displayName || pending.name;
        pending.avatarUrl = this.viewer.avatarUrl || pending.avatarUrl;
      }
      if (this.snapshot) this.renderSnapshot(this.snapshot, false);
      return;
    }
    this.optimisticFeed = this.optimisticFeed.filter((bet) => bet.requestId !== requestId);
    if (this.snapshot) this.renderSnapshot(this.snapshot, false);
  }

  protected onBetBatchResult(result: Extract<NativeToGameMessage, { type: 'BET_BATCH_RESULT' }>['payload']) {
    const completed = new Set(result.requestIds);
    this.optimisticFeed = this.optimisticFeed.filter((bet) => !completed.has(bet.requestId));
    if (this.snapshot) this.renderSnapshot(this.snapshot, false);
  }

  protected onWalletUpdate(balance: number) {
    this.walletText?.setText(compactBalanceAmount(balance));
  }

  protected onNetworkState(connected: boolean, synchronizing: boolean) {
    this.networkText?.setText(!connected ? 'Reconnecting...' : synchronizing ? 'Synchronizing round...' : '');
  }

  protected showStatus(message: string) {
    this.statusText?.setText(message);
  }

  protected afterEmbeddedLayout() {
    const panel = this.children.getByName('embedded-history-panel') as Phaser.GameObjects.Rectangle | null;
    const label = this.children.getByName('embedded-history-label') as Phaser.GameObjects.Text | null;
    panel?.setY(904);
    label?.setPosition(270, 875).setOrigin(0.5);
    this.historyItems?.setY(912);
  }

  private itemScale(multiplier = 1) {
    if (window.__GAME_EMBEDDED__ !== true) return multiplier;
    const contentScale = Phaser.Math.Clamp((this.scale.height - 12) / 960, 0.48, 0.86);
    return (0.66 / contentScale) * multiplier;
  }

  private createItem(item: typeof GREEDY_ITEMS[number], index: number) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    let x = embedded ? 270 + (item.x - 270) * 1.12 : item.x;
    let y = embedded ? 395 + (item.y - 390) * 1.08 : item.y;
    if (embedded && item.id === 'chicken') y -= 88;
    else if (embedded && (item.id === 'corn' || item.id === 'shrimp')) {
      y -= 95;
      x += item.id === 'corn' ? 12 : -12;
    }
    else if (embedded && (item.id === 'tomato' || item.id === 'ham')) y -= 44;
    else if (embedded && (item.id === 'pepper' || item.id === 'fish')) y += 18;
    const container = this.add.container(x, y).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.66 : 0);
    const frame = this.add.graphics();
    const image = this.add.image(0, embedded ? -10 : -9, item.texture).setDisplaySize(embedded ? 94 : 66, embedded ? 94 : 66);
    const label = this.add.text(0, embedded ? 29 : 25, item.label, { fontFamily: 'Arial', fontSize: embedded ? '17px' : '11px', color: '#FFFFFF', fontStyle: 'bold' }).setOrigin(0.5).setVisible(!embedded);
    const total = this.add.text(0, embedded ? 39 : 41, 'Total 0', { fontFamily: 'Arial', fontSize: embedded ? '18px' : '9px', color: '#FFE4A0', fontStyle: 'bold' }).setOrigin(0.5);
    const mine = this.add.text(0, embedded ? 64 : 54, 'My: 0', { fontFamily: 'Arial', fontSize: embedded ? '18px' : '9px', color: '#75F0AC', fontStyle: 'bold' }).setOrigin(0.5);
    const { halfWidth, top, height } = itemLayout(embedded);
    frame.fillStyle(0x25152e, 0.93).fillRoundedRect(-halfWidth, top, halfWidth * 2, height, 9).lineStyle(2, 0xdab75d, 0.7).strokeRoundedRect(-halfWidth, top, halfWidth * 2, height, 9);
    container.add([frame, image, label, total, mine]).setSize(halfWidth * 2, height).setInteractive({ useHandCursor: true });
    container.on('pointerdown', () => this.placeBet(item.id));
    this.itemViews.set(item.id, { container, frame, total, mine });
    container.setData('index', index);
  }

  private createChip(amount: number, x: number, y: number) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const texture = amount === 1000 ? 'chip1k' : amount === 5000 ? 'chip5k' : amount === 50000 ? 'chip50k' : 'chip100k';
    const chipY = embedded ? y + 18 : y;
    const ring = this.add.graphics().setPosition(x, chipY).setDepth(embedded ? 5 : 10)
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.9 : 0);
    const image = this.add.image(x, chipY, texture).setDisplaySize(embedded ? 48 : 62, embedded ? 48 : 62).setDepth(embedded ? 6 : 11).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.9 : 0).setInteractive({ useHandCursor: true });
    const label = this.add.text(x, embedded ? y + 61 : y + 41, compact(amount), { fontFamily: 'Arial', fontSize: embedded ? '13px' : '11px', color: amount === this.selectedAmount ? '#FFF08A' : '#FFFFFF', fontStyle: 'bold' }).setOrigin(0.5).setDepth(12).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.95 : 0).setVisible(!embedded);
    const mark = this.add.text(x + (embedded ? 18 : 24), chipY - (embedded ? 18 : 24), '✓', {
      fontFamily: 'Arial Black, Arial', fontSize: embedded ? '16px' : '18px', color: '#1A3100',
      backgroundColor: '#FFF36A', padding: { left: 3, right: 3, top: 0, bottom: 0 },
    }).setOrigin(0.5).setDepth(13).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.9 : 0);
    this.chipSelectionRings.set(amount, ring);
    this.chipSelectionMarks.set(amount, mark);
    this.paintChipSelection(amount);
    image.on('pointerdown', () => {
      this.selectedAmount = amount;
      CHIP_AMOUNTS.forEach((chipAmount) => this.paintChipSelection(chipAmount));
      this.tweens.add({ targets: image, scale: 1.15, yoyo: true, duration: 110 });
    });
  }

  private paintChipSelection(amount: number) {
    const selected = amount === this.selectedAmount;
    const ring = this.chipSelectionRings.get(amount);
    const embedded = window.__GAME_EMBEDDED__ === true;
    ring?.clear();
    if (selected) ring?.lineStyle(7, 0xffdd24, 0.45).strokeCircle(0, 0, embedded ? 31 : 39)
      .lineStyle(3, 0xffffff, 1).strokeCircle(0, 0, embedded ? 28 : 36);
    this.chipSelectionMarks.get(amount)?.setVisible(selected);
  }

  private startSettlementSpin() {
    if (this.settlementStep) return;
    this.statusText.setText('Lion is spinning...');
    this.highlightStep = 0;
    this.settlementStep = this.time.addEvent({
      delay: 170,
      loop: true,
      callback: () => {
        this.setHighlight((this.highlightIndex + 1 + GREEDY_ITEMS.length) % GREEDY_ITEMS.length);
        this.highlightStep += 1;
        if (this.highlightStep % 2 === 0) this.audio.play('tick');
      },
    });
  }

  private stopSettlementSpin() {
    this.settlementStep?.remove(false);
    this.settlementStep = undefined;
  }

  private setBettingEnabled(enabled: boolean) {
    this.bettingOpen = enabled;
    const embedded = window.__GAME_EMBEDDED__ === true;
    const { halfWidth, top, height } = itemLayout(embedded);
    this.itemViews.forEach((view) => {
      if (enabled) view.container.setInteractive({ useHandCursor: true });
      else view.container.disableInteractive();
      if (enabled) {
        view.frame.clear()
          .fillStyle(0x25152e, 0.96)
          .fillRoundedRect(-halfWidth, top, halfWidth * 2, height, 9)
          .lineStyle(2, 0xdab75d, 0.7)
          .strokeRoundedRect(-halfWidth, top, halfWidth * 2, height, 9);
        view.container.setScale(this.itemScale());
      }
      view.container.setAlpha(enabled ? 1 : 0.42);
    });
  }

  private setWinnerState(winnerId: string, fallbackIndex: number) {
    this.highlightIndex = fallbackIndex;
    const embedded = window.__GAME_EMBEDDED__ === true;
    const { halfWidth, top, height } = itemLayout(embedded);
    this.itemViews.forEach((view, itemId) => {
      const item = GREEDY_ITEMS.find((entry) => entry.id === itemId);
      const winning = itemId === winnerId || item?.category === winnerId
        || Number(view.container.getData('index')) === fallbackIndex && !GREEDY_ITEMS.some((entry) => entry.id === winnerId || entry.category === winnerId);
      view.frame.clear()
        .fillStyle(winning ? 0x7b3f18 : 0x17131d, winning ? 1 : 0.9)
        .fillRoundedRect(-halfWidth, top, halfWidth * 2, height, 9)
        .lineStyle(winning ? 4 : 1, winning ? 0xffe36e : 0x756a80, winning ? 1 : 0.62)
        .strokeRoundedRect(-halfWidth, top, halfWidth * 2, height, 9);
      view.container.setScale(this.itemScale(winning ? 1.12 : 0.98)).setAlpha(winning ? 1 : 0.58).disableInteractive();
    });
  }

  private setHighlight(index: number) {
    const previous = this.highlightIndex;
    if (previous === index) return;
    this.highlightIndex = index;
    if (previous >= 0) this.paintHighlight(previous, false);
    if (index >= 0) this.paintHighlight(index, true);
  }

  private paintHighlight(index: number, active: boolean) {
    const item = GREEDY_ITEMS[index];
    const view = item ? this.itemViews.get(item.id) : undefined;
    if (!view) return;
    const embedded = window.__GAME_EMBEDDED__ === true;
    const { halfWidth, top, height } = itemLayout(embedded);
    view.frame.clear()
      .fillStyle(active ? 0x7b3f18 : 0x25152e, 0.96)
      .fillRoundedRect(-halfWidth, top, halfWidth * 2, height, 9)
      .lineStyle(active ? 4 : 2, active ? 0xffe36e : 0xdab75d, active ? 1 : 0.7)
      .strokeRoundedRect(-halfWidth, top, halfWidth * 2, height, 9);
    view.container.setScale(this.itemScale(active ? 1.1 : 1)).setAlpha(this.bettingOpen || active ? 1 : 0.42);
  }

  private createHeaderButton(label: string, x: number, onPress: () => void, width = 34, embeddedY?: number) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const y = embedded ? embeddedY ?? 80 : 24;
    if (embedded) {
      const background = this.add.graphics().setPosition(x, y).setDepth(20).setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1);
      background.fillStyle(0xb68119, 0.98).fillRoundedRect(-width / 2, -18, width, 36, 18)
        .lineStyle(2, 0xffe28a, 0.95).strokeRoundedRect(-width / 2, -18, width, 36, 18);
    } else {
      this.add.rectangle(x, y, width, 32, 0x302340, 0.97).setStrokeStyle(1, 0xffd76a, 0.75).setDepth(20);
    }
    return this.add.text(x, y, label, {
      fontFamily: 'Arial', fontSize: embedded ? (label.length > 1 ? '13px' : label === '♪' ? '22px' : '18px') : (label.length > 1 ? '11px' : '15px'), color: embedded ? '#1C1204' : '#FFF0A5', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(21).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0).setInteractive({ useHandCursor: true }).on('pointerdown', onPress);
  }

  private renderHistory(rows: Array<Record<string, unknown>>) {
    this.historyItems.removeAll(true);
    const embedded = window.__GAME_EMBEDDED__ === true;
    const history = (rows as any[]).filter((row) => {
      const winner = row.result?.winner_pos || row.winner_pos || row.result?.category;
      return winner === 'pizza' || winner === 'salad' || GREEDY_ITEMS.some((item) => item.id === winner);
    }).slice(0, 7);
    if (!history.length) {
      this.historyItems.add(this.add.text(270, embedded ? 0 : 842, 'Waiting for first result', {
        fontFamily: 'Arial', fontSize: '12px', color: '#BFC2CF',
      }).setOrigin(0.5));
      return;
    }
    history.forEach((row, index) => {
      const winner = row.result?.winner_pos || row.winner_pos || row.result?.category;
      const resultType = row.result?.result_type;
      const category = row.result?.category || winner;
      const texture = resultType === 'category' || winner === 'pizza' || winner === 'salad'
        ? `${category}Food`
        : String(winner || 'crownedLion');
      if (!this.textures.exists(texture)) return;
      const key = texture;
      const x = embedded ? 60 + index * 70 : 66 + index * 68;
      const y = embedded ? 0 : 843;
      const image = this.add.image(x, y, key).setDisplaySize(embedded ? 48 : 48, embedded ? 43 : 42);
      const border = this.add.graphics().lineStyle(index === 0 ? 3 : 1, index === 0 ? 0xffe273 : 0x8c789e, 0.9).strokeCircle(x, y, embedded ? 23 : 26);
      this.historyItems.add([image, border]);
    });
  }

  private createResultOverlay() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const shade = this.add.rectangle(270, 480, 540, 960, 0x080711, 0.56).setInteractive();
    const panelX = embedded ? 55 : 75;
    const panelY = embedded ? 185 : 285;
    const panelWidth = embedded ? 430 : 390;
    const panelHeight = embedded ? 205 : 300;
    const panelRadius = embedded ? 16 : 10;
    const panel = this.add.graphics().fillStyle(0x24122d, 0.98).fillRoundedRect(panelX, panelY, panelWidth, panelHeight, panelRadius).lineStyle(3, 0xffd76a, 1).strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, panelRadius);
    this.resultWinnerImage = this.add.image(embedded ? 135 : 270, embedded ? 290 : 360, 'crownedLion').setDisplaySize(embedded ? 100 : 116, embedded ? 96 : 110);
    this.resultTitle = this.add.text(270, 425, 'WINNER', { fontFamily: 'Arial', fontSize: '25px', color: '#FFF0A5', fontStyle: 'bold' }).setOrigin(0.5).setVisible(!embedded);
    this.resultDetail = this.add.text(embedded ? 220 : 270, embedded ? 232 : 470, '', {
      fontFamily: 'Arial', fontSize: embedded ? '15px' : '16px', color: '#FFFFFF', lineSpacing: embedded ? 7 : 9,
      align: embedded ? 'left' : 'center', fixedWidth: embedded ? 245 : undefined,
    }).setOrigin(embedded ? 0 : 0.5, 0);
    this.resultCountdownText = this.add.text(embedded ? 470 : 270, embedded ? 202 : 555, 'Next round in 5s', { fontFamily: 'Arial', fontSize: embedded ? '12px' : '12px', color: '#FFF0A5', fontStyle: 'bold' }).setOrigin(embedded ? 1 : 0.5, 0.5);
    this.resultOverlay = this.add.container(0, 0, [shade, panel, this.resultWinnerImage, this.resultTitle, this.resultDetail, this.resultCountdownText]).setDepth(100).setVisible(false).setData('embeddedPreserveX', window.__GAME_EMBEDDED__ === true).setData('embeddedFinalScale', window.__GAME_EMBEDDED__ === true ? 1 : 0);
  }

  private updateResultDetails(snapshot: GameSnapshot) {
    const winnerId = snapshot.round?.winnerId || 'Winner';
    const winner = snapshot.options.find((option) => option.id === winnerId);
    const label = winner?.label || winnerId.replace(/_/g, ' ');
    const winningOptions = winner
      ? [winner]
      : snapshot.options.filter((option) => option.category === winnerId);
    const myWinningBet = winningOptions.reduce((sum, option) => sum + option.myAmount, 0);
    const topWinner = (snapshot.round?.result?.top_winners as Array<Record<string, unknown>> | undefined)?.[0];
    const winnerTexture = winner ? winner.id : `${winnerId}Food`;
    this.resultWinnerImage.setTexture(this.textures.exists(winnerTexture) ? winnerTexture : 'crownedLion');
    this.resultTitle.setText(`${label.toUpperCase()} WINS`);
    this.resultDetail.setText([
      `Your Bet: ${money(myWinningBet)}`,
      `You Won: ${money(snapshot.myPayout)}`,
      topWinner ? `Top Winner: ${String(topWinner.name || 'Player')} ${money(Number(topWinner.amount || topWinner.win_amount || 0))}` : '',
    ].filter(Boolean).join('\n'));
  }
}
