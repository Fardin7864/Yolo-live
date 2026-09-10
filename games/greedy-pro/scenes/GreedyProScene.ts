import Phaser from 'phaser';
import { BaseGameScene } from '../../shared/BaseGameScene';
import { loadEmbeddedAssets } from '../../shared/AssetLoader';
import type { GamePublicBet, GameRankingEntry, GameSnapshot, NativeToGameMessage } from '../../shared/types';
import wheelDisc from '../assets/wheel-disc.webp';
import wheelStand from '../assets/wheel-stand.webp';
import crownedLion from '../assets/crowned-lion.webp';
import centerLion from '../assets/center-lion.webp';
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
import { CHIP_AMOUNTS, GREEDY_ITEMS } from '../config';
import { createInfoOverlay } from '../../shared/InfoOverlay';
import type { RankingOverlay } from '../../shared/GameHud';
import { getRoundSecondsLeft } from '../../shared/GameClock';
import botProfileAtlas from '../../shared/assets/bot-avatar-atlas.webp';
import { addBotProfileAvatar, BOT_PROFILE_ATLAS_KEY, isBotIdentity } from '../../shared/BotProfiles';

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
const ITEM_RADIUS = 48;
interface ItemView {
  container: Phaser.GameObjects.Container;
  frame: Phaser.GameObjects.Graphics;
  multiplier: Phaser.GameObjects.Text;
  total: Phaser.GameObjects.Text;
  mine: Phaser.GameObjects.Text;
}

type OptimisticBet = GamePublicBet & {
  requestId: string;
};

export class GreedyProScene extends BaseGameScene {
  private itemViews = new Map<string, ItemView>();
  private chipButtons = new Map<number, Phaser.GameObjects.Graphics>();
  private chipLabels = new Map<number, Phaser.GameObjects.Text>();
  private chipSelectionMarks = new Map<number, Phaser.GameObjects.Text>();
  private flyingBotChips = new Set<Phaser.GameObjects.Container>();
  private seenRobotBetIds = new Set<string>();
  private robotRoundId: string | null = null;
  private wheelImage!: Phaser.GameObjects.Image;
  private timerText!: Phaser.GameObjects.Text;
  private walletText?: Phaser.GameObjects.Text;
  private historyItems!: Phaser.GameObjects.Container;
  private networkText?: Phaser.GameObjects.Text;
  private resultOverlay!: Phaser.GameObjects.Container;
  private resultRoundText!: Phaser.GameObjects.Text;
  private resultEarningsText!: Phaser.GameObjects.Text;
  private resultBetsText!: Phaser.GameObjects.Text;
  private resultRankingRows!: Phaser.GameObjects.Container;
  private resultWinnerImage!: Phaser.GameObjects.Image;
  private resultCountdownText!: Phaser.GameObjects.Text;
  private rulesOverlay!: Phaser.GameObjects.Container;
  private rankingOverlay!: RankingOverlay;
  private myHistoryOverlay!: Phaser.GameObjects.Container;
  private myHistoryRows!: Phaser.GameObjects.Container;
  private soundButton!: Phaser.GameObjects.Text;
  private optimisticFeed: OptimisticBet[] = [];
  private settlementStep?: Phaser.Time.TimerEvent;
  private resultCountdown?: Phaser.Time.TimerEvent;
  private modalOverlayOpen = false;
  private resultRoundId: string | null = null;
  private bettingOpen = false;
  private highlightIndex = -1;
  private highlightStep = 0;
  private lastTimerSecond = -1;

  constructor() {
    super({ key: 'GreedyProScene' });
  }

  preload() {
    loadEmbeddedAssets(this, {
      wheelDisc, wheelStand, crownedLion, centerLion,
      corn, chicken, shrimp, tomato, ham, pepper, fish, carrot,
      pizzaFood, saladFood, balanceDiamond,
      [BOT_PROFILE_ATLAS_KEY]: botProfileAtlas,
    });
  }

  protected build() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    this.createBackdrop();

    const title = this.add.text(285, 31, 'GREEDY KING', {
      fontFamily: 'Arial Black, Arial', fontSize: embedded ? '22px' : '18px', color: '#7B251B', fontStyle: 'bold',
      stroke: '#FFF4A8', strokeThickness: 3,
    }).setOrigin(0.5).setName('game-title');
    this.preserveEmbedded(title, 0.9);

    const balancePill = this.add.graphics().setPosition(104, 45).setDepth(18);
    balancePill.fillStyle(0x8b251d, 0.98).fillRoundedRect(-88, -20, 176, 40, 20)
      .lineStyle(3, 0xffd75c, 1).strokeRoundedRect(-88, -20, 176, 40, 20);
    this.preserveEmbedded(balancePill, 0.9);
    const balanceIcon = this.add.image(44, 45, 'balanceDiamond').setDisplaySize(24, 24).setDepth(19);
    this.preserveEmbedded(balanceIcon, 0.9);
    this.walletText = this.add.text(112, 45, '0', {
      fontFamily: 'Arial', fontSize: embedded ? '20px' : '16px', color: '#FFF8D6', fontStyle: 'bold', align: 'center',
    }).setOrigin(0.5).setDepth(19);
    this.preserveEmbedded(this.walletText, 0.9);
    const stand = this.add.image(270, 612, 'wheelStand').setDisplaySize(235, 84).setAlpha(0.98).setDepth(1);
    this.preserveEmbedded(stand, 0.92);
    this.wheelImage = this.add.image(270, 392, 'wheelDisc').setDisplaySize(embedded ? 300 : 260, embedded ? 300 : 260).setAlpha(1).setDepth(3);
    this.preserveEmbedded(this.wheelImage, 0.86);
    GREEDY_ITEMS.forEach((item, index) => this.createItem(item, index));
    const center = this.add.circle(270, 392, 54, 0x7d201c, 1).setStrokeStyle(5, 0xffdd68, 1).setDepth(8);
    this.preserveEmbedded(center, 0.86);
    const lion = this.add.image(270, 373, 'centerLion').setDisplaySize(76, 76).setDepth(9);
    this.preserveEmbedded(lion, 0.86);
    this.timerText = this.add.text(270, 416, '--', {
      fontFamily: 'Arial', fontSize: embedded ? '25px' : '22px', color: '#FFF7C0', fontStyle: 'bold',
      backgroundColor: '#7B251B', padding: { x: 9, y: 4 },
    }).setOrigin(0.5).setDepth(10);
    this.preserveEmbedded(this.timerText, 0.86);
    this.createCategoryPlate('saladFood', 'SALAD', 72, 735);
    this.createCategoryPlate('pizzaFood', 'PIZZA', 468, 735);

