import Phaser from 'phaser';
import { loadEmbeddedAssets } from '../../shared/AssetLoader';
import { BaseGameScene } from '../../shared/BaseGameScene';
import type { GamePublicBet, GameSnapshot, NativeToGameMessage } from '../../shared/types';
import background from '../assets/background.webp';
import club from '../assets/club.webp';
import diamond from '../assets/diamond.webp';
import heart from '../assets/heart.webp';
import spade from '../assets/spade.webp';
import chairRed from '../assets/chair-red.webp';
import chairBlue from '../assets/chair-blue.webp';
import chairGreen from '../assets/chair-green.webp';
import balanceDiamond from '../../greedy-lion/assets/balance-diamond.webp';
import chip1k from '../../shared/assets/chip_1k.webp';
import chip5k from '../../shared/assets/chip_5k.webp';
import chip50k from '../../shared/assets/chip_50k.webp';
import chip100k from '../../shared/assets/chip_100k.webp';
import { CHIP_AMOUNTS, TEEN_PATTI_OPTIONS } from '../config';
import { createPlayerBetFeed, createRankingOverlay, type PlayerBetFeed, type RankingOverlay } from '../../shared/GameHud';
import { getResultSecondsLeft, getRoundSecondsLeft } from '../../shared/GameClock';
import { visibleTeenPattiRank } from '../HandEvaluator';
import botProfileAtlas from '../../shared/assets/bot-avatar-atlas.webp';
import { addBotProfileAvatar, BOT_PROFILE_ATLAS_KEY, isBotIdentity } from '../../shared/BotProfiles';

// Floor on how briefly the result drawer may be shown, so a reveal that lands
// late still gets read rather than being skipped entirely.
const MIN_RESULT_VISIBLE_SECONDS = 3;

