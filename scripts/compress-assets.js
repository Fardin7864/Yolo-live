/*
 * One-shot asset compressor for Yolo-live.
 *
 *   node scripts/compress-assets.js
 *
 * Requires `sharp` (will prompt to install on first run if missing).
 *
 * What it does:
 *   - assets/images/card_back.png      2.4 MB -> ~250 KB  (PNG, downscaled)
 *   - assets/images/frame_vip.png      1.8 MB -> ~200 KB
 *   - assets/images/frame_vvip.png     2.1 MB -> ~250 KB
 *
 * Backups are written next to the originals as *.png.bak so you can
 * roll back if you don't like the quality.
 */

const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.error('\nsharp is not installed. Install it once with:\n');
  console.error('   npm install --save-dev sharp\n');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');

// Each entry: { file, maxWidth, quality }
// maxWidth caps the longer side; quality is PNG zlib level + palette.
const TARGETS = [
  { file: 'assets/images/card_back.png',  maxWidth: 600 },
  { file: 'assets/images/frame_vip.png',  maxWidth: 600 },
  { file: 'assets/images/frame_vvip.png', maxWidth: 600 },
];

async function compressOne({ file, maxWidth }) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.warn(`  - skip (not found): ${file}`);
    return;
  }

  const stat = fs.statSync(abs);
  const beforeKB = Math.round(stat.size / 1024);

  const backup = abs + '.bak';
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(abs, backup);
  }

  const buf = await sharp(backup)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true, quality: 80 })
    .toBuffer();

  fs.writeFileSync(abs, buf);

  const afterKB = Math.round(buf.length / 1024);
  const saved = Math.round((1 - buf.length / stat.size) * 100);
  console.log(`  ok ${file}  ${beforeKB} KB -> ${afterKB} KB  (-${saved}%)`);
}

(async () => {
  console.log('Compressing assets...\n');
  for (const t of TARGETS) {
    try {
      await compressOne(t);
    } catch (err) {
      console.error(`  fail ${t.file}: ${err.message}`);
    }
  }
  console.log('\nDone. Backups saved as *.png.bak — delete them once you confirm quality is OK.');
})();