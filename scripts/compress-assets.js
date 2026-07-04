/*
 * One-shot asset compressor for Yolo-live.
 *
 *   node scripts/compress-assets.js
 *
 * Requires `sharp` (will prompt to install on first run if missing).
 *
 * What it does:
 *   - assets/images/card_back.webp     recompresses the Teen Patti card back
 *
 * Backups are written next to the originals as *.bak so you can
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

// Each entry: { file, maxWidth }
// maxWidth caps the longer side; WebP keeps the app bundle smaller than PNG.
const TARGETS = [
  { file: 'assets/images/card_back.webp', maxWidth: 600 },
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
    .webp({ quality: 78, effort: 6, smartSubsample: true })
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
  console.log('\nDone. Backups saved as *.bak — delete them once you confirm quality is OK.');
})();
