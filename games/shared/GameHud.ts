import Phaser from 'phaser';
import type { GamePublicBet, GameRankingEntry } from './types';

const money = (value: number) => Math.round(value || 0).toLocaleString('en-US');

const textureKeyFor = (url: string) => {
  let hash = 0;
  for (let index = 0; index < url.length; index += 1) hash = ((hash << 5) - hash + url.charCodeAt(index)) | 0;
  return `avatar-${Math.abs(hash)}`;
};

function addAvatar(
  scene: Phaser.Scene,
  parent: Phaser.GameObjects.Container,
  x: number,
  y: number,
  name: string,
  avatarUrl: string | null,
  size = 32,
) {
  const frame = scene.add.graphics()
    .fillStyle(0x392856, 1).fillCircle(x, y, size / 2)
    .lineStyle(2, 0xffda72, 0.9).strokeCircle(x, y, size / 2);
  const initial = scene.add.text(x, y, (name.trim().charAt(0) || 'P').toUpperCase(), {
    fontFamily: 'Arial', fontSize: `${Math.round(size * 0.42)}px`, color: '#FFFFFF', fontStyle: 'bold',
  }).setOrigin(0.5);
  parent.add([frame, initial]);
  if (!avatarUrl || !/^https:\/\//i.test(avatarUrl)) return;

  const textureKey = textureKeyFor(avatarUrl);
  const showTexture = () => {
    if (!parent.active || !scene.textures.exists(textureKey)) return;
    const avatar = scene.add.image(x, y, textureKey).setDisplaySize(size - 4, size - 4);
    parent.add(avatar);
    parent.bringToTop(avatar);
  };
  if (scene.textures.exists(textureKey)) {
    showTexture();
    return;
  }

  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    if (!scene.textures.exists(textureKey)) scene.textures.addImage(textureKey, image);
    showTexture();
  };
  image.src = avatarUrl;
}

export interface PlayerBetFeed {
  update: (bets: GamePublicBet[]) => void;
}

export function createPlayerBetFeed(
  scene: Phaser.Scene,
  y: number,
  options: { showAmount?: boolean; showChrome?: boolean; vertical?: boolean; large?: boolean; maxEntries?: number } = {},
): PlayerBetFeed {
  const embedded = window.__GAME_EMBEDDED__ === true;
  const showAmount = options.showAmount !== false;
  const showChrome = options.showChrome !== false;
  const vertical = options.vertical === true;
  const large = options.large === true;
  if (showChrome) {
    scene.add.rectangle(270, y, embedded ? 510 : 500, embedded ? 62 : 58, 0x101522, 0.92)
      .setStrokeStyle(1, 0xe2b858, 0.55)
      .setData('embeddedPreserveX', true)
      .setData('embeddedFinalScale', embedded ? 1 : 0);
    scene.add.text(embedded ? 24 : 34, y - (embedded ? 26 : 24), 'LIVE BETS', {
      fontFamily: 'Arial', fontSize: embedded ? '11px' : '9px', color: '#DDBF7B', fontStyle: 'bold',
    }).setData('embeddedPreserveX', true).setData('embeddedFinalScale', embedded ? 1 : 0);
  }
  const content = scene.add.container(0, 0).setData('embeddedPreserveX', embedded);

  return {
    update(bets) {
      content.removeAll(true);
      const users = new Map<string, { name: string; avatarUrl: string | null; amount: number; latest: number }>();
      bets.forEach((bet) => {
        const key = bet.userId || bet.name;
        const current = users.get(key) || { name: bet.name, avatarUrl: bet.avatarUrl, amount: 0, latest: 0 };
        current.amount += Number(bet.amount) || 0;
        current.latest = Math.max(current.latest, Date.parse(bet.createdAt || '') || 0);
        current.name = bet.name || current.name;
        current.avatarUrl = bet.avatarUrl || current.avatarUrl;
        users.set(key, current);
      });
      const entries = [...users.values()].sort((a, b) => b.latest - a.latest)
        .slice(0, options.maxEntries || (embedded ? 2 : 4));
      if (!entries.length) {
        if (!showChrome) return;
        content.add(scene.add.text(embedded ? 168 : 270, y + 5, 'Waiting for the first bet', {
          fontFamily: 'Arial', fontSize: '11px', color: '#AEB3C0',
        }).setOrigin(0.5));
        return;
      }
      entries.forEach((entry, index) => {
        const x = embedded ? (vertical ? 36 : 48 + index * 150) : 88 + index * 122;
        const entryY = vertical ? y + index * 140 : y + (embedded ? 10 : 2);
        addAvatar(scene, content, x, entryY, entry.name, entry.avatarUrl, embedded ? (vertical ? 72 : 46) : large ? 42 : 32);
        if (vertical) {
          content.add(scene.add.text(x, entryY + 52, entry.name, {
            fontFamily: 'Arial', fontSize: '22px', color: '#FFFFFF', fontStyle: 'bold', fixedWidth: 94, align: 'center',
          }).setOrigin(0.5).setCrop(0, 0, 92, 28));
        } else {
          content.add(scene.add.text(x + (embedded ? 29 : 22), y + (embedded ? (showAmount ? 1 : 10) : -7), entry.name, {
            fontFamily: 'Arial', fontSize: embedded ? '15px' : large ? '13px' : '9px', color: '#FFFFFF', fontStyle: 'bold', fixedWidth: embedded ? 102 : large ? 96 : 76,
          }).setOrigin(0, 0.5).setCrop(0, 0, embedded ? 100 : 74, embedded ? 17 : 12));
        }
        if (showAmount) {
          content.add(scene.add.text(x + (embedded ? 29 : 22), vertical ? entryY + 17 : y + (embedded ? 19 : 10), money(entry.amount), {
            fontFamily: 'Arial', fontSize: embedded ? '14px' : large ? '13px' : '10px', color: '#75F0AC', fontStyle: 'bold',
          }).setOrigin(0, 0.5));
        }
      });
    },
  };
}

