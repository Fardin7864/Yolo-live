import Phaser from 'phaser';
import background from '../assets/background.webp';
import rocket from '../assets/rocket.webp';
import { sdk } from '../../shared/GameSDK';
import type { CrashPhase, CrashSnapshot } from '../../../src/game-platform/GameMessageTypes';
import { resolveCrashAction, type CrashAction } from '../CrashPolicy';

const GOLD = 0xffd86b;
const GREEN = 0x2ee6a6;
const RED = 0xff5573;
const PANEL = 0x101831;
const chips = [100, 500, 1000, 5000, 50000];

const money = (value: number) => Math.round(value).toLocaleString('en-US');
const multiplier = (bp = 100) => `${(Math.max(100, bp) / 100).toFixed(2)}×`;

export class CrashScene extends Phaser.Scene {
  private snapshot: CrashSnapshot = { sequence: 0, stateVersion: 0, serverTime: '', connected: false, round: null, myBet: null, wallet: 0, publicActivity: [], history: [] };
  private amount = 500;
  private autoCashoutBp: number | undefined = 200;
  private pendingBet = false;
  private pendingCashout = false;
  private displayedBp = 100;
  private bg!: Phaser.GameObjects.Image;
  private chrome!: Phaser.GameObjects.Graphics;
  private curve!: Phaser.GameObjects.Graphics;
  private multiplierText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private walletText!: Phaser.GameObjects.Text;
  private historyText!: Phaser.GameObjects.Text;
  private activityText!: Phaser.GameObjects.Text;
  private amountText!: Phaser.GameObjects.Text;
  private autoText!: Phaser.GameObjects.Text;
  private actionBg!: Phaser.GameObjects.Rectangle;
  private actionText!: Phaser.GameObjects.Text;
  private rocket!: Phaser.GameObjects.Image;
  private fairnessText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private amountLabel!: Phaser.GameObjects.Text;
  private autoLabel!: Phaser.GameObjects.Text;
  private potentialText!: Phaser.GameObjects.Text;
  private serverClockOffsetMs = 0;
  private accessibilityButton: HTMLButtonElement | null = null;
  private unsubs: Array<() => void> = [];
  private graph = new Phaser.Geom.Rectangle();
  private controls = new Phaser.Geom.Rectangle();
  private activityRows = 6;

  constructor() { super('CrashScene'); }

  preload() {
    this.load.image('crash-bg', background);
    this.load.image('crash-rocket', rocket);
  }

