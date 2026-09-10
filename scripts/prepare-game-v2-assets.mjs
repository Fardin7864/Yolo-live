import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();

async function resize(source, destination, width, height, options = {}) {
  const output = path.join(root, destination);
  await fs.mkdir(path.dirname(output), { recursive: true });
  let pipeline = sharp(path.join(root, source));
  if (options.trim) pipeline = pipeline.trim({ background: { r: 255, g: 255, b: 255, alpha: 0 } });
  await pipeline
    .resize(width, height, { fit: options.fit || 'inside', withoutEnlargement: true })
    .webp({ quality: options.quality || 78, alphaQuality: 90, effort: 5 })
    .toFile(output);
}

await resize('assets/games/greedy-lion/background.webp', 'games/greedy-lion/assets/background.webp', 540, 960, { fit: 'cover', quality: 72 });
await resize('assets/games/greedy-lion/wheel.webp', 'games/greedy-lion/assets/wheel.webp', 460, 500, { quality: 76 });
await resize('assets/games/greedy-lion/crowned-lion.png', 'games/greedy-lion/assets/crowned-lion.webp', 100, 100, { quality: 88 });
for (const name of ['corn', 'chicken', 'shrimp', 'tomato', 'ham', 'pepper', 'fish', 'carrot', 'pizza-food', 'salad-food']) {
  await resize(`assets/games/greedy-lion/${name}.webp`, `games/greedy-lion/assets/${name}.webp`, 144, 144, { quality: 80 });
}

await resize('assets/games/greedy-pro/reference/wheel_disc.webp', 'games/greedy-pro/assets/wheel-disc.webp', 430, 430, { quality: 82, trim: true });
await resize('assets/games/greedy-pro/reference/wheel_stand.webp', 'games/greedy-pro/assets/wheel-stand.webp', 500, 270, { quality: 82, trim: true });
await resize('assets/games/greedy-pro/reference/game_result.webp', 'games/greedy-pro/assets/game-result.webp', 390, 190, { quality: 84, trim: true });
await resize('assets/games/greedy-pro/reference/game_win.webp', 'games/greedy-pro/assets/game-win.webp', 360, 520, { quality: 84, trim: true });
await resize('assets/games/greedy-pro/reference/king.webp', 'games/greedy-pro/assets/center-lion.webp', 180, 180, { quality: 88, trim: true });
await resize('assets/games/greedy-pro/reference/king.webp', 'assets/games/greedy-pro/icon.webp', 512, 512, { quality: 90, trim: true });
for (const name of ['corn', 'chicken', 'shrimp', 'tomato', 'ham', 'pepper', 'fish', 'carrot']) {
  await resize(`assets/games/greedy-pro/reference/item_${name}.webp`, `games/greedy-pro/assets/${name}.webp`, 112, 112, { quality: 84, trim: true });
}
await resize('assets/games/greedy-pro/reference/plate_pizza.webp', 'games/greedy-pro/assets/pizza-food.webp', 170, 125, { quality: 84, trim: true });
await resize('assets/games/greedy-pro/reference/plate_salad.webp', 'games/greedy-pro/assets/salad-food.webp', 170, 125, { quality: 84, trim: true });

await resize('assets/games/tin-patti-pro/background_poster.png', 'games/teen-patti/assets/background.webp', 540, 960, { fit: 'cover', quality: 70 });
for (const suit of ['club', 'diamond', 'heart', 'spade']) {
  await resize(`assets/games/tin-patti-pro/card_${suit}.webp`, `games/teen-patti/assets/${suit}.webp`, 48, 48, { quality: 82 });
}
for (const color of ['red', 'blue', 'green']) {
  await resize(`assets/games/tin-patti-pro/chair_${color}.webp`, `games/teen-patti/assets/chair-${color}.webp`, 100, 100, { quality: 88 });
}
for (const amount of ['1k', '5k', '50k', '100k']) {
  await resize(`assets/games/shared-chips/chip_${amount}.webp`, `games/shared/assets/chip_${amount}.webp`, 72, 72, { quality: 80 });
}
