import Phaser from 'phaser';
import { loadEmbeddedAssets } from '../../shared/AssetLoader';
import { BaseGameScene } from '../../shared/BaseGameScene';
import { getRoundSecondsLeft } from '../../shared/GameClock';
import { createPlayerBetFeed, createRankingOverlay, type PlayerBetFeed, type RankingOverlay } from '../../shared/GameHud';
import type { GamePublicBet, GameSnapshot, NativeToGameMessage } from '../../shared/types';
import background from '../assets/background.webp';
import balanceDiamond from '../../greedy-lion/assets/balance-diamond.webp';
import chip1k from '../../shared/assets/chip_1k.webp';
import chip5k from '../../shared/assets/chip_5k.webp';
import chip50k from '../../shared/assets/chip_50k.webp';
import chip100k from '../../shared/assets/chip_100k.webp';
import { CHIP_AMOUNTS, LUCKY_DICE_OPTIONS } from '../config';

const money = (value: number) => Math.round(value || 0).toLocaleString('en-US');
const compact = (value: number) => {
  const amount = Number(value) || 0;
  const unit = (size: number, suffix: string) => `${Number((amount / size).toFixed(amount >= size * 10 ? 0 : 1))}${suffix}`;
  if (amount >= 1e15) return unit(1e15, 'Q');
  if (amount >= 1e12) return unit(1e12, 'T');
  if (amount >= 1e9) return unit(1e9, 'B');
  if (amount >= 1e6) return unit(1e6, 'M');
  if (amount >= 1e3) return unit(1e3, 'K');
  return String(amount);
};

interface BetView {
  container: Phaser.GameObjects.Container;
  frame: Phaser.GameObjects.Graphics;
  total: Phaser.GameObjects.Text;
  mine: Phaser.GameObjects.Text;
  multiplier: Phaser.GameObjects.Text;
  hit: Phaser.GameObjects.Zone;
}

interface DieView {
  container: Phaser.GameObjects.Container;
  face: Phaser.GameObjects.Graphics;
  pips: Phaser.GameObjects.Graphics;
}

export class LuckyDiceScene extends BaseGameScene {
  private bets = new Map<string, BetView>();
  private chipSelectionRings = new Map<number, Phaser.GameObjects.Graphics>();
  private chipSelectionMarks = new Map<number, Phaser.GameObjects.Text>();
  private dice: DieView[] = [];
  private timerText!: Phaser.GameObjects.Text;
  private walletText!: Phaser.GameObjects.Text;
  private totalText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private historyItems!: Phaser.GameObjects.Container;
  private resultOverlay!: Phaser.GameObjects.Container;
  private resultDice: DieView[] = [];
  private resultGlows: Phaser.GameObjects.Graphics[] = [];
  private resultText!: Phaser.GameObjects.Text;
  private resultCountdown!: Phaser.GameObjects.Text;
  private rulesOverlay!: Phaser.GameObjects.Container;
  private rankingOverlay!: RankingOverlay;
  private bettorFeed!: PlayerBetFeed;
  private soundButton!: Phaser.GameObjects.Text;
  private optimisticFeed: Array<GamePublicBet & { requestId: string }> = [];
  private resultTimer?: Phaser.Time.TimerEvent;
  private rollingTimer?: Phaser.Time.TimerEvent;
  private lastTimerSecond = -1;
  private bettingOpen = false;

  constructor() { super({ key: 'LuckyDiceScene' }); }

  preload() {
    loadEmbeddedAssets(this, { background, balanceDiamond, chip1k, chip5k, chip50k, chip100k });
  }

  protected resultAnimationTimeoutMs() { return 3300; }

  protected build() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    this.add.image(270, 480, 'background').setDisplaySize(540, 960);
    this.add.rectangle(270, 480, 540, 960, 0x020705, embedded ? 0.52 : 0.34).setName('embedded-background-overlay');

