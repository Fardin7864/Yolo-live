import type Phaser from 'phaser';

export type EmbeddedAssets = Record<string, string>;

export function loadEmbeddedAssets(scene: Phaser.Scene, assets: EmbeddedAssets) {
  Object.entries(assets).forEach(([key, uri]) => scene.load.image(key, uri));
}