  create() {
    this.bg = this.add.image(0, 0, 'crash-bg').setOrigin(0).setAlpha(0.6);
    this.chrome = this.add.graphics();
    this.curve = this.add.graphics();
    this.multiplierText = this.label('1.00×', 54, '#FFFFFF', 900).setOrigin(0.5);
    this.phaseText = this.label('CONNECTING', 13, '#A7B0CD', 800).setOrigin(0.5);
    this.walletText = this.label('◆ 0', 15, '#FFE49B', 800);
    this.historyText = this.label('Waiting for verified history…', 12, '#BFC7DE', 700);
    this.activityText = this.label('Live players will appear here', 12, '#DDE3F2', 700);
    this.amountText = this.label(money(this.amount), 19, '#FFFFFF', 900).setOrigin(0.5);
    this.autoText = this.label(multiplier(this.autoCashoutBp), 17, '#FFFFFF', 900).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.amountLabel = this.label('BET AMOUNT', 10, '#8993AF', 800).setOrigin(0.5);
    this.autoLabel = this.label('AUTO CASHOUT', 10, '#8993AF', 800).setOrigin(0.5);
    this.potentialText = this.label('Potential payout ◆ 0', 11, '#FFE49B', 700).setOrigin(0.5);
    this.statusText = this.label('Connecting securely…', 12, '#A7B0CD', 700).setOrigin(0.5);
    this.fairnessText = this.label('Rules & fairness • commitment pending', 10, '#8993AF', 600).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.actionBg = this.add.rectangle(0, 0, 240, 58, GREEN).setInteractive({ useHandCursor: true });
    this.actionText = this.label('BET', 20, '#071B17', 900).setOrigin(0.5);
    this.rocket = this.add.image(0, 0, 'crash-rocket').setOrigin(0.5).setVisible(false);

    this.makeAdjustButton('−', () => this.setAmount(this.amount / 2));
    this.makeAdjustButton('+', () => this.setAmount(this.amount * 2));
    this.makeAdjustButton('−', () => this.setAuto(this.autoCashoutBp === undefined ? undefined : this.autoCashoutBp - 10));
    this.makeAdjustButton('+', () => this.setAuto((this.autoCashoutBp || 100) + 10));
    chips.forEach((chip) => this.makeChip(chip));
    this.actionBg.on('pointerdown', () => this.submitAction());
    this.actionBg.on('pointerover', () => this.actionBg.setScale(1.015));
    this.actionBg.on('pointerout', () => this.actionBg.setScale(1));
    this.autoText.on('pointerdown', () => this.setAuto(this.autoCashoutBp === undefined ? 200 : undefined));
    this.fairnessText.on('pointerdown', () => this.showRules());
    this.installAccessibility();

    this.unsubs.push(
      sdk.onMessage('CRASH_STATE', (message) => this.applySnapshot(message.payload.snapshot)),
      sdk.onMessage('CRASH_BET_RESULT', (message) => {
        this.pendingBet = false;
        if (!message.payload.accepted) this.flash(message.payload.message || 'Bet rejected', RED);
        this.renderState();
      }),
      sdk.onMessage('CRASH_CASHOUT_RESULT', (message) => {
        this.pendingCashout = false;
        if (!message.payload.accepted) this.flash(message.payload.message || 'Cashout rejected', RED);
        else if (message.payload.payout) this.flash(`Won ◆ ${money(message.payload.payout)}`, GREEN);
        this.renderState();
      }),
      sdk.onMessage('NETWORK_STATE', (message) => {
        this.snapshot.connected = message.payload.connected;
        this.statusText.setText(message.payload.connected ? (message.payload.synchronizing ? 'Synchronizing…' : '') : 'Reconnecting…');
      }),
      sdk.onMessage('WALLET_UPDATE', (message) => {
        this.snapshot.wallet = message.payload.balance;
        this.walletText.setText(`◆ ${money(message.payload.balance)}`);
      }),
    );
    this.scale.on('resize', this.layout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubs.forEach((dispose) => dispose());
      this.scale.off('resize', this.layout, this);
      this.accessibilityButton?.remove();
    });
    this.layout();
    sdk.requestRefresh('crash-scene-ready');
  }

  update(_time: number, delta: number) {
    const phase = this.snapshot.round?.phase;
    if (phase === 'RUNNING') {
      const startedAt = Date.parse(this.snapshot.round?.flightStartedAt || '');
      const elapsedSeconds = Number.isFinite(startedAt) ? Math.max(0, (Date.now() + this.serverClockOffsetMs - startedAt) / 1000) : 0;
      const rate = Math.max(0.001, Number(this.snapshot.round?.growthRate) || 0.09);
      const authoritativeCurve = Math.round(100 * Math.exp(rate * elapsedSeconds));
      const tickAnchor = this.snapshot.round?.multiplierBp || 100;
      this.displayedBp = Math.max(100, tickAnchor, authoritativeCurve);
      this.multiplierText.setText(multiplier(this.displayedBp));
      this.drawGraph();
    }
  }

  private label(value: string, size: number, color: string, weight: number) {
    return this.add.text(0, 0, value, { fontFamily: 'Arial, sans-serif', fontSize: `${size}px`, color, fontStyle: weight >= 800 ? 'bold' : 'normal' });
  }

  private adjustButtons: Array<{ button: Phaser.GameObjects.Rectangle; text: Phaser.GameObjects.Text; action: 'amount' | 'auto' }> = [];
  private chipButtons: Array<{ button: Phaser.GameObjects.Rectangle; text: Phaser.GameObjects.Text; amount: number }> = [];

  private makeAdjustButton(label: string, callback: () => void) {
    const button = this.add.rectangle(0, 0, 42, 38, 0x202b48).setStrokeStyle(1, 0x435070).setInteractive({ useHandCursor: true });
    const text = this.label(label, 22, '#FFFFFF', 800).setOrigin(0.5);
    button.on('pointerdown', callback);
    this.adjustButtons.push({ button, text, action: this.adjustButtons.length < 2 ? 'amount' : 'auto' });
  }

  private makeChip(amount: number) {
    const button = this.add.rectangle(0, 0, 54, 28, 0x1c2642).setStrokeStyle(1, 0x566383).setInteractive({ useHandCursor: true });
    const text = this.label(amount >= 1000 ? `${amount / 1000}K` : String(amount), 11, '#DDE3F2', 800).setOrigin(0.5);
    button.on('pointerdown', () => this.setAmount(amount));
    this.chipButtons.push({ button, text, amount });
  }

  private layout() {
    const width = this.scale.width;
    const height = this.scale.height;
    const wide = width / height > 0.82;
    const compact = height < 600 || width < 340;
    this.bg.setDisplaySize(width, height);
    const pad = Phaser.Math.Clamp(width * 0.035, compact ? 10 : 14, 28);
    const top = compact ? 62 : 78;
    if (wide) {
      const controlsW = Phaser.Math.Clamp(width * 0.31, compact ? 250 : 275, 360);
      const panelHeight = Math.max(210, height - top - (compact ? 16 : 72));
      this.graph.setTo(pad, top, width - controlsW - pad * 3, panelHeight);
      this.controls.setTo(width - controlsW - pad, top, controlsW, panelHeight);
    } else {
      const controlsH = Phaser.Math.Clamp(height * (compact ? 0.43 : 0.37), compact ? 238 : 280, compact ? 280 : 338);
      this.graph.setTo(pad, top, width - pad * 2, Math.max(128, height - top - controlsH - (compact ? 8 : 20)));
      this.controls.setTo(pad, height - controlsH - (compact ? 4 : 10), width - pad * 2, controlsH);
    }
    this.activityRows = compact ? 2 : this.controls.height < 300 ? 4 : 6;
    this.drawChrome();
    this.walletText.setPosition(pad, compact ? 10 : 20).setFontSize(compact ? 13 : 15);
    this.historyText.setPosition(pad, compact ? 36 : 50).setWordWrapWidth(width - pad * 2).setFontSize(width < 500 ? 10 : 12);
    this.multiplierText.setPosition(this.graph.centerX, this.graph.centerY - 28).setFontSize(Phaser.Math.Clamp(this.graph.width * 0.12, 38, 76));
    this.phaseText.setPosition(this.graph.centerX, this.graph.centerY + 34);
    this.statusText.setPosition(this.graph.centerX, this.graph.bottom - (compact ? 16 : 22)).setFontSize(compact ? 10 : 12);
    this.fairnessText.setPosition(this.graph.centerX, this.graph.bottom + (wide ? (compact ? -34 : 18) : compact ? -30 : -42)).setWordWrapWidth(this.graph.width - 20).setFontSize(compact ? 9 : 10);
    this.layoutControls();
    this.drawGraph();
  }

  private drawChrome() {
    this.chrome.clear();
    [this.graph, this.controls].forEach((rect) => {
      this.chrome.fillStyle(PANEL, 0.94).fillRoundedRect(rect.x, rect.y, rect.width, rect.height, 18);
      this.chrome.lineStyle(1, 0x3d496d, 0.8).strokeRoundedRect(rect.x, rect.y, rect.width, rect.height, 18);
    });
    this.chrome.lineStyle(1, 0x33405f, 0.35);
    for (let i = 1; i < 6; i += 1) {
      const y = this.graph.y + (this.graph.height * i / 6);
      this.chrome.lineBetween(this.graph.x + 16, y, this.graph.right - 16, y);
    }
  }

  private layoutControls() {
    const x = this.controls.centerX;
    const width = this.controls.width;
    const top = this.controls.y + 18;
    const compact = this.controls.height < 280;
    this.activityText.setPosition(this.controls.x + 18, top).setWordWrapWidth(width - 36).setLineSpacing(compact ? 3 : 7).setFontSize(compact ? 10 : 12);
    const amountY = this.controls.bottom - (compact ? 150 : 172);
    const autoY = this.controls.bottom - (compact ? 108 : 124);
    this.amountLabel.setPosition(x, amountY - 27);
    this.autoLabel.setPosition(x, autoY - 27);
    this.amountText.setPosition(x, amountY);
    this.autoText.setPosition(x, autoY);
    this.potentialText.setPosition(x, this.controls.bottom - (compact ? 88 : 105)).setFontSize(compact ? 10 : 11);
    const amountButtons = this.adjustButtons.filter((entry) => entry.action === 'amount');
    const autoButtons = this.adjustButtons.filter((entry) => entry.action === 'auto');
    [amountButtons, autoButtons].forEach((entries, row) => entries.forEach((entry, side) => {
      const bx = x + (side ? 1 : -1) * Math.min(104, width * 0.34);
      const by = row ? autoY : amountY;
      entry.button.setPosition(bx, by); entry.text.setPosition(bx, by);
    }));
    const chipGap = Math.min(62, (width - 36) / chips.length);
    this.chipButtons.forEach((entry, index) => {
      const bx = x + (index - 2) * chipGap;
      const by = this.controls.bottom - (compact ? 67 : 81);
      entry.button.setPosition(bx, by).setSize(Math.max(44, chipGap - 6), 28);
      entry.text.setPosition(bx, by);
    });
    this.actionBg.setPosition(x, this.controls.bottom - (compact ? 29 : 38)).setSize(width - 34, compact ? 46 : 56);
    this.actionText.setPosition(x, this.controls.bottom - (compact ? 29 : 38)).setFontSize(compact ? 17 : 20);
  }

  private drawGraph() {
    this.curve.clear();
    const progress = Phaser.Math.Clamp((this.displayedBp - 100) / 900, 0, 1);
    const startX = this.graph.x + 22;
    const startY = this.graph.bottom - Math.min(52, this.graph.height * 0.3);
    const endX = startX + (this.graph.width - 52) * Math.max(0.08, progress);
    const endY = startY - Math.max(20, this.graph.height - 110) * Math.pow(progress, 0.62);
    this.curve.lineStyle(5, this.snapshot.round?.phase === 'CRASHED' ? RED : GOLD, 1);
    const curve = new Phaser.Curves.QuadraticBezier(new Phaser.Math.Vector2(startX, startY), new Phaser.Math.Vector2(endX - 40, startY), new Phaser.Math.Vector2(endX, endY));
    curve.draw(this.curve, 40);
    const running = this.snapshot.round?.phase === 'RUNNING';
    const rocketSize = Phaser.Math.Clamp(Math.min(this.graph.width, this.graph.height) * 0.28, 42, 72);
    this.rocket.setVisible(running).setPosition(endX, endY).setDisplaySize(rocketSize, rocketSize).setRotation(-0.45);
  }

  private applySnapshot(snapshot: CrashSnapshot) {
    const previousRound = this.snapshot.round?.id;
    this.snapshot = snapshot;
    const serverTime = Date.parse(snapshot.serverTime);
    if (Number.isFinite(serverTime)) this.serverClockOffsetMs = serverTime - Date.now();
    if (snapshot.round?.id !== previousRound || snapshot.round?.phase !== 'RUNNING') {
      this.displayedBp = snapshot.round?.crashMultiplierBp || snapshot.round?.multiplierBp || 100;
    } else this.displayedBp = Math.max(this.displayedBp, snapshot.round.multiplierBp || 100);
    if (snapshot.myBet?.id && snapshot.round?.id) this.pendingBet = false;
    if (snapshot.myBet?.status && snapshot.myBet.status !== 'placed') this.pendingCashout = false;
    this.renderState();
  }

  private renderState() {
    const phase = this.snapshot.round?.phase || 'SCHEDULED';
    const action = resolveCrashAction(phase, this.snapshot.myBet);
    this.multiplierText.setText(multiplier(this.snapshot.round?.crashMultiplierBp || this.displayedBp));
    this.multiplierText.setColor(phase === 'CRASHED' ? '#FF5573' : '#FFFFFF');
    this.phaseText.setText(phase.replaceAll('_', ' '));
    this.walletText.setText(`◆ ${money(this.snapshot.wallet)}`);
    this.historyText.setText(this.snapshot.history.slice(0, 9).map((item) => multiplier(item.crashMultiplierBp)).join('   ') || 'Waiting for verified history…');
    this.activityText.setText(this.snapshot.publicActivity.slice(0, this.activityRows).map((item) => {
      const result = item.cashoutMultiplierBp ? `  ${multiplier(item.cashoutMultiplierBp)}` : `  ◆ ${money(item.amount)}`;
      return `${item.simulated ? '[SIM]' : '●'} ${item.name}${result}`;
    }).join('\n') || 'Live players will appear here');
    const commitment = this.snapshot.round?.seedCommitment;
    const reveal = this.snapshot.round?.revealedSeed;
    this.fairnessText.setText(reveal ? `Seed revealed • tap for verification details` : commitment ? `Committed: ${commitment.slice(0, 16)}… • tap for rules` : 'Rules & fairness • commitment pending');
    const labels: Record<CrashAction, string> = { BET: 'BET', WAIT: 'WAIT FOR NEXT ROUND', CANCELLED: 'REFUNDED', CASH_OUT: `CASH OUT ${multiplier(this.displayedBp)}`, CASHED_OUT: `CASHED OUT • ◆ ${money(this.snapshot.myBet?.payout || 0)}`, LOST: 'CRASHED' };
    this.actionText.setText(this.pendingBet ? 'PLACING BET…' : this.pendingCashout ? 'CASHING OUT…' : labels[action]);
    const payoutBp = action === 'CASH_OUT' ? this.displayedBp : this.autoCashoutBp;
    this.potentialText.setText(payoutBp ? `Potential payout ◆ ${money(this.amount * payoutBp / 100)}` : 'Potential payout depends on cashout');
    if (this.accessibilityButton) {
      this.accessibilityButton.textContent = this.actionText.text;
      this.accessibilityButton.disabled = !((action === 'BET' || action === 'CASH_OUT') && this.snapshot.connected);
      this.accessibilityButton.setAttribute('aria-label', `${this.actionText.text}. Bet amount ${money(this.amount)} diamonds. Auto cashout ${this.autoCashoutBp ? multiplier(this.autoCashoutBp) : 'off'}.`);
    }
    const enabled = (action === 'BET' || action === 'CASH_OUT') && !this.pendingBet && !this.pendingCashout && this.snapshot.connected;
    this.actionBg.setFillStyle(action === 'CASH_OUT' ? GOLD : action === 'BET' ? GREEN : action === 'LOST' ? RED : 0x4b5570, enabled ? 1 : 0.7);
    this.actionBg.disableInteractive();
    if (enabled) this.actionBg.setInteractive({ useHandCursor: true });
    this.drawGraph();
  }

  private submitAction() {
    const round = this.snapshot.round;
    if (!round) return;
    const action = resolveCrashAction(round.phase, this.snapshot.myBet);
    if (action === 'BET') {
      if (this.amount > this.snapshot.wallet) { this.flash('Not enough diamonds', RED); return; }
      this.pendingBet = true;
      sdk.requestCrashBet(round.id, Math.round(this.amount), this.autoCashoutBp);
    } else if (action === 'CASH_OUT' && this.snapshot.myBet) {
      this.pendingCashout = true;
      sdk.requestCashout(round.id, this.snapshot.myBet.id);
    }
    this.renderState();
  }

  private setAmount(value: number) {
    this.amount = Phaser.Math.Clamp(Math.round(value), this.snapshot.config?.minBet || 100, this.snapshot.config?.maxBet || 1000000);
    this.amountText.setText(money(this.amount));
  }

  private setAuto(value: number | undefined) {
    if (value === undefined || value < (this.snapshot.config?.minAutoCashoutBp || 110)) this.autoCashoutBp = undefined;
    else this.autoCashoutBp = Phaser.Math.Clamp(Math.round(value), this.snapshot.config?.minAutoCashoutBp || 110, this.snapshot.config?.maxAutoCashoutBp || 100000);
    this.autoText.setText(this.autoCashoutBp ? multiplier(this.autoCashoutBp) : 'OFF');
    this.renderState();
  }

  private installAccessibility() {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Crash game action';
    button.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
    button.addEventListener('click', () => this.submitAction());
    document.body.appendChild(button);
    this.accessibilityButton = button;
  }

  private showRules() {
    const shade = this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x050816, 0.9).setOrigin(0).setDepth(30).setInteractive();
    const panelHeight = Math.min(330, this.scale.height - 24);
    const panel = this.add.rectangle(this.scale.width / 2, this.scale.height / 2, Math.min(460, this.scale.width - 24), panelHeight, 0x111a34).setStrokeStyle(1, GOLD).setDepth(31);
    const copy = this.add.text(this.scale.width / 2, this.scale.height / 2,
      `CRASH RULES\n\nPlace a diamond bet only while betting is open. During flight, cash out before the authoritative crash. Auto cashout runs on the server even if you disconnect.\n\nThe server commits to a seed before flight and reveals it after settlement. This client displays that evidence but does not label it verified until an algorithm-specific verifier checks the reveal.\n\nHouse edge and limits are supplied by the server configuration. Simulated activity is marked [SIM] and never affects settlement.\n\nTap anywhere to close.`,
      { fontFamily: 'Arial', fontSize: this.scale.height < 560 ? '11px' : '13px', color: '#E9EDFA', align: 'left', lineSpacing: this.scale.height < 560 ? 2 : 5, wordWrap: { width: Math.min(410, this.scale.width - 52) } },
    ).setOrigin(0.5).setDepth(32);
    shade.once('pointerdown', () => { shade.destroy(); panel.destroy(); copy.destroy(); });
  }

  private flash(message: string, color: number) {
    const toast = this.add.text(this.scale.width / 2, 96, message, { fontFamily: 'Arial', fontSize: '15px', fontStyle: 'bold', color: '#FFFFFF', backgroundColor: `#${color.toString(16).padStart(6, '0')}`, padding: { x: 14, y: 9 } }).setOrigin(0.5).setDepth(20);
    this.tweens.add({ targets: toast, alpha: 0, y: 78, delay: 1500, duration: 300, onComplete: () => toast.destroy() });
  }
}