    CHIP_AMOUNTS.forEach((amount, index) => this.createChip(amount, 509, 150 + index * 92));

    const historyPanel = this.add.graphics().setPosition(270, 850)
      .fillStyle(0xfff0a0, 1).fillRoundedRect(-258, -36, 516, 72, 14)
      .lineStyle(4, 0x8a241e, 1).strokeRoundedRect(-258, -36, 516, 72, 14);
    historyPanel.setName('history-panel');
    this.preserveEmbedded(historyPanel, 0.96);
    this.historyItems = this.add.container(0, 850).setName('history-items')
      .setInteractive(new Phaser.Geom.Rectangle(12, -34, 516, 68), Phaser.Geom.Rectangle.Contains);
    this.preserveEmbedded(this.historyItems, 0.96);
    this.historyItems.on('pointerdown', () => this.sdk.send('OPEN_HISTORY', {}));
    this.add.text(270, 918, 'Backend-controlled results • Secure wallet settlement', { fontFamily: 'Arial', fontSize: '10px', color: '#FFF2A5', fontStyle: 'bold' }).setOrigin(0.5).setName('embedded-footer');
    this.createResultOverlay();
    this.createMyHistoryOverlay();
    this.rulesOverlay = createInfoOverlay(this, 'HOW TO PLAY', [
      'Choose a chip and tap up to six different items during betting.',
      'You can add more bets to an item you already selected.',
      'The backend selects and settles the winner. The wheel is visual only.',
      'Your wallet updates after the backend accepts and settles each bet.',
    ], { largeText: true, scrollable: true, fullScreen: embedded });
    this.rankingOverlay = this.createRankingOverlay();
    this.createHeaderButton('RANK', 33, () => this.rankingOverlay.show(), 52, 118);
    this.createHeaderButton('?', 33, () => {
      this.sdk.send('OPEN_RULES', {});
      this.rulesOverlay.setVisible(true);
      this.children.bringToTop(this.rulesOverlay);
    }, 46, 224);
    this.soundButton = this.createHeaderButton('♪', 33, () => {
      const enabled = this.audio.toggle();
      this.soundButton.setText(enabled ? '♪' : '×');
    }, 46, 330);
    this.createHeaderButton('↺', 33, () => {
      this.modalOverlayOpen = true;
      this.sdk.requestRefresh('my-history-opened');
      this.myHistoryOverlay.setVisible(true);
      this.myHistoryOverlay.setDepth(100000);
      this.myHistoryOverlay.parentContainer?.bringToTop(this.myHistoryOverlay);
      this.children.bringToTop(this.myHistoryOverlay);
    }, 46, 436);
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
      this.clearRobotFlights();
      this.stopSettlementSpin();
      this.resultCountdown?.remove(false);
      this.resultCountdown = undefined;
      this.resultRoundId = null;
      this.tweens.killAll();
      this.time.removeAllEvents();
      this.resultOverlay.setVisible(false);
      this.setBettingEnabled(true);
      this.setHighlight(-1);
      this.lastTimerSecond = -1;
      this.optimisticFeed = [];
    }
    this.rankingOverlay.update(snapshot.dailyRanking);
    this.renderMyHistory(snapshot.myHistory);
    this.animateNewRobotBets(snapshot);
    snapshot.options.forEach((option) => {
      const view = this.itemViews.get(option.id);
      if (!view) return;
      const pending = this.optimisticFeed
        .filter((bet) => bet.position === option.id)
        .reduce((sum, bet) => sum + bet.amount, 0);
      view.multiplier.setText(`${option.multiplier || 1}x`);
      view.total.setText(`Total ${compactItemAmount(option.totalAmount + pending)}`);
      view.mine.setText(`You ${compactItemAmount(option.myAmount + pending)}`);
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
    this.clearRobotFlights();
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
    this.audio.play('win');
    complete();
  }

  protected showResult(snapshot: GameSnapshot) {
    const roundId = snapshot.round?.id;
    if (!roundId || this.resultRoundId === roundId) return;
    this.resultRoundId = roundId;
    this.clearRobotFlights();
    this.updateResultDetails(snapshot);
    this.resultOverlay.setDepth(100000).setVisible(true).setAlpha(0);
    this.resultOverlay.parentContainer?.bringToTop(this.resultOverlay);
    this.children.bringToTop(this.resultOverlay);
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
      view.mine.setText(`You ${compactItemAmount((option?.myAmount || 0) + pending)}`);
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
    this.networkText?.setText(!connected ? 'OFFLINE' : synchronizing ? 'SYNCING' : 'ONLINE');
  }

  protected showStatus(_message: string) {}

  protected afterEmbeddedLayout() {
    // Preserve a true circle around the wheel in the short live sheet. The
    // base layout compresses y positions, so compensate only the radial y
    // offset while retaining the shared vertical center.
    const contentScale = Phaser.Math.Clamp((this.scale.height - 12) / 960, 0.48, 0.86);
    GREEDY_ITEMS.forEach((item) => {
      this.itemViews.get(item.id)?.container.setY(392 + (item.y - 392) / contentScale);
    });
  }

  private itemScale(multiplier = 1) {
    if (window.__GAME_EMBEDDED__ !== true) return multiplier;
    const contentScale = Phaser.Math.Clamp((this.scale.height - 12) / 960, 0.48, 0.86);
    return (0.82 / contentScale) * multiplier;
  }

  private preserveEmbedded<T extends Phaser.GameObjects.GameObject>(object: T, finalScale = 1) {
    if (window.__GAME_EMBEDDED__ === true) {
      object.setData('embeddedPreserveX', true).setData('embeddedFinalScale', finalScale);
    }
    return object;
  }

  private createBackdrop() {
    this.add.rectangle(270, 480, 540, 960, 0xffee8c);
    const backdrop = this.preserveEmbedded(this.add.graphics());
    backdrop.fillStyle(0xffee8c, 1).fillRect(0, 78, 540, 554);
    backdrop.fillStyle(0x23b9d9, 1).fillRoundedRect(0, 620, 540, 96, 28);
    backdrop.lineStyle(4, 0x12688f, 1).strokeRoundedRect(0, 620, 540, 96, 28);
    backdrop.fillStyle(0xc80e35, 1).fillRect(0, 705, 540, 255);
    backdrop.fillStyle(0x9f0928, 1).fillRect(0, 790, 540, 9);
    backdrop.fillStyle(0x7f061f, 1).fillRect(0, 935, 540, 25);
  }

  private createCategoryPlate(texture: string, label: string, x: number, y: number) {
    const panel = this.add.graphics().setPosition(x, y + 27).setDepth(13);
    panel.fillStyle(0xfff26a, 1).fillRoundedRect(-55, -15, 110, 30, 8)
      .lineStyle(2, 0x6f2519, 1).strokeRoundedRect(-55, -15, 110, 30, 8);
    const image = this.add.image(x, y - 16, texture).setDisplaySize(104, 76).setDepth(14);
    const name = this.add.text(x, y + 27, label, {
      fontFamily: 'Arial Black, Arial', fontSize: '14px', color: '#672018', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(15);
    [panel, image, name].forEach((object) => this.preserveEmbedded(object, 0.9));
  }

  private paintItemFrame(frame: Phaser.GameObjects.Graphics, active: boolean, category: string, winner = false) {
    const border = winner ? 0xfff17a : active ? 0xffd836 : category === 'pizza' ? 0xd83b2f : 0x2c6fc4;
    const topFill = winner ? 0xffa23a : active ? 0x69e6ff : 0x83dff6;
    frame.clear()
      .fillStyle(0xffffff, 1).fillCircle(0, 0, ITEM_RADIUS)
      .fillStyle(topFill, 1).slice(0, 0, ITEM_RADIUS - 2, Math.PI, Math.PI * 2, true).fillPath()
      .lineStyle(winner ? 6 : active ? 5 : 4, border, 1)
      .strokeCircle(0, 0, ITEM_RADIUS)
      .lineStyle(2, border, 0.9)
      .lineBetween(-ITEM_RADIUS + 4, 6, ITEM_RADIUS - 4, 6);
  }

  private createItem(item: typeof GREEDY_ITEMS[number], index: number) {
    const container = this.add.container(item.x, item.y).setDepth(6);
    this.preserveEmbedded(container, 0.82);
    const frame = this.add.graphics();
    this.paintItemFrame(frame, false, item.category);
    const image = this.add.image(-3, -18, item.texture).setDisplaySize(44, 44).setDepth(2);
    const multiplier = this.add.text(43, -29, '1x', {
      fontFamily: 'Arial Black, Arial', fontSize: '23px', color: '#6E1816', fontStyle: 'bold',
      stroke: '#FFF4A1', strokeThickness: 4,
    }).setOrigin(1, 0.5);
    const total = this.add.text(0, 16, 'Total 0', { fontFamily: 'Arial Narrow, Arial', fontSize: '15px', color: '#0E3048', fontStyle: 'bold' }).setOrigin(0.5);
    const mine = this.add.text(0, 32, 'You 0', { fontFamily: 'Arial Narrow, Arial', fontSize: '15px', color: '#075C39', fontStyle: 'bold' }).setOrigin(0.5);
    container.add([frame, image, multiplier, total, mine]).setSize(ITEM_RADIUS * 2, ITEM_RADIUS * 2).setInteractive({ useHandCursor: true });
    container.on('pointerdown', () => this.placeBet(item.id));
    this.itemViews.set(item.id, { container, frame, multiplier, total, mine });
    container.setData('index', index);
  }

  private createChip(amount: number, x: number, y: number) {
    const button = this.add.graphics().setPosition(x, y).setDepth(12).setName('chip-button').setData('amount', amount)
      .setInteractive(new Phaser.Geom.Circle(0, 0, 32), Phaser.Geom.Circle.Contains);
    if (button.input) button.input.cursor = 'pointer';
    this.chipButtons.set(amount, button);
    this.preserveEmbedded(button, 1);
    this.paintChip(button, amount === this.selectedAmount);
    const label = this.add.text(x, y, compact(amount), {
      fontFamily: 'Arial Black, Arial', fontSize: '13px', color: amount === this.selectedAmount ? '#FFF36A' : '#FFF9D9', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(13).setName('chip-label').setData('amount', amount).setInteractive({ useHandCursor: true });
    this.preserveEmbedded(label, 1);
    const mark = this.add.text(x - 19, y - 19, '✓', {
      fontFamily: 'Arial Black, Arial', fontSize: '14px', color: '#102600',
      backgroundColor: '#FFF36A', padding: { left: 3, right: 3, top: 0, bottom: 0 },
    }).setOrigin(0.5).setDepth(14);
    this.preserveEmbedded(mark, 1);
    this.chipLabels.set(amount, label);
    this.chipSelectionMarks.set(amount, mark);
    mark.setVisible(amount === this.selectedAmount);
    const selectChip = () => {
      this.selectedAmount = amount;
      this.chipButtons.forEach((chip, chipAmount) => this.paintChip(chip, chipAmount === amount));
      this.chipLabels.forEach((chipLabel, chipAmount) => chipLabel.setColor(chipAmount === amount ? '#FFF36A' : '#FFF9D9'));
      this.chipSelectionMarks.forEach((selectionMark, chipAmount) => selectionMark.setVisible(chipAmount === amount));
      this.tweens.add({ targets: label, scale: 1.12, yoyo: true, duration: 100 });
    };
    button.on('pointerdown', selectChip);
    label.on('pointerdown', selectChip);
  }

  private paintChip(chip: Phaser.GameObjects.Graphics, selected: boolean) {
    chip.clear();
    if (selected) chip.lineStyle(5, 0xffdf24, 1).strokeCircle(0, 0, 30);
    chip.fillStyle(selected ? 0xe5234b : 0x7b2fc7, 1).fillCircle(0, 0, 25)
      .lineStyle(selected ? 4 : 3, selected ? 0xffdf24 : 0xfff1a0, 1).strokeCircle(0, 0, 25)
      .lineStyle(3, selected ? 0xffd43b : 0x4b167f, 1).strokeCircle(0, 0, 18)
      .fillStyle(0xffffff, 0.95);
    for (let index = 0; index < 10; index += 1) {
      const angle = index / 10 * Math.PI * 2;
      chip.fillCircle(Math.cos(angle) * 21, Math.sin(angle) * 21, 1.9);
    }
  }

  private startSettlementSpin() {
    if (this.settlementStep) return;
    this.clearRobotFlights();
    this.highlightStep = 0;
    this.settlementStep = this.time.addEvent({
      delay: 90,
      loop: true,
      callback: () => {
        this.wheelImage.angle += 18;
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
    this.itemViews.forEach((view, itemId) => {
      if (enabled) view.container.setInteractive({ useHandCursor: true });
      else view.container.disableInteractive();
      if (enabled) {
        const category = GREEDY_ITEMS.find((item) => item.id === itemId)?.category || 'salad';
        this.paintItemFrame(view.frame, false, category);
        view.container.setScale(this.itemScale());
      }
      view.container.setAlpha(enabled ? 1 : 0.55);
    });
  }

  private setWinnerState(winnerId: string, fallbackIndex: number) {
    this.highlightIndex = fallbackIndex;
    this.itemViews.forEach((view, itemId) => {
      const item = GREEDY_ITEMS.find((entry) => entry.id === itemId);
      const winning = itemId === winnerId || item?.category === winnerId
        || Number(view.container.getData('index')) === fallbackIndex && !GREEDY_ITEMS.some((entry) => entry.id === winnerId || entry.category === winnerId);
      this.paintItemFrame(view.frame, false, item?.category || 'salad', winning);
      view.container.setScale(this.itemScale(winning ? 1.14 : 0.98)).setAlpha(winning ? 1 : 0.48).disableInteractive();
    });
    if (fallbackIndex >= 0) this.wheelImage.setAngle(fallbackIndex * 45);
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
    this.paintItemFrame(view.frame, active, item.category);
    view.container.setScale(this.itemScale(active ? 1.1 : 1)).setAlpha(this.bettingOpen || active ? 1 : 0.55);
  }

  private createHeaderButton(label: string, x: number, onPress: () => void, width = 34, embeddedY?: number) {
    const y = embeddedY ?? 80;
    const background = this.add.graphics().setPosition(x, y).setDepth(20);
    background.fillStyle(0xfff4ae, 0.98).fillRoundedRect(-width / 2, -24, width, 48, 16)
      .lineStyle(4, 0x7e251b, 1).strokeRoundedRect(-width / 2, -24, width, 48, 16);
    this.preserveEmbedded(background, 1);
    const button = this.add.text(x, y, label, {
      fontFamily: 'Arial', fontSize: label.length > 1 ? '13px' : label === '♪' ? '27px' : '23px', color: '#7A241B', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(21).setInteractive({ useHandCursor: true }).on('pointerdown', onPress);
    this.preserveEmbedded(button, 1);
    return button;
  }

  private renderHistory(rows: Array<Record<string, unknown>>) {
    this.historyItems.removeAll(true);
    const history = (rows as any[]).filter((row) => {
      const winner = row.result?.winner_pos || row.winner_pos || row.result?.category;
      return winner === 'pizza' || winner === 'salad' || GREEDY_ITEMS.some((item) => item.id === winner);
    }).slice(0, 7);
    if (!history.length) {
      this.historyItems.add(this.add.text(270, 0, 'Waiting for first result', {
        fontFamily: 'Arial', fontSize: '16px', color: '#7B251B', fontStyle: 'bold',
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
      // Compensate for the history container's embedded 0.96 scale.
      // These symmetric endpoints leave exactly the same visible gap
      // between the first/last circle edges and the scaled panel border.
      const x = 58.75 + index * (445 / 6);
      const y = 0;
      const image = this.add.image(x, y, key).setDisplaySize(42, 42).setDepth(16);
      const border = this.add.graphics().lineStyle(index === 0 ? 4 : 2, index === 0 ? 0xd92728 : 0x7b251b, 0.9).strokeCircle(x, y, 23).setDepth(17);
      this.historyItems.add([image, border]);
    });
  }

  private createResultOverlay() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const viewportHeight = embedded ? this.scale.height : 960;
    const popupHeight = Math.min(viewportHeight - 48, 450);
    const popupBottom = 24 + popupHeight;
    const shade = this.add.rectangle(270, viewportHeight / 2, 540, viewportHeight, 0x06364d, 0.78).setInteractive();
    const outer = this.add.graphics()
      .fillStyle(0x08c5e6, 1).fillRoundedRect(14, 24, 512, popupHeight, 24)
      .lineStyle(3, 0xc9f8ff, 1).strokeRoundedRect(14, 24, 512, popupHeight, 24);
    const innerTop = 132;
    const inner = this.add.graphics()
      .fillStyle(0xfffdf7, 1).fillRoundedRect(34, innerTop, 472, popupBottom - innerTop - 18, 20);
    const decorations = this.add.graphics();
    [
      [66, 92, 0xffe057], [110, 52, 0xff5ab7], [168, 104, 0x75f06c],
      [386, 72, 0xffe057], [454, 105, 0xff6a72], [490, 58, 0x71ee83],
    ].forEach(([x, y, color], index) => {
      decorations.fillStyle(color, 1).fillRect(x, y, index % 2 ? 7 : 5, index % 2 ? 5 : 11);
    });
    this.resultWinnerImage = this.add.image(270, 88, 'crownedLion').setDisplaySize(92, 92);
    this.resultRoundText = this.add.text(270, 174, 'Round Result', {
      fontFamily: 'Arial Black, Arial', fontSize: embedded ? '21px' : '20px', color: '#34404c', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.resultEarningsText = this.add.text(270, 220, 'This Round Earnings: 0', {
      fontFamily: 'Arial', fontSize: embedded ? '20px' : '18px', color: '#34404c', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.resultBetsText = this.add.text(270, 258, 'This Round Bets: 0', {
      fontFamily: 'Arial', fontSize: embedded ? '20px' : '18px', color: '#34404c', fontStyle: 'bold',
    }).setOrigin(0.5);
    const rankingTitle = this.add.text(270, 300, 'This Round Ranking', {
      fontFamily: 'Arial', fontSize: embedded ? '20px' : '18px', color: '#34404c', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.resultRankingRows = this.add.container(0, 0);
    this.resultCountdownText = this.add.text(500, 52, 'Next round in 5s', {
      fontFamily: 'Arial', fontSize: embedded ? '16px' : '14px', color: '#07516c', fontStyle: 'bold',
      backgroundColor: '#d4f9ff', padding: { x: 10, y: 6 },
    }).setOrigin(1, 0.5);
    this.resultOverlay = this.add.container(0, 0, [
      shade, outer, inner, decorations, this.resultWinnerImage, this.resultRoundText,
      this.resultEarningsText, this.resultBetsText, rankingTitle, this.resultRankingRows, this.resultCountdownText,
    ])
      .setDepth(100).setVisible(false).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
  }

  private createMyHistoryOverlay() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const viewportHeight = embedded ? this.scale.height : 960;
    const shade = this.add.rectangle(270, viewportHeight / 2, 540, viewportHeight, 0x07384d, 0.82).setInteractive();
    const panel = this.add.graphics().fillStyle(0x08b9e8, 1).fillRoundedRect(12, 12, 516, viewportHeight - 24, 20)
      .lineStyle(3, 0xcdf8ff, 1).strokeRoundedRect(12, 12, 516, viewportHeight - 24, 20);
    const heading = this.add.text(270, 45, 'My History', {
      fontFamily: 'Arial Black, Arial', fontSize: embedded ? '27px' : '25px', color: '#FFFFFF', fontStyle: 'bold',
    }).setOrigin(0.5);
    const divider = this.add.graphics().lineStyle(2, 0xc8f6ff, 0.9).lineBetween(28, 78, 512, 78);
    const close = this.add.text(495, 45, '×', {
      fontFamily: 'Arial', fontSize: '36px', color: '#FFFFFF', fontStyle: 'normal',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    const rowsTop = 88;
    this.myHistoryRows = this.add.container(0, 0);
    const rowsHeight = Math.max(120, viewportHeight - rowsTop - 18);
    const maskShape = this.add.graphics().fillStyle(0xffffff, 1).fillRect(20, rowsTop, 500, rowsHeight).setVisible(false);
    this.myHistoryRows.setMask(maskShape.createGeometryMask());
    const scrollZone = this.add.zone(270, rowsTop + rowsHeight / 2, 500, rowsHeight).setInteractive({ useHandCursor: true });
    this.input.setDraggable(scrollZone);
    let dragStartY = 0;
    let startOffset = 0;
    scrollZone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      dragStartY = pointer.y;
      startOffset = this.myHistoryRows.y;
    });
    scrollZone.on('drag', (pointer: Phaser.Input.Pointer) => {
      const rowCount = Number(this.myHistoryRows.getData('rowCount') || 0);
      const minY = Math.min(0, rowsHeight - Math.max(1, rowCount) * 112 - 8);
      this.myHistoryRows.y = Phaser.Math.Clamp(startOffset + pointer.y - dragStartY, minY, 0);
    });
    this.myHistoryOverlay = this.add.container(0, 0, [shade, panel, heading, divider, this.myHistoryRows, maskShape, scrollZone, close])
      .setDepth(1200).setVisible(false).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    close.on('pointerdown', () => {
      this.myHistoryOverlay.setVisible(false);
      this.modalOverlayOpen = false;
    });
  }

  private renderMyHistory(rows: Array<Record<string, unknown>>) {
    if (!this.myHistoryRows) return;
    if (!rows.length && this.myHistoryRows.getData('hasLoadedRows') === true) return;
    this.myHistoryRows.removeAll(true);
    this.myHistoryRows.setY(0);
    this.myHistoryRows.setData('rowCount', rows.length);
    if (!rows.length) {
      this.myHistoryRows.add(this.add.text(270, 145, 'No personal bets yet', {
        fontFamily: 'Arial', fontSize: '20px', color: '#E9FCFF', fontStyle: 'bold',
      }).setOrigin(0.5));
      return;
    }
    this.myHistoryRows.setData('hasLoadedRows', true);
    rows.slice(0, 20).forEach((row: any, index) => {
      const y = 92 + index * 112;
      const won = Number(row.total_win || 0);
      const groupedPositions = new Map<string, number>();
      if (Array.isArray(row.positions)) {
        row.positions.forEach((entry: any) => {
          const position = String(entry.position || '');
          if (!position) return;
          groupedPositions.set(position, (groupedPositions.get(position) || 0) + Number(entry.amount || 0));
        });
      }
      const positions = [...groupedPositions.entries()].slice(0, 6)
        .map(([position, amount]) => ({ position, amount }));
      const background = this.add.graphics().fillStyle(index % 2 ? 0x079ed2 : 0x08a9db, 0.92)
        .fillRoundedRect(24, y, 492, 104, 10);
      const date = this.add.text(38, y + 12, this.formatHistoryDate(row.created_at), {
        fontFamily: 'Arial', fontSize: '15px', color: '#D9F8FF', fontStyle: 'bold',
      });
      const round = this.add.text(502, y + 12, `NO.${String(row.round_id || '').slice(-10) || index + 1}`, {
        fontFamily: 'Arial', fontSize: '15px', color: '#D9F8FF',
      }).setOrigin(1, 0);
      const selectLabel = this.add.text(40, y + 49, 'Select:', {
        fontFamily: 'Arial', fontSize: '18px', color: '#FFFFFF', fontStyle: 'bold',
      }).setOrigin(0, 0.5);
      this.myHistoryRows.add([background, date, round, selectLabel]);
      positions.forEach((entry: any, positionIndex: number) => {
        const spacing = Math.min(88, 390 / Math.max(1, positions.length));
        const x = 108 + positionIndex * spacing;
        const texture = this.textureForResult(String(entry.position || ''));
        if (texture) this.myHistoryRows.add(this.add.image(x, y + 49, texture).setDisplaySize(30, 30));
        this.myHistoryRows.add(this.add.text(x + 17, y + 49, compactItemAmount(Number(entry.amount || 0)), {
          fontFamily: 'Arial', fontSize: '16px', color: '#FFFFFF', fontStyle: 'bold',
        }).setOrigin(0, 0.5));
      });
      const winLabel = this.add.text(40, y + 82, 'Win:', {
        fontFamily: 'Arial', fontSize: '18px', color: '#FFFFFF', fontStyle: 'bold',
      }).setOrigin(0, 0.5);
      this.myHistoryRows.add(winLabel);
      const winnerTexture = this.textureForResult(String(row.winner_pos || ''));
      if (winnerTexture) this.myHistoryRows.add(this.add.image(108, y + 82, winnerTexture).setDisplaySize(28, 28));
      this.myHistoryRows.add(this.add.text(126, y + 82, compactItemAmount(won), {
        fontFamily: 'Arial', fontSize: '17px', color: won > 0 ? '#FFF4A0' : '#E5FAFF', fontStyle: 'bold',
      }).setOrigin(0, 0.5));
    });
  }

  private updateResultDetails(snapshot: GameSnapshot) {
    const winnerId = snapshot.round?.winnerId || 'Winner';
    const winner = snapshot.options.find((option) => option.id === winnerId);
    const label = winner?.label || winnerId.replace(/_/g, ' ');
    const winnerTexture = winner ? winner.id : `${winnerId}Food`;
    this.resultWinnerImage.setTexture(this.textures.exists(winnerTexture) ? winnerTexture : 'crownedLion');
    const roundNumber = String(snapshot.round?.id || '').slice(-8) || '—';
    this.resultRoundText.setText(`Round ${roundNumber}'s Result:  ${label}`);
    const estimatedPayout = snapshot.options.reduce((total, option) => {
      const won = option.id === winnerId || option.category === winnerId;
      return won ? total + option.myAmount * Math.max(0, Number(option.multiplier || 0)) : total;
    }, 0);
    const shownPayout = snapshot.round?.result?.payout_status === 'pending'
      ? estimatedPayout
      : snapshot.myPayout;
    this.resultEarningsText.setText(`This Round Earnings:  ${money(shownPayout)}`);
    this.resultBetsText.setText(`This Round Bets:  ${money(snapshot.myTotalBet)}`);
    this.resultRankingRows.removeAll(true);
    const resultRanking = snapshot.round?.result?.top_winners;
    const entries = (Array.isArray(resultRanking) ? resultRanking : [])
      .slice(0, 3) as Array<Record<string, unknown>>;
    const viewportHeight = window.__GAME_EMBEDDED__ === true ? this.scale.height : 960;
    const popupBottom = 24 + Math.min(viewportHeight - 48, 450);
    const startY = Math.min(345, popupBottom - 151);
    if (!entries.length) {
      const rankingMessage = snapshot.round?.result?.payout_status === 'pending'
        ? 'Finalizing winner balances…'
        : 'No winners this round';
      this.resultRankingRows.add(this.add.text(270, startY + 25, rankingMessage, {
        fontFamily: 'Arial', fontSize: '17px', color: '#78828b', fontStyle: 'bold',
      }).setOrigin(0.5));
      return;
    }
    entries.forEach((entry: any, index) => {
      const x = entries.length === 1 ? 270 : entries.length === 2 ? 180 + index * 180 : 105 + index * 165;
      const y = startY + 30;
      const name = String(entry.name || 'Player');
      this.addAvatar(this.resultRankingRows, x, y, name, 52, index + 1, entry.user_id || entry.userId, entry.is_robot);
      const shownName = name.length > 12 ? `${name.slice(0, 11)}…` : name;
      this.resultRankingRows.add(this.add.text(x, y + 38, shownName, {
        fontFamily: 'Arial', fontSize: '13px', color: '#34404c', fontStyle: 'bold',
      }).setOrigin(0.5));
      this.resultRankingRows.add(this.add.text(x, y + 57, money(Number(entry.win_amount || entry.amount || entry.totalWin || entry.score || 0)), {
        fontFamily: 'Arial', fontSize: '13px', color: '#9a5529', fontStyle: 'bold',
      }).setOrigin(0.5));
    });
  }

  private createRankingOverlay(): RankingOverlay {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const viewportHeight = embedded ? this.scale.height : 960;
    const shade = this.add.rectangle(270, viewportHeight / 2, 540, viewportHeight, 0x07384d, 0.82).setInteractive();
    const panel = this.add.graphics().fillStyle(0x08b9e8, 1).fillRoundedRect(12, 12, 516, viewportHeight - 24, 20)
      .lineStyle(3, 0xcdf8ff, 1).strokeRoundedRect(12, 12, 516, viewportHeight - 24, 20);
    const heading = this.add.text(270, 43, "Today's Revenue Rank", {
      fontFamily: 'Arial Black, Arial', fontSize: embedded ? '27px' : '25px', color: '#FFFFFF', fontStyle: 'bold',
    }).setOrigin(0.5);
    const close = this.add.text(497, 43, '×', {
      fontFamily: 'Arial', fontSize: '34px', color: '#FFFFFF',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    const headers = [
      this.add.text(58, 88, 'Ranking', { fontFamily: 'Arial', fontSize: '15px', color: '#BDEFFF' }),
      this.add.text(140, 88, 'Profile', { fontFamily: 'Arial', fontSize: '15px', color: '#BDEFFF' }),
      this.add.text(215, 88, 'Name', { fontFamily: 'Arial', fontSize: '15px', color: '#BDEFFF' }),
      this.add.text(500, 88, 'Revenue', { fontFamily: 'Arial', fontSize: '15px', color: '#BDEFFF' }).setOrigin(1, 0),
    ];
    const divider = this.add.graphics().lineStyle(2, 0xc8f6ff, 0.9).lineBetween(28, 114, 512, 114);
    const rows = this.add.container(0, 0);
    const rowsTop = 120;
    const rowsHeight = Math.max(120, viewportHeight - rowsTop - 18);
    const maskShape = this.add.graphics().fillStyle(0xffffff, 1).fillRect(20, rowsTop, 500, rowsHeight).setVisible(false);
    rows.setMask(maskShape.createGeometryMask());
    const scrollZone = this.add.zone(270, rowsTop + rowsHeight / 2, 500, rowsHeight).setInteractive({ useHandCursor: true });
    this.input.setDraggable(scrollZone);
    let dragStartY = 0;
    let startOffset = 0;
    let minOffset = 0;
    scrollZone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      dragStartY = pointer.y;
      startOffset = rows.y;
    });
    scrollZone.on('drag', (pointer: Phaser.Input.Pointer) => {
      rows.y = Phaser.Math.Clamp(startOffset + pointer.y - dragStartY, minOffset, 0);
    });
    const container = this.add.container(0, 0, [shade, panel, heading, ...headers, divider, rows, maskShape, scrollZone, close])
      .setDepth(1100).setVisible(false).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    close.on('pointerdown', () => {
      container.setVisible(false);
      this.modalOverlayOpen = false;
    });
    return {
      container,
      show: () => {
        this.modalOverlayOpen = true;
        container.setVisible(true);
        container.setDepth(100000);
        container.parentContainer?.bringToTop(container);
        this.children.bringToTop(container);
      },
      update: (ranking: GameRankingEntry[]) => {
        rows.removeAll(true);
        rows.setY(0);
        if (!ranking.length) {
          rows.add(this.add.text(270, rowsTop + 55, 'No ranking activity yet today', {
            fontFamily: 'Arial', fontSize: '19px', color: '#E9FCFF', fontStyle: 'bold',
          }).setOrigin(0.5));
          minOffset = 0;
          return;
        }
        ranking.slice(0, 20).forEach((entry, index) => {
          const y = rowsTop + 38 + index * 68;
          rows.add(this.add.text(62, y, String(index + 1), {
            fontFamily: 'Arial', fontSize: '23px', color: '#FFFFFF', fontStyle: 'bold',
          }).setOrigin(0.5));
          this.addAvatar(rows, 140, y, entry.name, 50, index + 1, entry.userId);
          const shownName = entry.name.length > 20 ? `${entry.name.slice(0, 19)}…` : entry.name;
          rows.add(this.add.text(178, y, shownName, {
            fontFamily: 'Arial', fontSize: '18px', color: '#FFFFFF', fontStyle: 'bold', fixedWidth: 210,
          }).setOrigin(0, 0.5));
          rows.add(this.add.text(500, y, money(entry.score), {
            fontFamily: 'Arial', fontSize: '18px', color: '#FFF4B3', fontStyle: 'bold',
          }).setOrigin(1, 0.5));
        });
        minOffset = Math.min(0, rowsHeight - Math.min(20, ranking.length) * 68 - 8);
      },
    };
  }

  private addAvatar(
    parent: Phaser.GameObjects.Container,
    x: number,
    y: number,
    name: string,
    size: number,
    rank?: number,
    userId?: unknown,
    explicitBot?: unknown,
  ) {
    const frame = this.add.graphics()
      .fillStyle(rank === 1 ? 0xffd85a : 0xe8f8fb, 1).fillCircle(x, y, size / 2)
      .lineStyle(2, rank && rank <= 3 ? 0xfff0a0 : 0x8bdceb, 1).strokeCircle(x, y, size / 2);
    parent.add(frame);
    if (isBotIdentity(userId, explicitBot)) {
      addBotProfileAvatar(this, parent, x, y, size, userId || name);
      parent.bringToTop(frame);
    } else {
      parent.add(this.add.text(x, y, (name.trim().charAt(0) || 'P').toUpperCase(), {
        fontFamily: 'Arial Black, Arial', fontSize: `${Math.round(size * 0.42)}px`, color: '#1683a3', fontStyle: 'bold',
      }).setOrigin(0.5));
    }
    if (rank && rank <= 3) {
      parent.add(this.add.text(x - size / 2 + 2, y + size / 2 - 4, String(rank), {
        fontFamily: 'Arial', fontSize: '11px', color: '#704613', fontStyle: 'bold', backgroundColor: '#FFE46B', padding: { x: 3, y: 1 },
      }).setOrigin(0.5));
    }
  }

  private textureForResult(position: string) {
    if (!position) return null;
    const texture = position === 'pizza' || position === 'salad' ? `${position}Food` : position;
    return this.textures.exists(texture) ? texture : null;
  }

  private animateNewRobotBets(snapshot: GameSnapshot) {
    const roundId = snapshot.round?.id || null;
    const robotBets = snapshot.publicBets.filter((bet) => String(bet.userId).startsWith('robot:'));
    if (this.robotRoundId !== roundId) {
      this.robotRoundId = roundId;
      this.seenRobotBetIds = new Set(robotBets.map((bet) => String(bet.id || '')));
      this.clearRobotFlights();
      return;
    }
    const incoming = robotBets
      .filter((bet) => bet.id && !this.seenRobotBetIds.has(String(bet.id)))
      .sort((left, right) => Date.parse(left.createdAt || '') - Date.parse(right.createdAt || ''));
    incoming.forEach((bet) => this.seenRobotBetIds.add(String(bet.id)));
    if (this.modalOverlayOpen || !this.bettingOpen) return;
    const availableFlights = Math.max(0, 4 - this.flyingBotChips.size);
    if (availableFlights === 0) return;
    incoming.slice(-availableFlights).forEach((bet) => this.launchRobotChip(bet));
  }

  private launchRobotChip(bet: GamePublicBet) {
    if (this.modalOverlayOpen || !this.bettingOpen) return;
    const amount = Number(bet.amount || 0);
    const view = this.itemViews.get(bet.position);
    const source = this.chipButtons.get(amount) || this.chipButtons.get(1000);
    if (!view || !source) return;

    const sourceMatrix = source.getWorldTransformMatrix();
    const targetMatrix = view.container.getWorldTransformMatrix();
    const startX = sourceMatrix.tx;
    const startY = sourceMatrix.ty;
    const targetX = targetMatrix.tx;
    const targetY = targetMatrix.ty;
    const flight = this.add.container(startX, startY).setDepth(90).setScale(0.72);
    const chip = this.add.graphics();
    const chipColor = amount >= 100000 ? 0xe5234b : amount >= 50000 ? 0x8b36d0 : amount >= 5000 ? 0x6730c9 : 0xe52367;
    chip.fillStyle(chipColor, 1).fillCircle(0, 0, 18)
      .lineStyle(3, 0xfff2a0, 1).strokeCircle(0, 0, 18)
      .lineStyle(2, 0xffffff, 0.8).strokeCircle(0, 0, 13);
    const label = this.add.text(0, 0, compact(amount), {
      fontFamily: 'Arial Black, Arial', fontSize: '10px', color: '#FFFFFF', fontStyle: 'bold',
    }).setOrigin(0.5);
    // Robot identity banners were visually noisy and often had no avatar.
    // Keep the authoritative chip flight only.
    flight.add([chip, label]);
    this.flyingBotChips.add(flight);

    const seed = this.stableRoundRandom(String(bet.id || bet.createdAt || amount));
    const duration = 260 + seed * 150;
    const arcHeight = 30 + seed * 40;
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration,
      ease: 'Sine.easeInOut',
      onUpdate: (tween) => {
        if (!flight.active) return;
        const progress = Number(tween.getValue()) || 0;
        flight.setPosition(
          Phaser.Math.Linear(startX, targetX, progress),
          Phaser.Math.Linear(startY, targetY, progress) - Math.sin(progress * Math.PI) * arcHeight,
        );
        chip.setAngle(progress * 540);
        flight.setScale(0.72 + Math.sin(progress * Math.PI) * 0.28);
      },
      onComplete: () => {
        this.flyingBotChips.delete(flight);
        if (flight.active) flight.destroy(true);
        if (!this.bettingOpen) return;
        this.tweens.add({ targets: view.total, scale: 1.16, duration: 80, yoyo: true, ease: 'Back.Out' });
      },
    });
  }

  private clearRobotFlights() {
    this.flyingBotChips.forEach((chip) => {
      if (chip.active) chip.destroy(true);
    });
    this.flyingBotChips.clear();
  }

  private stableRoundRandom(roundId: string) {
    let hash = 2166136261;
    for (let index = 0; index < roundId.length; index += 1) {
      hash ^= roundId.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967296;
  }

  private formatHistoryDate(value: unknown) {
    const date = new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return 'Recent round';
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
}