const money = (value: number) => Math.round(value || 0).toLocaleString('en-US');
const compact = (value: number) => value >= 1000 ? `${value / 1000}K` : String(value);
const walletMoney = (value: number) => {
  const amount = Number(value) || 0;
  const shortened = (unit: number, suffix: string) => {
    const scaled = amount / unit;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${suffix}`;
  };
  if (amount >= 1e15) return shortened(1e15, 'Q');
  if (amount >= 1e12) return shortened(1e12, 'T');
  if (amount >= 1e9) return shortened(1e9, 'B');
  if (amount >= 1e6) return shortened(1e6, 'M');
  return money(amount);
};
const stableBotAnimationValue = (identity: string) => {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
};
interface CardView {
  container: Phaser.GameObjects.Container;
  back: Phaser.GameObjects.Graphics;
  front: Phaser.GameObjects.Graphics;
  value: Phaser.GameObjects.Text;
  suit: Phaser.GameObjects.Image;
  targetX: number;
  targetY: number;
}

interface BoardView {
  container: Phaser.GameObjects.Container;
  frame: Phaser.GameObjects.Graphics;
  chair: Phaser.GameObjects.Image;
  pot: Phaser.GameObjects.Text;
  mine: Phaser.GameObjects.Text;
  rank: Phaser.GameObjects.Text;
  cards: CardView[];
}

type OptimisticBet = GamePublicBet & {
  requestId: string;
  baselineMyAmount: number;
  committed: boolean;
};

export class TeenPattiScene extends BaseGameScene {
  private boards = new Map<string, BoardView>();
  private chipButtons = new Map<number, Phaser.GameObjects.Graphics>();
  private chipLabels = new Map<number, Phaser.GameObjects.Text>();
  private chipSelectionMarks = new Map<number, Phaser.GameObjects.Text>();
  private flyingBotChips = new Set<Phaser.GameObjects.Container>();
  private timerText!: Phaser.GameObjects.Text;
  private walletText!: Phaser.GameObjects.Text;
  private historyItems!: Phaser.GameObjects.Container;
  private statusText!: Phaser.GameObjects.Text;
  private networkText!: Phaser.GameObjects.Text;
  private resultOverlay!: Phaser.GameObjects.Container;
  private resultTitle!: Phaser.GameObjects.Text;
  private resultDetail!: Phaser.GameObjects.Text;
  private resultWinnerRows!: Phaser.GameObjects.Container;
  private resultCountdownText!: Phaser.GameObjects.Text;
  private resultChair!: Phaser.GameObjects.Image;
  private resultCards: CardView[] = [];
  private rulesOverlay!: Phaser.GameObjects.Container;
  private rankingOverlay!: RankingOverlay;
  private myHistoryOverlay!: Phaser.GameObjects.Container;
  private myHistoryRows!: Phaser.GameObjects.Container;
  private bettorFeed!: PlayerBetFeed;
  private soundButton!: Phaser.GameObjects.Text;
  private winnerTween?: Phaser.Tweens.Tween;
  private settlementStep?: Phaser.Time.TimerEvent;
  private settlementHighlightIndex = -1;
  private settlementDirection = 1;
  private resultFlyers: Phaser.GameObjects.GameObject[] = [];
  private winnerEffects: Phaser.GameObjects.GameObject[] = [];
  private optimisticFeed: OptimisticBet[] = [];
  private resultCountdown?: Phaser.Time.TimerEvent;
  private resultRoundId: string | null = null;
  private bettingOpen = false;
  private bettingClosedSoundPlayed = false;
  private lastTimerSecond = -1;
  private botRoundId: string | null = null;
  private seenRobotBetIds = new Set<string>();
  private modalOverlayOpen = false;

  constructor() {
    super({ key: 'TeenPattiScene' });
  }

  preload() {
    loadEmbeddedAssets(this, {
      background, club, diamond, heart, spade, chairRed, chairBlue, chairGreen,
      balanceDiamond, chip1k, chip5k, chip50k, chip100k,
      [BOT_PROFILE_ATLAS_KEY]: botProfileAtlas,
    });
  }

  protected build() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    if (embedded) this.add.rectangle(270, 480, 540, 960, 0xb5e6fb);
    else this.add.image(270, 480, 'background').setDisplaySize(540, 960);
    if (embedded) {
      const balanceBackground = this.add.graphics().setPosition(52, 48)
        .setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1).setDepth(18);
      balanceBackground.fillStyle(0x1b2a5c, 0.96).fillRoundedRect(-46, -18, 92, 36, 18)
        .lineStyle(2, 0xe6bd55, 0.9).strokeRoundedRect(-46, -18, 92, 36, 18);
      this.add.image(21, 48, 'balanceDiamond').setDisplaySize(22, 22)
        .setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1).setDepth(19);
      this.walletText = this.add.text(63, 48, '0', {
        fontFamily: 'Arial', fontSize: '16px', color: '#FFFFFF', fontStyle: 'bold', align: 'center',
      }).setOrigin(0.5).setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1).setDepth(19);
      const timerBackground = this.add.graphics().setPosition(270, 48)
        .setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1).setDepth(12);
      timerBackground.fillStyle(0x1b2a5c, 0.96).fillRoundedRect(-48, -21, 96, 42, 17)
        .lineStyle(2, 0xe6bd55, 0.9).strokeRoundedRect(-48, -21, 96, 42, 17);
    } else {
      this.walletText = this.add.text(24, 24, '0', { fontFamily: 'Arial', fontSize: '16px', color: '#FFFFFF', fontStyle: 'bold' }).setOrigin(0, 0.5);
    }
    this.timerText = this.add.text(270, embedded ? 48 : 28, '--', {
      fontFamily: 'Arial', fontSize: embedded ? '24px' : '22px', color: '#FFD86A', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(13).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    this.bettorFeed = embedded
      ? { update: () => {} }
      : createPlayerBetFeed(this, 88, { showAmount: true, showChrome: true });

    // Standalone keeps the felt table, which sits on its own background image.
    // Embedded does not: there the felt was a dark green oval floating on the
    // light blue backdrop, which read as a stray green circle behind the boards.
    if (!embedded) {
      this.add.ellipse(270, 420, 500, 410, 0x0a3f30, 0.78).setStrokeStyle(6, 0x8a5d2b, 1);
      this.add.ellipse(270, 420, 460, 372, 0x0a2f27, 0.35).setStrokeStyle(2, 0xe4b85c, 0.45);
    }
    TEEN_PATTI_OPTIONS.forEach((option) => this.createBoard(option));

    this.statusText = this.add.text(270, embedded ? 632 : 638, 'Place your bets', {
      fontFamily: 'Arial', fontSize: embedded ? '16px' : '13px', color: '#FFFFFF', fontStyle: 'bold',
      backgroundColor: '#1B2A5C', padding: { x: 12, y: 6 },
    }).setOrigin(0.5);
    this.add.text(270, 680, 'SELECT CHIP', { fontFamily: 'Arial', fontSize: '11px', color: '#D6CEE0', fontStyle: 'bold' }).setOrigin(0.5).setVisible(!embedded);
    CHIP_AMOUNTS.forEach((amount, index) => this.createChip(
      amount,
      embedded ? 66 + index * 102 : 62 + index * 104,
      embedded ? 770 : 730,
    ));
    const historyPanel = embedded
      ? this.add.graphics().setPosition(270, 842)
        .fillStyle(0x1b2a5c, 0.9).fillRoundedRect(-250, -32, 500, 64, 20)
        .lineStyle(1, 0xd9ab50, 0.45).strokeRoundedRect(-250, -32, 500, 64, 20)
      : this.add.rectangle(270, 842, 500, 82, 0x1b2a5c, 0.9).setStrokeStyle(1, 0xd9ab50, 0.45);
    historyPanel.setName('embedded-history-panel').setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    this.historyItems = this.add.container(0, embedded ? 843 : 0).setName('embedded-history-items').setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0).setInteractive(new Phaser.Geom.Rectangle(20, embedded ? -38 : 805, 500, 78), Phaser.Geom.Rectangle.Contains);
    this.historyItems.on('pointerdown', () => this.sdk.send('OPEN_HISTORY', {}));
    this.networkText = this.add.text(270, 910, '', { fontFamily: 'Arial', fontSize: '12px', color: '#FFDD82', fontStyle: 'bold' }).setOrigin(0.5).setName('embedded-network-status');
    this.createResultOverlay();
    this.createMyHistoryOverlay();
    this.rulesOverlay = this.createRulesGuide();
    this.rankingOverlay = createRankingOverlay(this, {
      largeText: true, scrollable: true, fullScreen: embedded, theme: embedded ? 'blue' : undefined,
      onShow: () => { this.modalOverlayOpen = true; this.stopSimulatedBotBets(false); },
      onClose: () => { this.modalOverlayOpen = false; this.resumeSimulatedBotBets(); },
    });
    this.createHeaderButton('RANK', embedded ? 348 : 392, () => this.rankingOverlay.show(), embedded ? 52 : 66, embedded ? 48 : undefined);
    this.createHeaderButton('?', embedded ? 408 : 460, () => {
      this.sdk.send('OPEN_RULES', {});
      this.rulesOverlay.setVisible(true);
      this.children.bringToTop(this.rulesOverlay);
    }, embedded ? 42 : 30, embedded ? 48 : undefined);
    this.soundButton = this.createHeaderButton('♪', embedded ? 458 : 505, () => {
      const enabled = this.audio.toggle();
      this.soundButton.setText(enabled ? '♪' : '×');
      this.showStatus(enabled ? 'Sound enabled' : 'Sound muted');
    }, embedded ? 42 : 30, embedded ? 48 : undefined);
    if (embedded) this.createHeaderButton('↺', 508, () => {
      this.modalOverlayOpen = true;
      this.stopSimulatedBotBets(false);
      this.sdk.requestRefresh('my-history-opened');
      this.myHistoryOverlay.setVisible(true).setDepth(100000);
      this.myHistoryOverlay.parentContainer?.bringToTop(this.myHistoryOverlay);
    }, 42, 48);
  }

  update() {
    const snapshot = this.snapshot;
    if (!snapshot?.round?.endsAt || snapshot.phase === 'RESULT_RECEIVED') return;
    const seconds = getRoundSecondsLeft(snapshot);
    if (seconds === this.lastTimerSecond) return;
    this.lastTimerSecond = seconds;
    this.timerText.setText(seconds > 0 ? `${seconds}s` : '0s');
    if (seconds === 0) {
      this.closeBetting();
      this.sdk.requestRefresh('countdown-ended');
    }
  }

  protected renderSnapshot(snapshot: GameSnapshot, newRound: boolean) {
    if (newRound) this.resetRoundVisuals();
    this.walletText.setText(walletMoney(this.getDisplayWallet(snapshot.wallet)));
    this.reconcileCommittedBets(snapshot);
    const displayBets = snapshot.publicBets.flatMap((bet) => {
      if (this.viewer.userId && bet.userId === this.viewer.userId) return [{
        ...bet,
        name: bet.name === 'Player' ? this.viewer.displayName : bet.name,
        avatarUrl: bet.avatarUrl || this.viewer.avatarUrl,
      }];
      if (bet.name === 'Player' && !bet.avatarUrl) return [];
      return [bet];
    });
    if (window.__GAME_EMBEDDED__ !== true) this.bettorFeed.update([...this.optimisticFeed, ...displayBets]);
    this.rankingOverlay.update(snapshot.dailyRanking);
    this.renderMyHistory(snapshot.myHistory);
    snapshot.options.forEach((option) => {
      const board = this.boards.get(option.id);
      const pending = this.optimisticFeed
        .filter((bet) => bet.position === option.id)
        .reduce((sum, bet) => sum + bet.amount, 0);
      board?.pot.setText(`Total ${money(option.totalAmount + pending)}`);
      board?.mine.setText(`My: ${money(option.myAmount + pending)}`);
    });
    if (snapshot.phase !== 'RESULT_RECEIVED') this.renderPublicFirstCards(snapshot);
    this.renderHistory(snapshot.history);
    if (snapshot.phase === 'BETTING_CLOSED' || snapshot.phase === 'RESULT_PENDING') {
      this.statusText.setText('No more bets • Dealer is preparing cards');
      this.timerText.setText('0s');
      this.closeBetting();
    }
    this.animateNewRobotBets(snapshot);
    if (snapshot.phase === 'RESULT_RECEIVED'
      && this.resultRoundId === snapshot.round?.id
      && this.resultOverlay.visible) {
      this.updateResultDetails(snapshot);
    }
  }

  protected animateResult(snapshot: GameSnapshot, complete: () => void) {
    this.stopSettlementSweep();
    this.setBettingEnabled(false);
    const hands = (snapshot.round?.result?.hands || {}) as Record<string, any>;
    const remainingCards: Array<{ card: CardView; data: any }> = [];
    TEEN_PATTI_OPTIONS.forEach((option) => {
      const board = this.boards.get(option.id);
      if (!board) return;
      const cards = hands[option.id]?.cards || [];
      this.showCardFace(board.cards[0], cards[0] || {});
      board.rank.setText('OPEN CARD').setColor('#C9D1DD').setVisible(true);
      board.cards.slice(1).forEach((card, index) => remainingCards.push({ card, data: cards[index + 1] || {} }));
    });
    remainingCards.forEach(({ card }, index) => {
      card.container.setPosition(270, 180).setAlpha(0).setScale(0.74);
      this.tweens.add({
        targets: card.container,
        x: card.targetX,
        y: card.targetY,
        alpha: 1,
        scale: 1,
        duration: 180,
        delay: index * 35,
        ease: 'Cubic.easeOut',
        onStart: () => this.audio.play('card'),
      });
    });
    const dealDuration = 180 + (remainingCards.length - 1) * 35;
    this.time.delayedCall(dealDuration + 40, () => {
      remainingCards.forEach(({ card, data }, index) => {
        this.time.delayedCall(index * 45, () => this.flipCard(card, data));
      });
    });
    this.time.delayedCall(dealDuration + 40 + remainingCards.length * 45 + 160, () => {
      const winnerId = snapshot.round?.winnerId;
      this.boards.forEach((board, boardId) => {
        const winning = boardId === winnerId;
        const rank = visibleTeenPattiRank(hands[boardId]);
        board.rank.setText(winning ? `WIN • ${rank.toUpperCase()}` : rank.toUpperCase())
          .setColor(winning ? '#FFE273' : '#D9DCE4')
          .setVisible(true);
        this.drawBoardFrame(board, winning);
        board.container.setAlpha(winning ? 1 : 0.72);
      });
      const winnerBoard = winnerId ? this.boards.get(winnerId) : undefined;
      if (winnerBoard) {
        this.winnerTween = this.tweens.add({
          targets: winnerBoard.container, scale: this.boardScale(1.045), yoyo: true, duration: 150,
        });
      }
      this.audio.play('win');
      this.time.delayedCall(winnerBoard ? 220 : 40, () => {
        if (!winnerBoard || !winnerId) {
          complete();
          return;
        }
        this.animateResultIntoDrawer(snapshot, winnerId, winnerBoard, complete);
      });
    });
  }

  protected showResult(snapshot: GameSnapshot) {
    const roundId = snapshot.round?.id;
    if (!roundId || this.resultRoundId === roundId) return;
    this.resultRoundId = roundId;
    // The player must always see how the round ended. This used to hide the
    // drawer outright whenever the authoritative window had already lapsed by
    // the time the reveal animation finished - and placing a bet adds exactly
    // the latency that causes that (the batch RPC, the wallet reconcile and the
    // extra refreshes it triggers), which is why the result vanished only for
    // players who had staked something. Show it regardless, with a floor on how
    // briefly it may appear.
    const authoritativeSecondsLeft = getResultSecondsLeft(snapshot);
    const initialSecondsLeft = Math.max(authoritativeSecondsLeft, MIN_RESULT_VISIBLE_SECONDS);
    const closeAt = Date.now() + initialSecondsLeft * 1000;
    this.updateResultDetails(snapshot);
    const drawerY = this.resultDrawerTargetY();
    const drawerAlreadyOpen = this.resultOverlay.visible;
    this.resultOverlay.setVisible(true).setAlpha(1);
    if (drawerAlreadyOpen) this.resultOverlay.setY(drawerY);
    else {
      this.resultOverlay.setY(drawerY + 220);
      this.tweens.add({ targets: this.resultOverlay, y: drawerY, duration: 260, ease: 'Cubic.easeOut' });
    }
    this.resultChair.setVisible(true);
    this.resultTitle.setVisible(true);
    this.resultCards.forEach((card) => card.container.setVisible(true));
    this.resultCountdownText.setText(`Next round in ${initialSecondsLeft}s`);
    this.resultCountdown?.remove(false);
    this.resultCountdown = this.time.addEvent({
      delay: 250,
      loop: true,
      callback: () => {
        // Count against the local deadline, not the authoritative window: when
        // the window has already lapsed the latter is pinned at 0 and would shut
        // the drawer on its first tick, before the player could read it.
        const secondsLeft = Math.max(0, Math.ceil((closeAt - Date.now()) / 1000));
        this.resultCountdownText.setText(`Next round in ${secondsLeft}s`);
        if (secondsLeft === 0) {
          this.resultCountdown?.remove(false);
          this.resultCountdown = undefined;
          this.tweens.add({
            targets: this.resultOverlay,
            y: drawerY + 220,
            duration: 220,
            ease: 'Cubic.easeIn',
            onComplete: () => this.resultOverlay.setVisible(false),
          });
          this.statusText.setText('Preparing next round...');
          this.sdk.requestRefresh('authoritative-result-boundary');
        }
      },
    });
  }

  protected onOptimisticBet(optionId: string, amount: number, requestId: string) {
    const board = this.boards.get(optionId);
    const pending = this.optimisticFeed
      .filter((bet) => bet.position === optionId)
      .reduce((sum, bet) => sum + bet.amount, amount);
    const option = this.snapshot?.options.find((entry) => entry.id === optionId);
    const baselineMyAmount = this.optimisticFeed.find((bet) => bet.position === optionId)?.baselineMyAmount
      ?? option?.myAmount
      ?? 0;
    if (board) {
      board.pot.setText(`Total ${money((option?.totalAmount || 0) + pending)}`);
      board.mine.setText(`My: ${money((option?.myAmount || 0) + pending)}`);
      this.tweens.add({ targets: board.container, scale: this.boardScale(1.04), yoyo: true, duration: 100 });
    }
    this.optimisticFeed.unshift({
      id: requestId,
      requestId,
      userId: this.viewer.userId || 'current-player',
      position: optionId,
      amount,
      name: this.viewer.displayName || 'Player',
      avatarUrl: this.viewer.avatarUrl,
      createdAt: new Date().toISOString(),
      baselineMyAmount,
      committed: false,
    });
    this.bettorFeed.update([...this.optimisticFeed, ...(this.snapshot?.publicBets || [])]);
    this.showStatus(`Bet ${money(amount)} pending...`);
  }

  protected onBetResponse(requestId: string, accepted: boolean, betId?: string) {
    if (accepted) {
      const pending = this.optimisticFeed.find((bet) => bet.requestId === requestId);
      if (pending) pending.id = betId || pending.id;
    } else {
      this.optimisticFeed = this.optimisticFeed.filter((bet) => bet.requestId !== requestId);
    }
    if (this.snapshot) this.renderSnapshot(this.snapshot, false);
  }

  protected onBetBatchResult(result: Extract<NativeToGameMessage, { type: 'BET_BATCH_RESULT' }>['payload']) {
    const completed = new Set(result.requestIds);
    if (result.accepted) {
      this.optimisticFeed.forEach((bet) => {
        if (completed.has(bet.requestId)) bet.committed = true;
      });
      if (this.snapshot) this.reconcileCommittedBets(this.snapshot);
    } else {
      this.optimisticFeed = this.optimisticFeed.filter((bet) => !completed.has(bet.requestId));
    }
    if (this.snapshot) this.renderSnapshot(this.snapshot, false);
  }

  private reconcileCommittedBets(snapshot: GameSnapshot) {
    const positions = new Set(this.optimisticFeed.map((bet) => bet.position));
    positions.forEach((position) => {
      const pending = this.optimisticFeed.filter((bet) => bet.position === position);
      if (!pending.length) return;
      const baseline = Math.min(...pending.map((bet) => bet.baselineMyAmount));
      const authoritative = snapshot.options.find((option) => option.id === position)?.myAmount || 0;
      let acknowledged = Math.max(0, authoritative - baseline);
      const completedIds = new Set<string>();
      [...pending].reverse().forEach((bet) => {
        if (acknowledged >= bet.amount) {
          acknowledged -= bet.amount;
          completedIds.add(bet.requestId);
        }
      });
      if (completedIds.size) {
        this.optimisticFeed = this.optimisticFeed.filter((bet) => !completedIds.has(bet.requestId));
      }
    });
  }

  protected onWalletUpdate(balance: number) {
    this.walletText?.setText(walletMoney(balance));
  }

  protected onNetworkState(connected: boolean, synchronizing: boolean) {
    this.networkText?.setText(!connected ? 'Reconnecting...' : synchronizing ? 'Synchronizing round...' : '');
  }

  protected showStatus(message: string) {
    this.statusText?.setText(message);
  }

  protected afterEmbeddedLayout() {
    this.boards.forEach((board) => {
      board.cards.forEach((card) => {
        card.targetX = card.container.x;
        card.targetY = card.container.y;
      });
    });
    (this.children.getByName('embedded-history-panel') as Phaser.GameObjects.Graphics | undefined)?.setY(900);
    (this.children.getByName('embedded-history-items') as Phaser.GameObjects.Container | undefined)?.setY(909);
    const contentScale = Phaser.Math.Clamp((this.scale.height - 12) / 960, 0.48, 0.86);
    const layerY = Math.max(6, (this.scale.height - 960 * contentScale) / 2);
    this.rulesOverlay.setY(-layerY / contentScale);
    this.rankingOverlay.container.setY(-layerY / contentScale);
    this.myHistoryOverlay.setY(-layerY / contentScale);
  }

  private boardScale(multiplier = 1) {
    if (window.__GAME_EMBEDDED__ !== true) return multiplier;
    const contentScale = Phaser.Math.Clamp((this.scale.height - 12) / 960, 0.48, 0.86);
    return (0.84 / contentScale) * multiplier;
  }

  private createBoard(option: typeof TEEN_PATTI_OPTIONS[number]) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const optionIndex = TEEN_PATTI_OPTIONS.findIndex((entry) => entry.id === option.id);
    const x = embedded ? 112 + optionIndex * 158 : option.x;
    const container = this.add.container(x, embedded ? 430 : 420)
      .setData('embeddedPreserveX', embedded)
      .setData('embeddedFinalScale', embedded ? 0.84 : 0);
    const frame = this.add.graphics();
    const chair = this.add.image(0, embedded ? -137 : -151, option.chair).setDisplaySize(embedded ? 84 : 82, embedded ? 84 : 82);
    const pot = this.add.text(0, embedded ? -91 : -105, 'Total 0', { fontFamily: 'Arial', fontSize: embedded ? '18px' : '11px', color: '#FFFFFF', fontStyle: 'bold' }).setOrigin(0.5);
    const mine = this.add.text(0, embedded ? -66 : -87, 'My: 0', { fontFamily: 'Arial', fontSize: embedded ? '17px' : '10px', color: '#70EFA9', fontStyle: 'bold' }).setOrigin(0.5);
    const rank = this.add.text(0, embedded ? 101 : 132, '', { fontFamily: 'Arial', fontSize: embedded ? '17px' : '11px', color: '#FFE273', fontStyle: 'bold', fixedWidth: embedded ? 154 : undefined, align: 'center' }).setOrigin(0.5).setVisible(false);
    container.add([frame, chair, pot, mine, rank]).setSize(embedded ? 164 : 150, embedded ? 236 : 330).setInteractive({ useHandCursor: true });
    container.on('pointerdown', () => this.placeBet(option.id));
    const cards = (embedded ? [-24, 0, 24] : [-42, 0, 42]).map((offset) => this.createCard(x + offset, embedded ? 438 : 430));
    this.drawBoardFrame({ container, frame, chair, pot, mine, rank, cards }, false);
    this.boards.set(option.id, { container, frame, chair, pot, mine, rank, cards });
  }

  private createCard(x: number, y: number): CardView {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const halfWidth = embedded ? 48 : 18;
    const halfHeight = embedded ? 66 : 31;
    const container = this.add.container(x, y).setData('embeddedPreserveX', embedded);
    const back = this.add.graphics().fillStyle(0x8d1733, 1).fillRoundedRect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2, 5).lineStyle(2, 0xffdf88, 1).strokeRoundedRect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2, 5);
    back.lineStyle(1, 0xffc96a, 0.65).strokeRect(-halfWidth + 7, -halfHeight + 7, halfWidth * 2 - 14, halfHeight * 2 - 14);
    const front = this.add.graphics().fillStyle(0xfffbeb, 1).fillRoundedRect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2, 5).lineStyle(2, 0xd7bc76, 1).strokeRoundedRect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2, 5).setVisible(false);
    const value = this.add.text(-halfWidth + 7, -halfHeight + 7, 'A', { fontFamily: 'Arial', fontSize: embedded ? '29px' : '13px', color: '#151515', fontStyle: 'bold' }).setVisible(false);
    const suit = this.add.image(-halfWidth + (embedded ? 18 : 10), -halfHeight + (embedded ? 52 : 27), 'spade')
      .setDisplaySize(embedded ? 27 : 13, embedded ? 27 : 13).setVisible(false);
    container.add([back, front, value, suit]);
    return { container, back, front, value, suit, targetX: x, targetY: y };
  }

  private flipCard(card: CardView, data: any) {
    this.tweens.add({
      targets: card.container,
      scaleX: 0,
      duration: 110,
      ease: 'Quad.easeIn',
      onComplete: () => {
        this.showCardFace(card, data);
        this.tweens.add({ targets: card.container, scaleX: 1, duration: 130, ease: 'Quad.easeOut' });
      },
    });
  }

  private showCardFace(card: CardView, data: any) {
    const suitCode = String(data.suit || 'S').toUpperCase().charAt(0);
    const texture = suitCode === 'H' ? 'heart' : suitCode === 'D' ? 'diamond' : suitCode === 'C' ? 'club' : 'spade';
    const red = suitCode === 'H' || suitCode === 'D';
    card.container.setPosition(card.targetX, card.targetY).setScale(1).setAlpha(1);
    card.back.setVisible(false);
    card.front.setVisible(true);
    card.value.setText(String(data.value || '?')).setColor(red ? '#C51631' : '#151515').setVisible(true);
    card.suit.setTexture(texture).setVisible(true);
  }

  private renderPublicFirstCards(snapshot: GameSnapshot) {
    const firstCards = (snapshot.round?.result?.first_cards || {}) as Record<string, any>;
    this.boards.forEach((board, boardId) => {
      const card = firstCards[boardId];
      if (!card) return;
      this.showCardFace(board.cards[0], card);
      board.rank.setText('OPEN CARD').setColor('#C9D1DD').setVisible(true);
    });
  }

  private drawBoardFrame(board: BoardView, winner: boolean) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const halfWidth = embedded ? 82 : 73;
    const top = embedded ? -118 : -180;
    const height = embedded ? 236 : 350;
    board.frame.clear().fillStyle(winner ? 0x7a5a16 : 0x1b3a6b, 0.92)
      .fillRoundedRect(-halfWidth, top, halfWidth * 2, height, 9)
      .lineStyle(winner ? 4 : 2, winner ? 0xffe16b : 0xffd98a, winner ? 1 : 0.85)
      .strokeRoundedRect(-halfWidth, top, halfWidth * 2, height, 9);
  }

  private createChip(amount: number, x: number, y: number) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const chip = this.add.graphics().setPosition(x, y).setDepth(embedded ? 6 : 0)
      .setData('amount', amount)
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0)
      .setInteractive(new Phaser.Geom.Circle(0, 0, embedded ? 25 : 30), Phaser.Geom.Circle.Contains);
    if (chip.input) chip.input.cursor = 'pointer';
    const label = this.add.text(x, y, compact(amount), { fontFamily: 'Arial Black, Arial', fontSize: embedded ? '13px' : '12px', color: '#FFFFFF', fontStyle: 'bold' })
      .setOrigin(0.5).setDepth(embedded ? 7 : 1).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    const mark = this.add.text(x + (embedded ? 19 : 23), y - (embedded ? 19 : 23), '✓', {
      fontFamily: 'Arial Black, Arial', fontSize: embedded ? '14px' : '16px', color: '#102600',
      backgroundColor: '#FFF36A', padding: { left: 3, right: 3, top: 0, bottom: 0 },
    }).setOrigin(0.5).setDepth(embedded ? 8 : 2)
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    this.chipButtons.set(amount, chip);
    this.chipLabels.set(amount, label);
    this.chipSelectionMarks.set(amount, mark);
    this.paintChip(chip, amount === this.selectedAmount);
    chip.on('pointerdown', () => {
      this.selectedAmount = amount;
      this.chipButtons.forEach((button, chipAmount) => this.paintChip(button, chipAmount === amount));
      this.tweens.add({ targets: [chip, label], scale: 1.15, yoyo: true, duration: 110 });
    });
  }

  private paintChip(chip: Phaser.GameObjects.Graphics, selected: boolean) {
    const amount = Number(chip.getData('amount'));
    const embedded = window.__GAME_EMBEDDED__ === true;
    const radius = embedded ? 25 : 30;
    const color = amount >= 100000 ? 0xe5234b : amount >= 50000 ? 0x8b36d0 : amount >= 5000 ? 0x6730c9 : amount >= 1000 ? 0xe52367 : 0x168ec8;
    chip.clear();
    if (selected) chip.lineStyle(8, 0xffd91a, 0.42).strokeCircle(0, 0, radius + 6);
    chip.fillStyle(color, 1).fillCircle(0, 0, radius)
      .lineStyle(selected ? 4 : 3, selected ? 0xffffff : 0xfff1a0, 1).strokeCircle(0, 0, radius)
      .lineStyle(3, selected ? 0xffdf31 : 0xffffff, selected ? 1 : 0.82).strokeCircle(0, 0, radius - 7);
    for (let dot = 0; dot < 10; dot += 1) {
      const angle = dot / 10 * Math.PI * 2;
      chip.fillStyle(0xffffff, 0.95).fillCircle(Math.cos(angle) * (radius - 4), Math.sin(angle) * (radius - 4), 1.8);
    }
    this.chipLabels.get(amount)?.setColor(selected ? '#FFF36A' : '#FFFFFF');
    this.chipSelectionMarks.get(amount)?.setVisible(selected);
  }

  private createHeaderButton(label: string, x: number, onPress: () => void, width = 30, embeddedY?: number) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const y = embedded ? embeddedY ?? 88 : 44;
    if (embedded) {
      const background = this.add.graphics().setPosition(x, y).setDepth(20).setData('embeddedPreserveX', true).setData('embeddedFinalScale', 1);
      background.fillStyle(0xffc93c, 1).fillRoundedRect(-width / 2, -18, width, 36, 18)
        .lineStyle(2, 0xfff6cf, 1).strokeRoundedRect(-width / 2, -18, width, 36, 18);
    } else {
      this.add.rectangle(x, y, width, 30, 0x24303b, 0.96).setStrokeStyle(1, 0xffd76a, 0.65).setDepth(20);
    }
    return this.add.text(x, y, label, {
      fontFamily: 'Arial', fontSize: embedded ? (label.length > 1 ? '13px' : label === '♪' ? '22px' : '18px') : (label.length > 1 ? '11px' : '15px'), color: embedded ? '#1C1204' : '#FFF0A5', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(21).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0).setInteractive({ useHandCursor: true }).on('pointerdown', onPress);
  }

  private renderHistory(rows: Array<Record<string, unknown>>) {
    this.historyItems.removeAll(true);
    const embedded = window.__GAME_EMBEDDED__ === true;
    const history = (rows as any[]).filter((row) => {
      const winner = row.result?.winner_pos || row.winner_pos;
      return TEEN_PATTI_OPTIONS.some((option) => option.id === winner);
    }).slice(0, 7);
    if (!history.length) {
      this.historyItems.add(this.add.text(270, embedded ? 0 : 842, 'Waiting for first result', {
        fontFamily: 'Arial', fontSize: '12px', color: '#BFC2CF',
      }).setOrigin(0.5));
      return;
    }
    history.forEach((row, index) => {
      const winner = row.result?.winner_pos || row.winner_pos;
      const option = TEEN_PATTI_OPTIONS.find((entry) => entry.id === winner);
      if (!option) return;
      const x = embedded ? 60 + index * 70 : 66 + index * 68;
      const y = embedded ? 0 : 843;
      const chair = this.add.image(x, y, option.chair).setDisplaySize(embedded ? 48 : 50, embedded ? 48 : 50);
      const border = this.add.graphics()
        .lineStyle(index === 0 ? 3 : 1, index === 0 ? 0xffe273 : 0x8c789e, 0.9)
        .strokeCircle(x, y, embedded ? 23 : 27);
      this.historyItems.add([chair, border]);
    });
  }

  private createMyHistoryOverlay() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const viewportHeight = embedded ? this.scale.height : 960;
    const shade = this.add.rectangle(270, viewportHeight / 2, 540, viewportHeight, 0x07384d, 0.82).setInteractive();
    const panel = this.add.graphics().fillStyle(0x08b9e8, 1).fillRoundedRect(12, 12, 516, viewportHeight - 24, 20)
      .lineStyle(3, 0xcdf8ff, 1).strokeRoundedRect(12, 12, 516, viewportHeight - 24, 20);
    const heading = this.add.text(270, 45, 'My History', { fontFamily: 'Arial Black, Arial', fontSize: '27px', color: '#FFFFFF', fontStyle: 'bold' }).setOrigin(0.5);
    const close = this.add.text(495, 45, '×', { fontFamily: 'Arial', fontSize: '36px', color: '#FFFFFF' }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    const divider = this.add.graphics().lineStyle(2, 0xc8f6ff, 0.9).lineBetween(28, 78, 512, 78);
    this.myHistoryRows = this.add.container(0, 0);
    const rowsTop = 88; const rowsHeight = Math.max(120, viewportHeight - rowsTop - 18);
    const maskShape = this.add.graphics().fillStyle(0xffffff, 1).fillRect(20, rowsTop, 500, rowsHeight).setVisible(false);
    this.myHistoryRows.setMask(maskShape.createGeometryMask());
    const scroll = this.add.zone(270, rowsTop + rowsHeight / 2, 500, rowsHeight).setInteractive(); this.input.setDraggable(scroll);
    let startPointer = 0; let startY = 0;
    scroll.on('pointerdown', (p: Phaser.Input.Pointer) => { startPointer = p.y; startY = this.myHistoryRows.y; });
    scroll.on('drag', (p: Phaser.Input.Pointer) => {
      const count = Number(this.myHistoryRows.getData('rowCount') || 0);
      this.myHistoryRows.y = Phaser.Math.Clamp(startY + p.y - startPointer, Math.min(0, rowsHeight - count * 112 - 8), 0);
    });
    this.myHistoryOverlay = this.add.container(0, 0, [shade, panel, heading, divider, this.myHistoryRows, maskShape, scroll, close])
      .setDepth(1200).setVisible(false).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    close.on('pointerdown', () => { this.myHistoryOverlay.setVisible(false); this.modalOverlayOpen = false; this.resumeSimulatedBotBets(); });
  }

  private renderMyHistory(rows: Array<Record<string, unknown>>) {
    if (!this.myHistoryRows) return;
    if (!rows.length && this.myHistoryRows.getData('loaded')) return;
    this.myHistoryRows.removeAll(true).setY(0).setData('rowCount', rows.length);
    if (!rows.length) { this.myHistoryRows.add(this.add.text(270, 145, 'No personal bets yet', { fontFamily: 'Arial', fontSize: '20px', color: '#FFFFFF', fontStyle: 'bold' }).setOrigin(0.5)); return; }
    this.myHistoryRows.setData('loaded', true);
    rows.slice(0, 20).forEach((row: any, index) => {
      const y = 92 + index * 112;
      const bg = this.add.graphics().fillStyle(index % 2 ? 0x079ed2 : 0x08a9db, 0.94).fillRoundedRect(24, y, 492, 104, 10);
      const date = this.add.text(38, y + 12, new Date(row.created_at || Date.now()).toLocaleString(), { fontFamily: 'Arial', fontSize: '15px', color: '#D9F8FF', fontStyle: 'bold' });
      const label = this.add.text(40, y + 50, 'Select:', { fontFamily: 'Arial', fontSize: '18px', color: '#FFFFFF', fontStyle: 'bold' }).setOrigin(0, 0.5);
      this.myHistoryRows.add([bg, date, label]);
      const grouped = new Map<string, number>();
      (Array.isArray(row.positions) ? row.positions : []).forEach((entry: any) => grouped.set(String(entry.position), (grouped.get(String(entry.position)) || 0) + Number(entry.amount || 0)));
      [...grouped.entries()].slice(0, 3).forEach(([position, amount], i) => {
        const option = TEEN_PATTI_OPTIONS.find((item) => item.id === position); const x = 130 + i * 118;
        if (option) this.myHistoryRows.add(this.add.image(x, y + 50, option.chair).setDisplaySize(34, 34));
        this.myHistoryRows.add(this.add.text(x + 22, y + 50, money(amount), { fontFamily: 'Arial', fontSize: '16px', color: '#FFFFFF', fontStyle: 'bold' }).setOrigin(0, 0.5));
      });
      const winner = TEEN_PATTI_OPTIONS.find((item) => item.id === String(row.winner_pos || row.result?.winner_pos || ''));
      this.myHistoryRows.add(this.add.text(40, y + 83, 'Win:', { fontFamily: 'Arial', fontSize: '18px', color: '#FFFFFF', fontStyle: 'bold' }).setOrigin(0, 0.5));
      if (winner) this.myHistoryRows.add(this.add.image(130, y + 83, winner.chair).setDisplaySize(30, 30));
      this.myHistoryRows.add(this.add.text(152, y + 83, money(Number(row.total_win || 0)), { fontFamily: 'Arial', fontSize: '17px', color: '#FFF4A0', fontStyle: 'bold' }).setOrigin(0, 0.5));
    });
  }

  private resumeSimulatedBotBets() {
    if (this.snapshot) this.animateNewRobotBets(this.snapshot);
  }

  private animateNewRobotBets(snapshot: GameSnapshot) {
    const roundId = snapshot.round?.id || null;
    const robotBets = snapshot.publicBets.filter((bet) => isBotIdentity(bet.userId));
    if (this.botRoundId !== roundId) {
      this.stopSimulatedBotBets(true);
      this.botRoundId = roundId;
      this.seenRobotBetIds = new Set(robotBets.map((bet) => String(bet.id || '')));
      return;
    }
    const incoming = robotBets
      .filter((bet) => bet.id && !this.seenRobotBetIds.has(String(bet.id)))
      .sort((left, right) => Date.parse(left.createdAt || '') - Date.parse(right.createdAt || ''));
    incoming.forEach((bet) => this.seenRobotBetIds.add(String(bet.id)));
    if (this.modalOverlayOpen || !this.bettingOpen) return;
    incoming.slice(-4).forEach((bet, index) => {
      this.time.delayedCall(index * 70, () => this.launchRobotChip(bet));
    });
  }

  private launchRobotChip(bet: GamePublicBet) {
    if (this.modalOverlayOpen || !this.botRoundId || !this.snapshot) return;
    const amount = Number(bet.amount || 0);
    const option = TEEN_PATTI_OPTIONS.find((entry) => entry.id === bet.position);
    if (!option) return;
    const source = this.chipButtons.get(amount) || this.chipButtons.get(500);
    const board = this.boards.get(option.id);
    if (!source || !board) return;
    const sourceWorld = source.getWorldTransformMatrix();
    const targetWorld = board.container.getWorldTransformMatrix();
    const flight = this.add.container(sourceWorld.tx, sourceWorld.ty).setDepth(200).setScale(0.74);
    const chip = this.add.graphics();
    const color = amount >= 100000 ? 0xe5234b : amount >= 50000 ? 0x8b36d0 : amount >= 5000 ? 0x6730c9 : amount >= 1000 ? 0xe52367 : 0x168ec8;
    chip.fillStyle(color, 1).fillCircle(0, 0, 18)
      .lineStyle(3, 0xfff2a0, 1).strokeCircle(0, 0, 18)
      .lineStyle(2, 0xffffff, 0.82).strokeCircle(0, 0, 13);
    const label = this.add.text(0, 0, compact(amount), {
      fontFamily: 'Arial Black, Arial', fontSize: '10px', color: '#FFFFFF', fontStyle: 'bold',
    }).setOrigin(0.5);
    // Bot accounts use normal profile images in winner UI; chip flights stay
    // clean and match Greedy King without a special robot-name banner.
    flight.add([chip, label]);
    this.flyingBotChips.add(flight);
    const seed = stableBotAnimationValue(String(bet.id || bet.createdAt || amount));
    const duration = 260 + seed * 150;
    const arcHeight = 30 + seed * 40;
    this.tweens.addCounter({
      from: 0, to: 1, duration, ease: 'Sine.easeInOut',
      onUpdate: (tween) => {
        if (!flight.active) return;
        const progress = Number(tween.getValue()) || 0;
        flight.setPosition(
          Phaser.Math.Linear(sourceWorld.tx, targetWorld.tx, progress),
          Phaser.Math.Linear(sourceWorld.ty, targetWorld.ty, progress) - Math.sin(progress * Math.PI) * arcHeight,
        );
        chip.setAngle(progress * 540);
        flight.setScale(0.74 + Math.sin(progress * Math.PI) * 0.26);
      },
      onComplete: () => {
        this.flyingBotChips.delete(flight);
        if (flight.active) flight.destroy(true);
        if (!this.bettingOpen || this.snapshot?.round?.id !== this.botRoundId) return;
        this.tweens.add({ targets: board.pot, scale: 1.16, duration: 100, yoyo: true, ease: 'Back.Out' });
      },
    });
  }

  private stopSimulatedBotBets(clearRound: boolean) {
    this.flyingBotChips.forEach((chip) => { if (chip.active) chip.destroy(true); });
    this.flyingBotChips.clear();
    if (clearRound) {
      this.botRoundId = null;
      this.seenRobotBetIds.clear();
    }
  }

  private setBettingEnabled(enabled: boolean) {
    this.bettingOpen = enabled;
    this.boards.forEach((board) => {
      if (enabled) board.container.setInteractive({ useHandCursor: true });
      else board.container.disableInteractive();
      if (enabled) {
        board.container.setScale(this.boardScale()).setAlpha(1);
        this.drawBoardFrame(board, false);
      } else {
        board.container.setAlpha(0.55);
      }
      board.cards.forEach((card) => card.container.setAlpha(enabled ? 1 : 0.55));
    });
  }

  private startSettlementSweep() {
    if (this.settlementStep) return;
    this.setSettlementHighlight(0);
    this.settlementDirection = 1;
    this.settlementStep = this.time.addEvent({
      delay: 220,
      loop: true,
      callback: () => {
        if (this.settlementHighlightIndex === TEEN_PATTI_OPTIONS.length - 1) this.settlementDirection = -1;
        else if (this.settlementHighlightIndex === 0) this.settlementDirection = 1;
        this.setSettlementHighlight(this.settlementHighlightIndex + this.settlementDirection);
      },
    });
  }

  private setSettlementHighlight(index: number) {
    this.settlementHighlightIndex = index;
    TEEN_PATTI_OPTIONS.forEach((option, optionIndex) => {
      const board = this.boards.get(option.id);
      if (!board) return;
      const highlighted = optionIndex === index;
      this.drawBoardFrame(board, highlighted);
      board.container.setAlpha(highlighted ? 0.92 : 0.55);
    });
  }

  private stopSettlementSweep() {
    this.settlementStep?.remove(false);
    this.settlementStep = undefined;
    this.settlementHighlightIndex = -1;
    this.boards.forEach((board) => {
      this.drawBoardFrame(board, false);
      if (!this.bettingOpen) board.container.setAlpha(0.55);
    });
  }

  private closeBetting() {
    this.setBettingEnabled(false);
    this.stopSimulatedBotBets(false);
    this.startSettlementSweep();
    if (this.bettingClosedSoundPlayed) return;
    this.bettingClosedSoundPlayed = true;
    this.audio.play('lock');
  }

  private resetRoundVisuals() {
    this.stopSimulatedBotBets(true);
    this.stopSettlementSweep();
    this.resultCountdown?.remove(false);
    this.resultCountdown = undefined;
    this.resultRoundId = null;
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.winnerTween?.stop();
    this.resultOverlay.setVisible(false).setY(this.resultDrawerTargetY() + 220);
    this.resultFlyers.forEach((flyer) => flyer.destroy());
    this.resultFlyers = [];
    this.winnerEffects.forEach((effect) => effect.destroy());
    this.winnerEffects = [];
    this.optimisticFeed = [];
    this.bettingClosedSoundPlayed = false;
    this.lastTimerSecond = -1;
    this.boards.forEach((board) => {
      board.container.setScale(this.boardScale());
      board.chair.setPosition(0, window.__GAME_EMBEDDED__ === true ? -137 : -151).setScale(1).setAlpha(1).setVisible(true);
      board.rank.setVisible(false);
      this.drawBoardFrame(board, false);
      board.cards.forEach((card) => {
        card.container.setPosition(card.targetX, card.targetY).setScale(1).setAlpha(1).setAngle(0).setDepth(0);
        card.back.setVisible(true);
        card.front.setVisible(false);
        card.value.setVisible(false);
        card.suit.setVisible(false);
      });
    });
    this.setBettingEnabled(true);
    this.statusText.setText('Place your bets');
  }

  private updateResultDetails(snapshot: GameSnapshot) {
    const winnerId = snapshot.round?.winnerId;
    const option = TEEN_PATTI_OPTIONS.find((entry) => entry.id === winnerId);
    const hand = (snapshot.round?.result?.hands as Record<string, any> | undefined)?.[winnerId || ''] || {};
    const cards = Array.isArray(hand.cards) ? hand.cards : [];
    this.resultChair.setTexture(option?.chair || 'chairRed');
    this.resultTitle.setText(visibleTeenPattiRank(hand).toUpperCase());
    this.resultCards.forEach((card, index) => {
      const data = cards[index];
      if (data) this.showCardFace(card, data);
      else {
        card.back.setVisible(true);
        card.front.setVisible(false);
        card.value.setVisible(false);
        card.suit.setVisible(false);
      }
      card.container.setScale(window.__GAME_EMBEDDED__ === true ? 0.52 : 1);
    });
    const rawTopWinners = snapshot.round?.result?.top_winners;
    const topWinners = (Array.isArray(rawTopWinners) ? rawTopWinners : [])
      .slice(0, 3) as Array<Record<string, unknown>>;
    this.resultWinnerRows.removeAll(true);
    if (!topWinners.length) {
      this.resultWinnerRows.add(this.add.text(378, 849, 'No winners this round', {
        fontFamily: 'Arial', fontSize: '13px', color: '#D7DCE6', fontStyle: 'bold',
      }).setOrigin(0.5));
    } else {
      topWinners.forEach((winner: any, index) => {
        const y = 824 + index * 29;
        const name = String(winner.name || 'Player');
        const shownName = name.length > 13 ? `${name.slice(0, 12)}…` : name;
        const userId = winner.user_id || winner.userId;
        const frame = this.add.graphics().fillStyle(index === 0 ? 0xffd65c : 0xeaf8ff, 1)
          .fillCircle(298, y, 12).lineStyle(2, index === 0 ? 0xffef9b : 0x67b8dc, 1).strokeCircle(298, y, 12);
        this.resultWinnerRows.add(frame);
        if (isBotIdentity(userId, winner.is_robot)) {
          addBotProfileAvatar(this, this.resultWinnerRows, 298, y, 24, userId || name);
          this.resultWinnerRows.bringToTop(frame);
        } else {
          this.resultWinnerRows.add(this.add.text(298, y, (name.trim().charAt(0) || 'P').toUpperCase(), {
            fontFamily: 'Arial Black, Arial', fontSize: '10px', color: '#176D92', fontStyle: 'bold',
          }).setOrigin(0.5));
        }
        this.resultWinnerRows.add(this.add.text(316, y, `${index + 1}. ${shownName}`, {
          fontFamily: 'Arial', fontSize: '12px', color: '#FFFFFF', fontStyle: 'bold', fixedWidth: 102,
        }).setOrigin(0, 0.5));
        this.resultWinnerRows.add(this.add.text(480, y, money(Number(winner.win_amount || winner.amount || 0)), {
          fontFamily: 'Arial', fontSize: '12px', color: '#FFE27A', fontStyle: 'bold',
        }).setOrigin(1, 0.5));
      });
    }
    this.resultDetail.setText(snapshot.myPayout > 0 ? `Your win  ${money(snapshot.myPayout)}` : '');
  }

  private animateResultIntoDrawer(
    snapshot: GameSnapshot,
    winnerId: string,
    winnerBoard: BoardView,
    complete: () => void,
  ) {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const viewportHeight = this.scale.height;
    const contentScale = embedded
      ? Phaser.Math.Clamp((viewportHeight - 12) / 960, 0.48, 0.86)
      : 1;
    const layerY = embedded ? Math.max(6, (viewportHeight - 960 * contentScale) / 2) : 0;
    const toContentX = (screenX: number) => embedded ? 270 + (screenX - 270) / contentScale : screenX;
    const toContentY = (screenY: number) => embedded ? (screenY - layerY) / contentScale : screenY;
    const drawerScale = embedded ? 0.96 : 1;
    const targetCardScreenY = embedded ? viewportHeight - (960 - 850) * drawerScale : 820;
    const targetCardScreenXs = (embedded ? [170, 207, 244] : [170, 218, 266])
      .map((x) => x * drawerScale);

    this.updateResultDetails(snapshot);
    this.resultCountdownText.setText('Next round in 5s');
    this.resultOverlay.setVisible(true).setAlpha(1).setY(this.resultDrawerTargetY());
    this.resultChair.setVisible(false);
    this.resultTitle.setVisible(false);
    this.resultCards.forEach((card) => card.container.setVisible(false));

    this.boards.forEach((board, boardId) => {
      const winning = boardId === winnerId;
      const optionIndex = TEEN_PATTI_OPTIONS.findIndex((option) => option.id === boardId);
      board.cards.forEach((card, cardIndex) => {
        card.container.setDepth(140);
        if (winning) {
          this.tweens.add({
            targets: card.container,
            x: toContentX(targetCardScreenXs[cardIndex]),
            y: toContentY(targetCardScreenY),
            scale: embedded ? 0.5 / contentScale : 0.72,
            angle: (cardIndex - 1) * 3,
            duration: 430,
            delay: cardIndex * 38,
            ease: 'Cubic.easeInOut',
          });
        } else {
          const exitScreenX = optionIndex === 0 ? -80 : optionIndex === 2 ? 620 : 270 + (cardIndex - 1) * 70;
          const exitScreenY = optionIndex === 1 ? -90 : viewportHeight * 0.28 + cardIndex * 24;
          this.tweens.add({
            targets: card.container,
            x: toContentX(exitScreenX),
            y: toContentY(exitScreenY),
            scale: 0.32,
            alpha: 0,
            angle: (optionIndex === 0 ? -1 : 1) * (24 + cardIndex * 13),
            duration: 390,
            delay: cardIndex * 28,
            ease: 'Cubic.easeIn',
          });
        }
      });
    });
    winnerBoard.cards[0].container.parentContainer?.sort('depth');

    const chairWorld = winnerBoard.chair.getWorldTransformMatrix().transformPoint(0, 0);
    const winText = this.add.text(chairWorld.x, chairWorld.y, 'WIN', {
      fontFamily: 'Arial', fontSize: embedded ? '27px' : '22px', color: '#FFF2A3', fontStyle: 'bold',
      stroke: '#9B4B00', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(290);
    this.winnerEffects.push(winText);
    this.tweens.add({
      targets: winText,
      scale: 1.18,
      alpha: 0.78,
      yoyo: true,
      repeat: -1,
      duration: 280,
      ease: 'Sine.easeInOut',
    });
    const confettiColors = [0xffd75e, 0xff4f76, 0x62e7ff, 0x70ee91, 0xd789ff];
    for (let index = 0; index < 14; index += 1) {
      const confetti = this.add.rectangle(
        chairWorld.x + Phaser.Math.Between(-14, 14),
        chairWorld.y + Phaser.Math.Between(-10, 10),
        Phaser.Math.Between(4, 8),
        Phaser.Math.Between(8, 14),
        confettiColors[index % confettiColors.length],
        1,
      ).setDepth(285).setAngle(Phaser.Math.Between(-35, 35));
      this.winnerEffects.push(confetti);
      this.tweens.add({
        targets: confetti,
        x: chairWorld.x + Phaser.Math.Between(-72, 72),
        y: chairWorld.y + Phaser.Math.Between(42, 92),
        angle: Phaser.Math.Between(120, 300),
        alpha: 0,
        duration: Phaser.Math.Between(620, 920),
        delay: index * 28,
        ease: 'Cubic.easeOut',
      });
    }
    const chairFlyer = this.add.image(chairWorld.x, chairWorld.y, winnerBoard.chair.texture.key)
      .setDisplaySize(embedded ? 71 : 82, embedded ? 71 : 82)
      .setDepth(300);
    this.resultFlyers.push(chairFlyer);
    winnerBoard.chair.setVisible(false);
    this.tweens.add({
      targets: chairFlyer,
      x: (embedded ? 98 * drawerScale : 70),
      y: targetCardScreenY,
      displayWidth: embedded ? 64 * drawerScale : 88,
      displayHeight: embedded ? 64 * drawerScale : 88,
      duration: 470,
      ease: 'Cubic.easeInOut',
    });

    this.time.delayedCall(560, () => {
      this.resultFlyers.forEach((flyer) => flyer.destroy());
      this.resultFlyers = [];
      this.boards.forEach((board) => {
        board.chair.setVisible(true);
        board.cards.forEach((card) => {
          card.container.setPosition(card.targetX, card.targetY).setScale(1).setAlpha(1).setAngle(0).setDepth(0).setVisible(true);
        });
      });
      this.resultChair.setVisible(true);
      this.resultTitle.setVisible(true);
      this.resultCards.forEach((card) => card.container.setVisible(true));
      complete();
    });
  }

  private resultDrawerTargetY() {
    if (window.__GAME_EMBEDDED__ !== true) return 0;
    const viewportHeight = this.scale.height;
    const contentScale = Phaser.Math.Clamp((viewportHeight - 12) / 960, 0.48, 0.86);
    const layerY = Math.max(6, (viewportHeight - 960 * contentScale) / 2);
    const drawerScale = 0.96;
    return (viewportHeight - layerY - 960 * drawerScale) / contentScale;
  }

  private createResultOverlay() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const panel = this.add.graphics()
      .fillStyle(0x111722, 0.99).fillRoundedRect(embedded ? 45 : 0, embedded ? 805 : 748, embedded ? 450 : 540, embedded ? 145 : 212, 12)
      .lineStyle(2, 0xffd76a, 0.95).strokeRoundedRect(embedded ? 45 : 0, embedded ? 805 : 748, embedded ? 450 : 540, embedded ? 145 : 212, 12);
    this.resultChair = this.add.image(embedded ? 98 : 70, embedded ? 850 : 818, 'chairRed').setDisplaySize(embedded ? 64 : 88, embedded ? 64 : 88);
    this.resultTitle = this.add.text(embedded ? 98 : 70, embedded ? 902 : 885, 'WINNER', {
      fontFamily: 'Arial', fontSize: '12px', color: '#FFF0A5', fontStyle: 'bold', fixedWidth: 120, align: 'center',
    }).setOrigin(0.5);
    this.resultCards = (embedded ? [170, 207, 244] : [170, 218, 266]).map((x) => this.createCard(x, embedded ? 850 : 820));
    this.resultWinnerRows = this.add.container(0, 0);
    this.resultDetail = this.add.text(embedded ? 285 : 310, embedded ? 912 : 900, '', {
      fontFamily: 'Arial', fontSize: embedded ? '12px' : '13px', color: '#FFFFFF', lineSpacing: embedded ? 3 : 6,
      fixedWidth: embedded ? 185 : 210, wordWrap: { width: embedded ? 185 : 210 },
    });
    this.resultCountdownText = this.add.text(embedded ? 478 : 510, embedded ? 925 : 925, 'Next round in 5s', {
      fontFamily: 'Arial', fontSize: '11px', color: '#FFF0A5', fontStyle: 'bold',
    }).setOrigin(1, 0.5);
    this.resultOverlay = this.add.container(0, 220, [
      panel,
      this.resultChair,
      this.resultTitle,
      ...this.resultCards.map((card) => card.container),
      this.resultWinnerRows,
      this.resultDetail,
      this.resultCountdownText,
    ]).setDepth(100).setVisible(false).setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 0.96 : 0);
  }

  private createRulesGuide() {
    const embedded = window.__GAME_EMBEDDED__ === true;
    const viewportHeight = embedded ? this.scale.height : 960;
    const contentTop = 112;
    const contentBottom = viewportHeight - 62;
    const viewportContentHeight = contentBottom - contentTop;
    const overlay = this.add.container(0, 0).setDepth(1000).setVisible(false)
      .setData('embeddedPreserveX', embedded).setData('embeddedFinalScale', embedded ? 1 : 0);
    const shade = this.add.rectangle(270, viewportHeight / 2, 540, viewportHeight, 0x05070d, 0.96).setInteractive();
    const panel = this.add.graphics()
      .fillStyle(0x121824, 1).fillRoundedRect(2, 2, 536, viewportHeight - 4, 8)
      .lineStyle(2, 0xe1b85b, 0.9).strokeRoundedRect(2, 2, 536, viewportHeight - 4, 8);
    const title = this.add.text(270, 30, 'HOW TO PLAY', {
      fontFamily: 'Arial', fontSize: '31px', color: '#FFE28A', fontStyle: 'bold',
    }).setOrigin(0.5);
    const subtitle = this.add.text(270, 74, 'Swipe to see every hand from strongest to weakest', {
      fontFamily: 'Arial', fontSize: '17px', color: '#C9CFDA',
    }).setOrigin(0.5);
    const content = this.add.container(0, contentTop);
    const maskShape = this.add.graphics().fillStyle(0xffffff).fillRect(8, contentTop, 524, viewportContentHeight).setVisible(false);
    content.setMask(maskShape.createGeometryMask());

    content.add(this.add.text(24, 4, 'CHOOSE A CHAIR', {
      fontFamily: 'Arial', fontSize: '22px', color: '#FFE28A', fontStyle: 'bold',
    }));
    TEEN_PATTI_OPTIONS.forEach((option, index) => {
      const x = 112 + index * 158;
      content.add(this.add.image(x, 92, option.chair).setDisplaySize(104, 104));
      content.add(this.add.text(x, 151, option.label.replace(' CHAIR', ''), {
        fontFamily: 'Arial', fontSize: '18px', color: '#FFFFFF', fontStyle: 'bold',
      }).setOrigin(0.5));
    });
    content.add(this.add.text(24, 184,
      'Select a chip, then tap any chair before the timer closes. You can bet on all three chairs. The first card is public. The backend securely deals the other cards, chooses the winner, validates bets, and pays winnings.', {
        fontFamily: 'Arial', fontSize: '20px', color: '#DDE2EA', lineSpacing: 9,
        fixedWidth: 492, wordWrap: { width: 492 },
      }));
    content.add(this.add.text(24, 316, 'HAND RANKINGS', {
      fontFamily: 'Arial', fontSize: '24px', color: '#FFE28A', fontStyle: 'bold',
    }));

    const hands = [
      { title: '1. THREE OF A KIND / TRAIL', detail: 'Three cards of the same value', cards: [['A', 'H'], ['A', 'S'], ['A', 'D']] },
      { title: '2. FLUSH STRAIGHT / PURE SEQUENCE', detail: 'Three consecutive cards of one suit', cards: [['A', 'S'], ['K', 'S'], ['Q', 'S']] },
      { title: '3. STRAIGHT / SEQUENCE', detail: 'Three consecutive cards, mixed suits', cards: [['7', 'H'], ['6', 'D'], ['5', 'C']] },
      { title: '4. FLUSH / COLOR', detail: 'Same suit, but not consecutive', cards: [['K', 'H'], ['9', 'H'], ['4', 'H']] },
      { title: '5. PAIR', detail: 'Two cards of the same value', cards: [['Q', 'H'], ['Q', 'C'], ['9', 'D']] },
      { title: '6. HIGH CARD', detail: 'Highest cards decide when no hand forms', cards: [['A', 'S'], ['9', 'D'], ['4', 'C']] },
    ];
    hands.forEach((hand, index) => {
      const y = 356 + index * 154;
      const row = this.add.graphics()
        .fillStyle(index % 2 === 0 ? 0x1b2432 : 0x171e2a, 1).fillRoundedRect(14, y, 512, 142, 7)
        .lineStyle(1, 0x725d35, 0.7).strokeRoundedRect(14, y, 512, 142, 7);
      content.add(row);
      content.add(this.add.text(28, y + 18, hand.title, {
        fontFamily: 'Arial', fontSize: '20px', color: '#FFE28A', fontStyle: 'bold',
      }));
      content.add(this.add.text(28, y + 54, hand.detail, {
        fontFamily: 'Arial', fontSize: '17px', color: '#DDE2EA', fixedWidth: 282, wordWrap: { width: 282 },
      }));
      hand.cards.forEach(([value, suit], cardIndex) => {
        content.add(this.createGuideCard(350 + cardIndex * 62, y + 81, value, suit));
      });
    });
    const contentHeight = 1590;
    content.add(this.add.text(24, 1300,
      'HAND ORDER\nThree of a Kind > Flush Straight > Straight > Flush > Pair > High Card.\n\nSEQUENCE ORDER\nA-K-Q is highest, A-2-3 is second highest, then K-Q-J down to 4-3-2.\n\nTIES\nThree of a Kind compares the trio value. Pair compares the pair, then the kicker.\nFlush and High Card compare cards from highest to lowest. Exact ties share\nthe same visual rank; settlement always follows the authoritative backend result.', {
        fontFamily: 'Arial', fontSize: '18px', color: '#DDE2EA', lineSpacing: 9,
        fixedWidth: 492, wordWrap: { width: 492 },
      }));

    const viewport = this.add.rectangle(270, contentTop + viewportContentHeight / 2, 516, viewportContentHeight, 0xffffff, 0.001).setInteractive({ useHandCursor: true });
    const minY = contentTop - Math.max(0, contentHeight - viewportContentHeight);
    const scrollBy = (delta: number) => content.setY(Phaser.Math.Clamp(content.y + delta, minY, contentTop));
    let dragging = false;
    let lastPointerY = 0;
    viewport.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      dragging = true;
      lastPointerY = pointer.y;
    });
    viewport.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!dragging || !pointer.isDown) return;
      scrollBy(pointer.y - lastPointerY);
      lastPointerY = pointer.y;
    });
    const stopDragging = () => { dragging = false; };
    viewport.on('pointerup', stopDragging);
    viewport.on('pointerout', stopDragging);
    const onWheel = (_pointer: Phaser.Input.Pointer, _objects: unknown[], _deltaX: number, deltaY: number) => {
      if (overlay.visible) scrollBy(-deltaY * 0.7);
    };
    this.input.on('wheel', onWheel);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.input.off('wheel', onWheel));

    const closeY = viewportHeight - 30;
    const closeBox = this.add.rectangle(270, closeY, 154, 46, 0x8e2437, 1)
      .setStrokeStyle(1, 0xffdc83, 0.9).setInteractive({ useHandCursor: true });
    const closeText = this.add.text(270, closeY, 'CLOSE', {
      fontFamily: 'Arial', fontSize: '20px', color: '#FFFFFF', fontStyle: 'bold',
    }).setOrigin(0.5);
    closeBox.on('pointerdown', () => overlay.setVisible(false));
    closeText.setInteractive({ useHandCursor: true }).on('pointerdown', () => overlay.setVisible(false));
    overlay.add([shade, panel, title, subtitle, content, viewport, closeBox, closeText]);
    return overlay;
  }

  private createGuideCard(x: number, y: number, value: string, suitCode: string) {
    const red = suitCode === 'H' || suitCode === 'D';
    const texture = suitCode === 'H' ? 'heart' : suitCode === 'D' ? 'diamond' : suitCode === 'C' ? 'club' : 'spade';
    const container = this.add.container(x, y);
    const face = this.add.graphics()
      .fillStyle(0xfffbeb, 1).fillRoundedRect(-24, -38, 48, 76, 5)
      .lineStyle(1, 0xd7bc76, 1).strokeRoundedRect(-24, -38, 48, 76, 5);
    const cardValue = this.add.text(-18, -33, value, {
      fontFamily: 'Arial', fontSize: '18px', color: red ? '#C51631' : '#151515', fontStyle: 'bold',
    });
    const suit = this.add.image(5, 12, texture).setDisplaySize(27, 27);
    return container.add([face, cardValue, suit]);
  }
}