export interface RankingOverlay {
  container: Phaser.GameObjects.Container;
  update: (ranking: GameRankingEntry[]) => void;
  show: () => void;
}

export function createRankingOverlay(scene: Phaser.Scene, options: { largeText?: boolean; scrollable?: boolean; fullScreen?: boolean; theme?: 'blue'; onShow?: () => void; onClose?: () => void } = {}): RankingOverlay {
  const largeText = options.largeText === true;
  const blue = options.theme === 'blue';
  const fullScreen = options.fullScreen === true && window.__GAME_EMBEDDED__ === true;
  const viewportHeight = fullScreen ? scene.scale.height : 960;
  const panelTop = fullScreen ? 2 : 150;
  const panelHeight = fullScreen ? viewportHeight - 4 : 650;
  const rowsTop = fullScreen ? 112 : 246;
  const rowsBottom = fullScreen ? viewportHeight - 62 : 716;
  const rowsHeight = rowsBottom - rowsTop;
  const shade = scene.add.rectangle(270, viewportHeight / 2, 540, viewportHeight, blue ? 0x07384d : 0x05070d, blue ? 0.82 : 0.92).setInteractive();
  const panel = scene.add.graphics()
    .fillStyle(blue ? 0x08b9e8 : 0x151925, 0.995).fillRoundedRect(fullScreen ? 2 : 40, panelTop, fullScreen ? 536 : 460, panelHeight, 8)
    .lineStyle(2, blue ? 0xcdf8ff : 0xffd76a, 0.9).strokeRoundedRect(fullScreen ? 2 : 40, panelTop, fullScreen ? 536 : 460, panelHeight, 8);
  const heading = scene.add.text(270, fullScreen ? 34 : 188, blue ? "Today's Revenue Rank" : 'DAILY RANKING', {
    fontFamily: 'Arial', fontSize: fullScreen ? '32px' : largeText ? '27px' : '22px', color: blue ? '#FFFFFF' : '#FFF0A5', fontStyle: 'bold',
  }).setOrigin(0.5);
  const subtitle = scene.add.text(270, fullScreen ? 76 : 220, 'Total bet + total win • Resets at midnight', {
    fontFamily: 'Arial', fontSize: fullScreen ? '18px' : largeText ? '14px' : '11px', color: '#C8CAD5',
  }).setOrigin(0.5);
  const rows = scene.add.container(0, 0);
  let scrollOffset = 0;
  let minScrollOffset = 0;
  let scrollZone: Phaser.GameObjects.Zone | null = null;
  let maskShape: Phaser.GameObjects.Graphics | null = null;
  if (options.scrollable) {
    maskShape = scene.add.graphics().fillStyle(0xffffff, 1).fillRect(fullScreen ? 8 : 42, rowsTop, fullScreen ? 524 : 456, rowsHeight).setVisible(false);
    rows.setMask(maskShape.createGeometryMask());
    scrollZone = scene.add.zone(270, rowsTop + rowsHeight / 2, fullScreen ? 516 : 440, rowsHeight).setInteractive({ useHandCursor: true });
    scene.input.setDraggable(scrollZone);
    let dragStartY = 0;
    let offsetAtDragStart = 0;
    scrollZone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      dragStartY = pointer.y;
      offsetAtDragStart = scrollOffset;
    });
    scrollZone.on('drag', (pointer: Phaser.Input.Pointer) => {
      scrollOffset = Phaser.Math.Clamp(offsetAtDragStart + pointer.y - dragStartY, minScrollOffset, 0);
      rows.setY(scrollOffset);
    });
  }
  const close = scene.add.text(270, fullScreen ? viewportHeight - 30 : 760, 'CLOSE', {
    fontFamily: 'Arial', fontSize: fullScreen ? '20px' : '13px', color: '#17120A', fontStyle: 'bold',
    backgroundColor: '#FFD76A', padding: { x: fullScreen ? 34 : 22, y: fullScreen ? 12 : 10 },
  }).setOrigin(0.5).setInteractive({ useHandCursor: true });
  const container = scene.add.container(0, 0, [
    shade, panel, heading, subtitle, rows, ...(maskShape ? [maskShape] : []), ...(scrollZone ? [scrollZone] : []), close,
  ])
    .setDepth(1000).setVisible(false)
    .setData('embeddedPreserveX', fullScreen).setData('embeddedFinalScale', fullScreen ? 1 : 0);
  const hide = () => { container.setVisible(false); options.onClose?.(); };
  shade.on('pointerdown', hide);
  close.on('pointerdown', hide);

  return {
    container,
    show: () => {
      options.onShow?.();
      container.setVisible(true);
      container.setDepth(100000);
      container.parentContainer?.bringToTop(container);
      scene.children.bringToTop(container);
    },
    update(ranking) {
      rows.removeAll(true);
      scrollOffset = 0;
      rows.setY(0);
      if (!ranking.length) {
        rows.add(scene.add.text(270, fullScreen ? rowsTop + 60 : 420, 'No ranking activity yet today', {
          fontFamily: 'Arial', fontSize: fullScreen ? '22px' : '14px', color: '#C8CAD5',
        }).setOrigin(0.5));
        return;
      }
      ranking.slice(0, 10).forEach((entry, index) => {
        const rowHeight = fullScreen ? 76 : largeText ? 52 : 45;
        const y = (fullScreen ? rowsTop + 38 : 270) + index * rowHeight;
        rows.add(scene.add.text(68, y, `${index + 1}`, {
          fontFamily: 'Arial', fontSize: fullScreen ? '24px' : largeText ? '17px' : '14px', color: index < 3 ? '#FFE171' : '#BFC2CF', fontStyle: 'bold',
        }).setOrigin(0.5));
        addAvatar(scene, rows, 112, y, entry.name, entry.avatarUrl, fullScreen ? 54 : 32);
        rows.add(scene.add.text(128, y - 7, entry.name, {
          fontFamily: 'Arial', fontSize: fullScreen ? '22px' : largeText ? '15px' : '11px', color: '#FFFFFF', fontStyle: 'bold', fixedWidth: fullScreen ? 250 : 160,
        }).setOrigin(0, 0.5).setCrop(0, 0, fullScreen ? 246 : 158, fullScreen ? 28 : largeText ? 20 : 14));
        rows.add(scene.add.text(128, y + (fullScreen ? 22 : 10), `Bet ${money(entry.totalBet)}  Win ${money(entry.totalWin)}`, {
          fontFamily: 'Arial', fontSize: fullScreen ? '17px' : largeText ? '12px' : '9px', color: '#AEB3C0',
        }).setOrigin(0, 0.5));
        rows.add(scene.add.text(472, y, money(entry.score), {
          fontFamily: 'Arial', fontSize: fullScreen ? '21px' : largeText ? '15px' : '12px', color: '#75F0AC', fontStyle: 'bold',
        }).setOrigin(1, 0.5));
      });
      const rowHeight = fullScreen ? 76 : largeText ? 52 : 45;
      minScrollOffset = Math.min(0, rowsHeight - ranking.slice(0, 10).length * rowHeight - 12);
    },
  };
}
