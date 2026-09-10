import Phaser from 'phaser';

export const BOT_PROFILE_ATLAS_KEY = 'botProfileAtlas';
const ATLAS_GRID_SIZE = 5;
const ATLAS_SIZE = 500;
const CELL_SIZE = ATLAS_SIZE / ATLAS_GRID_SIZE;

export const isBotIdentity = (userId: unknown, explicitBot?: unknown) => (
  explicitBot === true || String(userId || '').startsWith('robot:')
);

export const stableBotProfileIndex = (identity: unknown) => {
  const value = String(identity || 'bot');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % (ATLAS_GRID_SIZE * ATLAS_GRID_SIZE);
};

/** Adds one deterministic, non-human scenic profile from the bundled atlas. */
export const addBotProfileAvatar = (
  scene: Phaser.Scene,
  parent: Phaser.GameObjects.Container,
  x: number,
  y: number,
  size: number,
  identity: unknown,
) => {
  const profileIndex = stableBotProfileIndex(identity);
  const column = profileIndex % ATLAS_GRID_SIZE;
  const row = Math.floor(profileIndex / ATLAS_GRID_SIZE);
  const maskShape = scene.add.graphics().fillStyle(0xffffff, 1)
    .fillCircle(x, y, Math.max(1, size / 2 - 3));
  const avatar = scene.add.image(x, y, BOT_PROFILE_ATLAS_KEY)
    .setCrop(column * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE)
    .setDisplaySize(size - 6, size - 6)
    .setMask(maskShape.createGeometryMask());
  maskShape.setVisible(false);
  parent.add([maskShape, avatar]);
  return avatar;
};
