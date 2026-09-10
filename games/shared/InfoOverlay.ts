import Phaser from 'phaser';

export function createInfoOverlay(
  scene: Phaser.Scene,
  title: string,
  lines: string[],
  options: { fullScreen?: boolean; scrollable?: boolean; largeText?: boolean } = {},
) {
  const fullScreen = options.fullScreen === true && window.__GAME_EMBEDDED__ === true;
  const viewportHeight = fullScreen ? scene.scale.height : 960;
  const panelTop = fullScreen ? 2 : 250;
  const panelHeight = fullScreen ? viewportHeight - 4 : 390;
  const contentTop = fullScreen ? 92 : 342;
  const contentBottom = fullScreen ? viewportHeight - 64 : 570;
  const shade = scene.add.rectangle(270, viewportHeight / 2, 540, viewportHeight, 0x05070d, 0.92).setInteractive();
  const panel = scene.add.graphics()
    .fillStyle(0x151925, 0.995).fillRoundedRect(fullScreen ? 2 : 58, panelTop, fullScreen ? 536 : 424, panelHeight, 10)
    .lineStyle(2, 0xffd76a, 0.9).strokeRoundedRect(fullScreen ? 2 : 58, panelTop, fullScreen ? 536 : 424, panelHeight, 10);
  const heading = scene.add.text(270, fullScreen ? 34 : 292, title, {
    fontFamily: 'Arial', fontSize: fullScreen ? '32px' : '22px', color: '#FFF0A5', fontStyle: 'bold', align: 'center',
  }).setOrigin(0.5);
  const body = scene.add.text(fullScreen ? 24 : 86, 0, lines.join('\n\n'), {
    fontFamily: 'Arial', fontSize: fullScreen || options.largeText ? '22px' : '14px', color: '#FFFFFF',
    lineSpacing: fullScreen ? 11 : 5, fixedWidth: fullScreen ? 492 : 368, wordWrap: { width: fullScreen ? 492 : 368 },
  });
  const content = scene.add.container(0, contentTop, [body]);
  const mask = scene.add.graphics().fillStyle(0xffffff).fillRect(fullScreen ? 8 : 70, contentTop, fullScreen ? 524 : 400, contentBottom - contentTop).setVisible(false);
  content.setMask(mask.createGeometryMask());
  const zone = scene.add.zone(270, (contentTop + contentBottom) / 2, fullScreen ? 516 : 390, contentBottom - contentTop).setInteractive({ useHandCursor: true });
  scene.input.setDraggable(zone);
  let dragY = 0;
  let offsetAtDrag = 0;
  let offset = 0;
  const minimumOffset = Math.min(0, contentBottom - contentTop - body.height - 12);
  zone.on('pointerdown', (pointer: Phaser.Input.Pointer) => { dragY = pointer.y; offsetAtDrag = offset; });
  zone.on('drag', (pointer: Phaser.Input.Pointer) => {
    offset = Phaser.Math.Clamp(offsetAtDrag + pointer.y - dragY, minimumOffset, 0);
    content.setY(contentTop + offset);
  });
  const close = scene.add.text(270, fullScreen ? viewportHeight - 30 : 602, 'CLOSE', {
    fontFamily: 'Arial', fontSize: fullScreen ? '20px' : '13px', color: '#17120A', fontStyle: 'bold', backgroundColor: '#FFD76A', padding: { x: 28, y: fullScreen ? 12 : 10 },
  }).setOrigin(0.5).setInteractive({ useHandCursor: true });
  const overlay = scene.add.container(0, 0, [shade, panel, heading, content, mask, zone, close])
    .setDepth(1000).setVisible(false)
    .setData('embeddedPreserveX', fullScreen).setData('embeddedFinalScale', fullScreen ? 1 : 0);
  shade.on('pointerdown', () => overlay.setVisible(false));
  close.on('pointerdown', () => overlay.setVisible(false));
  return overlay;
}