    if (embedded) {
      const walletBox = this.add.graphics().setPosition(52, 48)
        .setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1).setDepth(18);
      walletBox.fillStyle(0x130d20, 0.96).fillRoundedRect(-46, -18, 92, 36, 18)
        .lineStyle(2, 0xe6bd55, 0.9).strokeRoundedRect(-46, -18, 92, 36, 18);
      this.add.image(21, 48, 'balanceDiamond').setDisplaySize(22, 22)
        .setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1).setDepth(19);
      this.walletText = this.add.text(63, 48, '0', {
        fontFamily: 'Arial', fontSize: '16px', color: '#FFFFFF', fontStyle: 'bold', align: 'center',
      }).setOrigin(0.5).setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1).setDepth(19);
      const timerBox = this.add.graphics().setPosition(472, 138)
        .setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1).setDepth(12);
      timerBox.fillStyle(0x17101f, 0.96).fillRoundedRect(-42, -18, 84, 36, 16)
        .lineStyle(2, 0xe6bd55, 0.9).strokeRoundedRect(-42, -18, 84, 36, 16);
    } else {
      this.walletText = this.add.text(24, 24, '0', {
        fontFamily: 'Arial', fontSize: '16px', color: '#FFFFFF', fontStyle: 'bold',
      }).setOrigin(0, 0.5);
    }
    this.timerText = this.add.text(embedded ? 472 : 270, embedded ? 138 : 28, '--', {
      fontFamily: 'Arial', fontSize: embedded ? '21px' : '22px', color: '#FFD86A', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(13).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);

    this.bettorFeed = createPlayerBetFeed(this, embedded ? 110 : 96, {
      showAmount: !embedded, showChrome: !embedded, vertical: embedded, large: true, maxEntries: embedded ? 1 : 4,
    });
    this.createHeaderButton('RANK', embedded ? 426 : 392, () => this.rankingOverlay.show(), embedded ? 46 : 66, embedded ? 48 : undefined);
    this.createHeaderButton('?', embedded ? 476 : 460, () => {
      this.rulesOverlay.setVisible(true);
      this.children.bringToTop(this.rulesOverlay);
    }, embedded ? 38 : 30, embedded ? 48 : undefined);
    this.soundButton = this.createHeaderButton('♪', embedded ? 518 : 505, () => {
      const enabled = this.audio.toggle();
      this.soundButton.setText(enabled ? '♪' : '×');
    }, embedded ? 38 : 30, embedded ? 48 : undefined);

    this.dice = [140, 245, 350].map((x) => {
      const die = this.createDie(x, 105, 1, 100);
      die.container.setDepth(6).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.9 : 0);
      return die;
    });
    this.totalText = this.add.text(245, 170, 'TOTAL --', {
      fontFamily: 'Arial', fontSize: '23px', color: '#FFF1B2', fontStyle: 'bold',
    }).setOrigin(0.5).setStroke('#07100C', 4).setDepth(7)
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.92 : 0)
      .setVisible(false);

    LUCKY_DICE_OPTIONS.forEach((option, index) => this.createBetArea(option, index));
    this.statusText = this.add.text(270, 750, 'Place your bets', {
      fontFamily: 'Arial', fontSize: '18px', color: '#FFFFFF', fontStyle: 'bold',
      backgroundColor: '#071A14', padding: { x: 14, y: 6 },
    }).setOrigin(0.5);

    const chipTray = this.add.graphics().fillStyle(0x07140f, 0.5).fillRoundedRect(102, 779, 336, 62, 24);
    chipTray.setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    CHIP_AMOUNTS.forEach((amount, index) => this.createChip(amount, 150 + index * 80, 810));

    const historyPanel = this.add.graphics().setPosition(270, 900);
    historyPanel.setName('embedded-history-panel').setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    this.add.text(18, 866, 'ROLL HISTORY', { fontFamily: 'Arial', fontSize: '15px', color: '#EACB79', fontStyle: 'bold' })
      .setOrigin(0, 0.5).setName('embedded-history-label').setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    this.historyItems = this.add.container(0, 912).setName('embedded-history-items')
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);

    this.resultOverlay = this.createResultOverlay();
    this.rulesOverlay = this.createRulesGuide();
    this.rankingOverlay = createRankingOverlay(this, { largeText: true, scrollable: true, fullScreen: embedded });
  }

  update() {
    if (!this.snapshot?.round?.endsAt || this.snapshot.phase === 'RESULT_RECEIVED') return;
    const seconds = getRoundSecondsLeft(this.snapshot);
    if (seconds === this.lastTimerSecond) return;
    this.lastTimerSecond = seconds;
    this.timerText.setText(`${seconds}s`);
    if (seconds === 0) {
      this.setBetting(false);
      this.audio.play('lock');
      this.showStatus('No more bets • Rolling soon');
      this.beginPreRoll();
      this.sdk.requestRefresh('countdown-ended');
    } else if (seconds <= 5) this.audio.play('tick');
  }

  protected renderSnapshot(snapshot: GameSnapshot, newRound: boolean) {
    if (newRound) {
      this.rollingTimer?.remove(false);
      this.rollingTimer = undefined;
      this.tweens.killTweensOf(this.dice.map((die) => die.container));
      this.dice.forEach((die, index) => die.container.setPosition(140 + index * 105, 105).setAngle(0).setScale(1));
      this.resultOverlay.setVisible(false);
      this.resultGlows.forEach((glow) => glow.setAlpha(0.18).setScale(1));
      this.resultTimer?.remove(false);
      this.optimisticFeed = [];
      this.setDice([1, 1, 1]);
      this.totalText.setText('TOTAL --').setVisible(false);
    }
    this.walletText.setText(compact(snapshot.wallet));
    const unmatched = [...snapshot.publicBets];
    this.optimisticFeed = this.optimisticFeed.filter((pending) => {
      const match = unmatched.findIndex((bet) => bet.userId === pending.userId && bet.position === pending.position && bet.amount === pending.amount);
      if (match < 0) return true;
      unmatched.splice(match, 1);
      return false;
    });
    this.bettorFeed.update([...this.optimisticFeed, ...snapshot.publicBets]);
    snapshot.options.forEach((option) => {
      const view = this.bets.get(option.id);
      if (!view) return;
      view.total.setText(`Total ${compact(option.totalAmount)}`);
      view.mine.setText(`My ${compact(option.myAmount)}`);
      view.multiplier.setText(`${option.multiplier || 0}×`);
    });
    this.rankingOverlay.update(snapshot.dailyRanking);
    this.renderHistory(snapshot.history);
    this.setBetting(snapshot.phase === 'BETTING' && getRoundSecondsLeft(snapshot) > 0);
  }

  protected animateResult(snapshot: GameSnapshot, complete: () => void) {
    this.setBetting(false);
    this.rollingTimer?.remove(false);
    this.rollingTimer = undefined;
    this.tweens.killTweensOf(this.dice.map((die) => die.container));
    const values = this.resultValues(snapshot);
    this.showStatus('Royal dice rolling...');
    this.dice.forEach((die, index) => {
      const targetX = 140 + index * 105;
      this.tweens.add({
        targets: die.container, x: targetX + (index - 1) * 14, y: 91 + (index % 2) * 18,
        angle: 540 + index * 90, scale: 1.14, duration: 850, delay: index * 100, ease: 'Cubic.Out',
        onUpdate: (_tween, target) => {
          if (Math.floor(target.angle / 60) % 2 === 0) this.drawDie(die, Phaser.Math.Between(1, 6));
        },
        onComplete: () => {
          die.container.setPosition(targetX, 105).setAngle(0).setScale(1);
          this.drawDie(die, values[index]);
          if (index === 2) {
            this.totalText.setText(`TOTAL ${values.reduce((sum, value) => sum + value, 0)}`)
              .setVisible(true).setAlpha(0).setScale(0.7);
            this.tweens.add({ targets: this.totalText, alpha: 1, scale: 1, duration: 260, ease: 'Back.Out' });
            this.highlightWinners(snapshot.round?.winnerIds || [snapshot.round?.winnerId || '']);
            this.audio.play('win');
            complete();
          }
        },
      });
    });
  }

  protected showResult(snapshot: GameSnapshot) {
    const values = this.resultValues(snapshot);
    this.totalText.setText(`TOTAL ${values.reduce((sum, value) => sum + value, 0)}`).setVisible(true);
    this.resultDice.forEach((die, index) => this.drawDie(die, values[index]));
    const rawTopWinners = snapshot.round?.result?.top_winners;
    const topWinners = Array.isArray(rawTopWinners) ? rawTopWinners as Array<Record<string, unknown>> : [];
    const topWinner = topWinners[0];
    const topWinnerName = String(topWinner?.name || 'No winner');
    const displayName = topWinnerName.length > 15 ? `${topWinnerName.slice(0, 14)}…` : topWinnerName;
    const topWinnerAmount = Number(topWinner?.win_amount || topWinner?.amount || 0);
    const winningLabels = (snapshot.round?.winnerIds || [])
      .map((id) => snapshot.options.find((option) => option.id === id)?.label || id.replace(/_/g, ' '));
    this.resultText.setText([
      `TOTAL  ${values.reduce((sum, value) => sum + value, 0)}`,
      `WINS  ${winningLabels.join(' • ') || 'Result'}`,
      `Your Bet  ${money(snapshot.myTotalBet)}`,
      `You Won  ${money(snapshot.myPayout)}`,
      `Top Winner  ${displayName}`,
      `Amount  ${money(topWinnerAmount)}`,
    ].join('\n'));
    const targetY = this.resultDrawerTargetY();
    this.resultOverlay.setVisible(true).setAlpha(0).setY(targetY + 170);
    this.tweens.add({ targets: this.resultOverlay, y: targetY, alpha: 1, duration: 320, ease: 'Cubic.Out' });
    this.resultGlows.forEach((glow, index) => {
      glow.setAlpha(0.18).setScale(0.86);
      this.tweens.add({ targets: glow, alpha: 0.78, scale: 1.18, duration: 520, delay: index * 90, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
    });
    this.resultDice.forEach((die, index) => {
      die.container.setScale(0.7).setAlpha(0);
      this.tweens.add({ targets: die.container, scale: 1, alpha: 1, duration: 280, delay: 110 + index * 90, ease: 'Back.Out' });
    });
    let seconds = Math.max(3, snapshot.resultDisplaySeconds || 5);
    this.resultCountdown.setText(`Next round ${seconds}s`);
    this.resultTimer?.remove(false);
    this.resultTimer = this.time.addEvent({ delay: 1000, repeat: seconds - 1, callback: () => {
      seconds -= 1;
      this.resultCountdown.setText(`Next round ${Math.max(0, seconds)}s`);
    }});
  }

  protected onOptimisticBet(optionId: string, amount: number, requestId: string) {
    if (!this.snapshot) return;
    this.snapshot.options = this.snapshot.options.map((option) => option.id === optionId
      ? { ...option, totalAmount: option.totalAmount + amount, myAmount: option.myAmount + amount }
      : option);
    this.snapshot.totalPot += amount;
    this.snapshot.myTotalBet += amount;
    this.snapshot.wallet -= amount;
    this.optimisticFeed.push({ requestId, userId: this.viewer.userId || 'me', position: optionId, amount, name: this.viewer.displayName, avatarUrl: this.viewer.avatarUrl });
    this.renderSnapshot(this.snapshot, false);
  }

  protected onBetBatchResult(result: Extract<NativeToGameMessage, { type: 'BET_BATCH_RESULT' }>['payload']) {
    if (!result.accepted) this.optimisticFeed = [];
    if (typeof result.balance === 'number') this.walletText.setText(compact(result.balance));
  }

  protected onWalletUpdate(balance: number) { this.walletText?.setText(compact(balance)); }
  protected onNetworkState(connected: boolean, synchronizing: boolean) {
    if (!connected) this.showStatus('Reconnecting...');
    else if (synchronizing) this.showStatus('Synchronizing round...');
  }
  protected showStatus(message: string) { this.statusText?.setText(message); }

  private createBetArea(option: typeof LUCKY_DICE_OPTIONS[number], index: number) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const column = index % 3;
    const row = Math.floor(index / 3);
    const width = 146;
    const x = 94 + column * 176;
    const y = 265 + row * 172;
    const height = 108;
    const container = this.add.container(x, y)
      .setData('embeddedPreserveX', embedded)
      .setData('embeddedFinalScale', embedded ? 0.68 : 0);
    const frame = this.add.graphics();
    frame.setData('width', width).setData('height', height);
    this.drawBetFrame(frame, false, true);
    const label = this.add.text(0, -35, option.label, { fontFamily: 'Arial', fontSize: '19px', color: '#FFF0AA', fontStyle: 'bold' }).setOrigin(0.5);
    const multiplier = this.add.text(0, -6, `${option.multiplier}×`, { fontFamily: 'Arial', fontSize: '21px', color: '#F8D263', fontStyle: 'bold' }).setOrigin(0.5);
    const total = this.add.text(0, 24, 'Total 0', { fontFamily: 'Arial', fontSize: '17px', color: '#FFFFFF', fontStyle: 'bold' }).setOrigin(0.5);
    const mine = this.add.text(0, 44, 'My 0', { fontFamily: 'Arial', fontSize: '17px', color: '#6FF0AA', fontStyle: 'bold' }).setOrigin(0.5);
    const hit = this.add.zone(0, 0, width, height).setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => this.placeBet(option.id));
    hit.on('pointerover', () => { if (this.bettingOpen) this.drawBetFrame(frame, true, true); });
    hit.on('pointerout', () => this.drawBetFrame(frame, false, this.bettingOpen));
    container.add([frame, label, multiplier, total, mine, hit]);
    this.bets.set(option.id, { container, frame, total, mine, multiplier, hit });
  }

  private drawBetFrame(frame: Phaser.GameObjects.Graphics, selected: boolean, enabled: boolean) {
    const width = Number(frame.getData('width')); const height = Number(frame.getData('height'));
    frame.clear().fillStyle(selected ? 0x315c3d : 0x071d16, enabled ? 0.92 : 0.62)
      .fillRoundedRect(-width / 2, -height / 2, width, height, 12)
      .lineStyle(selected ? 3 : 2, selected ? 0xffdc69 : 0xb78631, enabled ? 1 : 0.45)
      .strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
  }

  private setBetting(open: boolean) {
    this.bettingOpen = open;
    this.bets.forEach((view) => {
      if (open) view.hit.setInteractive({ useHandCursor: true }); else view.hit.disableInteractive();
      this.drawBetFrame(view.frame, false, open);
    });
  }

  private highlightWinners(ids: string[]) {
    this.bets.forEach((view, id) => this.drawBetFrame(view.frame, ids.includes(id), false));
  }

  private createDie(x: number, y: number, value: number, size: number) {
    const container = this.add.container(x, y);
    const face = this.add.graphics(); const pips = this.add.graphics();
    const die = { container, face, pips };
    container.add([face, pips]);
    container.setData('size', size);
    this.drawDie(die, value);
    return die;
  }

  private drawDie(die: DieView, value: number) {
    const size = Number(die.container.getData('size')) || 62;
    const half = size / 2;
    die.face.clear().fillStyle(0xfff8de, 1).fillRoundedRect(-half, -half, size, size, size * 0.16)
      .lineStyle(3, 0xd3a743, 1).strokeRoundedRect(-half, -half, size, size, size * 0.16);
    die.pips.clear().fillStyle(value === 1 ? 0xb32131 : 0x18241d, 1);
    const d = size * 0.23; const r = size * 0.065;
    const map: Record<number, Array<[number, number]>> = {
      1: [[0, 0]], 2: [[-d, -d], [d, d]], 3: [[-d, -d], [0, 0], [d, d]],
      4: [[-d, -d], [d, -d], [-d, d], [d, d]],
      5: [[-d, -d], [d, -d], [0, 0], [-d, d], [d, d]],
      6: [[-d, -d], [d, -d], [-d, 0], [d, 0], [-d, d], [d, d]],
    };
    (map[value] || map[1]).forEach(([px, py]) => die.pips.fillCircle(px, py, r));
  }

  private setDice(values: number[]) { this.dice.forEach((die, index) => this.drawDie(die, values[index] || 1)); }
  private beginPreRoll() {
    if (this.rollingTimer) return;
    this.dice.forEach((die, index) => this.tweens.add({
      targets: die.container, y: 95 + index * 7, angle: index % 2 ? 18 : -18,
      duration: 180, yoyo: true, repeat: -1, ease: 'Sine.InOut',
    }));
    this.rollingTimer = this.time.addEvent({ delay: 110, loop: true, callback: () => {
      this.dice.forEach((die) => this.drawDie(die, Phaser.Math.Between(1, 6)));
    }});
  }
  private resultValues(snapshot: GameSnapshot) {
    const dice = snapshot.round?.result?.dice;
    return Array.isArray(dice) && dice.length === 3 ? dice.map((value) => Phaser.Math.Clamp(Number(value) || 1, 1, 6)) : [1, 1, 1];
  }

  private createChip(amount: number, x: number, y: number) {
    const key = amount === 1000 ? 'chip1k' : amount === 5000 ? 'chip5k' : amount === 50000 ? 'chip50k' : 'chip100k';
    const embedded = window.__GAME_EMBEDDED__ === true;
    const ring = this.add.graphics().setPosition(x, y).setDepth(9)
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.68 : 0);
    const image = this.add.image(x, y, key).setDisplaySize(54, 54).setDepth(10)
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.68 : 0)
      .setInteractive({ useHandCursor: true });
    const mark = this.add.text(x + 21, y - 21, '✓', {
      fontFamily: 'Arial Black, Arial', fontSize: '17px', color: '#102600',
      backgroundColor: '#FFF36A', padding: { left: 3, right: 3, top: 0, bottom: 0 },
    }).setOrigin(0.5).setDepth(11)
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.68 : 0);
    this.chipSelectionRings.set(amount, ring);
    this.chipSelectionMarks.set(amount, mark);
    this.paintChipSelection(amount);
    image.on('pointerdown', () => {
      this.selectedAmount = amount;
      CHIP_AMOUNTS.forEach((chipAmount) => this.paintChipSelection(chipAmount));
      this.tweens.add({ targets: image, scale: 0.9, yoyo: true, duration: 90 });
    });
  }

  private paintChipSelection(amount: number) {
    const selected = amount === this.selectedAmount;
    const ring = this.chipSelectionRings.get(amount);
    ring?.clear();
    if (selected) ring?.lineStyle(8, 0xffd91a, 0.45).strokeCircle(0, 0, 34)
      .lineStyle(3, 0xffffff, 1).strokeCircle(0, 0, 31);
    this.chipSelectionMarks.get(amount)?.setVisible(selected);
  }

  private createHeaderButton(label: string, x: number, press: () => void, width = 30, embeddedY?: number) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const y = embedded ? embeddedY ?? 88 : 44;
    if (embedded) {
      const background = this.add.graphics().setPosition(x, y).setDepth(20)
        .setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1);
      background.fillStyle(0xb68119, 0.98).fillRoundedRect(-width / 2, -18, width, 36, 18)
        .lineStyle(2, 0xffe28a, 0.95).strokeRoundedRect(-width / 2, -18, width, 36, 18);
    } else {
      this.add.rectangle(x, y, width, 30, 0x24303b, 0.96).setStrokeStyle(1, 0xffd76a, 0.65).setDepth(20);
    }
    return this.add.text(x, y, label, {
      fontFamily: 'Arial',
      fontSize: embedded ? (label.length > 1 ? '13px' : label === '♪' ? '22px' : '18px') : (label.length > 1 ? '11px' : '15px'),
      color: embedded ? '#1C1204' : '#FFF0A5', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(21).setData('embeddedPreserveX', embedded)
      .setData('embeddedFinalScale', embedded ? 1 : 0).setInteractive({ useHandCursor: true })
      .on('pointerdown', press);
  }

  private renderHistory(rows: Array<Record<string, unknown>>) {
    this.historyItems.removeAll(true);
    rows.slice(0, 7).forEach((row, index) => {
      const result = (row.result || {}) as Record<string, unknown>;
      const values = Array.isArray(result.dice) ? result.dice : [];
      const group = this.add.container(43 + index * 76, 0);
      values.slice(0, 3).forEach((value, dieIndex) => {
        const die = this.createDie(-20 + dieIndex * 20, 0, Number(value), 27);
        group.add(die.container);
      });
      this.historyItems.add(group);
    });
  }

  private createResultOverlay() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const panel = this.add.graphics().fillStyle(0x071a14, 0.99).fillRoundedRect(15, 686, 510, 268, 22)
      .lineStyle(3, 0xe2b64d, 1).strokeRoundedRect(15, 686, 510, 268, 22);
    const diceTitle = this.add.text(178, 720, 'WINNING DICE', {
      fontFamily: 'Arial', fontSize: '18px', color: '#FFE07C', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.resultGlows = [94, 178, 262].map((x) => this.add.graphics().setPosition(x, 800)
      .fillStyle(0xffd45c, 0.2).fillCircle(0, 0, 38)
      .lineStyle(3, 0xffe898, 0.8).strokeCircle(0, 0, 38));
    this.resultDice = [94, 178, 262].map((x) => this.createDie(x, 800, 1, 56));
    this.resultText = this.add.text(304, 706, '', {
      fontFamily: 'Arial', fontSize: '15px', color: '#FFFFFF', fontStyle: 'bold', lineSpacing: 6,
      fixedWidth: 205, wordWrap: { width: 205 },
    }).setOrigin(0, 0);
    this.resultCountdown = this.add.text(502, 925, '', { fontFamily: 'Arial', fontSize: '18px', color: '#FFE07C', fontStyle: 'bold' }).setOrigin(1, 0.5);
    return this.add.container(0, 190, [
      panel, diceTitle, ...this.resultGlows, ...this.resultDice.map((die) => die.container), this.resultText, this.resultCountdown,
    ])
      .setDepth(150).setVisible(false).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.94 : 0);
  }

  private resultDrawerTargetY() {
    if (window.__GAME_EMBEDDED__ !== true) return 0;
    const viewportHeight = this.scale.height;
    const contentScale = Phaser.Math.Clamp((viewportHeight - 12) / 960, 0.48, 0.86);
    const layerY = Math.max(6, (viewportHeight - 960 * contentScale) / 2);
    const drawerScale = 0.94;
    const drawerBottom = 954;
    const safeBottom = viewportHeight - 8;
    return (safeBottom - layerY - drawerBottom * drawerScale) / contentScale;
  }

  private createRulesGuide() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const viewportHeight = embedded ? this.scale.height : 960;
    const panelX = embedded ? 2 : 28;
    const panelY = embedded ? 2 : 100;
    const panelWidth = embedded ? 536 : 484;
    const panelHeight = embedded ? viewportHeight - 4 : 720;
    const contentTop = embedded ? 92 : 185;
    const contentBottom = embedded ? viewportHeight - 62 : 730;
    const shade = this.add.rectangle(270, viewportHeight / 2, 540, viewportHeight, 0x020604, 0.94).setInteractive();
    const panel = this.add.graphics().fillStyle(0x0b2119, 1).fillRoundedRect(panelX, panelY, panelWidth, panelHeight, 10)
      .lineStyle(2, 0xe0b34e, 1).strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, 10);
    const title = this.add.text(270, embedded ? 34 : 140, 'HOW TO PLAY', {
      fontFamily: 'Arial', fontSize: embedded ? '32px' : '27px', color: '#FFE07C', fontStyle: 'bold',
    }).setOrigin(0.5);
    const lines = [
      'Three dice are rolled by the backend after betting closes.',
      'SMALL: total 4-10 • loses on a triple • 2× return',
      'BIG: total 11-17 • loses on a triple • 2× return',
      'ODD / EVEN: total parity • loses on a triple • 2× return',
      'ANY TRIPLE: all three dice match • 31× return',
      'TOTAL 6 / 15: exact total • 15× return',
      'TOTAL 9 / 12: exact total • 7× return',
      '',
      'You may bet on multiple zones. One roll can win more than one bet.',
      'Wallet deductions, dice values and payouts are always confirmed by the server.',
    ];
    const body = this.add.text(50, 0, lines.join('\n\n'), {
      fontFamily: 'Arial', fontSize: '22px', color: '#F2F1E9', lineSpacing: 11,
      fixedWidth: 440, wordWrap: { width: 440 },
    });
    const scrollContent = this.add.container(0, contentTop, [body]);
    const maskShape = this.add.graphics().fillStyle(0xffffff, 1).fillRect(embedded ? 8 : 40, contentTop, embedded ? 524 : 460, contentBottom - contentTop).setVisible(false);
    scrollContent.setMask(maskShape.createGeometryMask());
    const scrollZone = this.add.zone(270, (contentTop + contentBottom) / 2, embedded ? 516 : 450, contentBottom - contentTop).setInteractive({ useHandCursor: true });
    this.input.setDraggable(scrollZone);
    let dragStartY = 0;
    let offsetAtDragStart = 0;
    let scrollOffset = 0;
    const minimumOffset = Math.min(0, contentBottom - contentTop - body.height - 12);
    scrollZone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      dragStartY = pointer.y;
      offsetAtDragStart = scrollOffset;
    });
    scrollZone.on('drag', (pointer: Phaser.Input.Pointer) => {
      scrollOffset = Phaser.Math.Clamp(offsetAtDragStart + pointer.y - dragStartY, minimumOffset, 0);
      scrollContent.setY(contentTop + scrollOffset);
    });
    const close = this.add.text(270, embedded ? viewportHeight - 30 : 782, 'CLOSE', {
      fontFamily: 'Arial', fontSize: embedded ? '20px' : '17px', color: '#251704', fontStyle: 'bold',
      backgroundColor: '#E0B34E', padding: { x: 28, y: 12 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    const overlay = this.add.container(0, 0, [shade, panel, title, scrollContent, maskShape, scrollZone, close])
      .setDepth(1000).setVisible(false)
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    close.on('pointerdown', () => overlay.setVisible(false));
    return overlay;
  }
}
