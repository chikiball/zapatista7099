'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'api', 'alumni.db');
const PHOTOS_DIR = path.join(ROOT, 'public', 'photos');
const YEARBOOK_DIR = path.join(ROOT, 'yearbook_portraits');

const db = new Database(DB_PATH);
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

async function main() {
  // ── Yearbook folder ───────────────────────────────────────────────────────

  let yb = db.prepare("SELECT id FROM gallery_folders WHERE name = 'Yearbook'").get();
  if (yb) {
    console.log('Yearbook folder already exists, skipping.');
  } else {
    const res = db.prepare("INSERT INTO gallery_folders (name, description) VALUES (?, ?)").run(
      'Yearbook',
      'Foto yearbook SMAN 70 Jakarta Angkatan 1999'
    );
    yb = { id: res.lastInsertRowid };
    console.log(`Created Yearbook folder  id=${yb.id}`);

    const portraits = fs.readdirSync(YEARBOOK_DIR)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort();

    console.log(`Processing ${portraits.length} yearbook portraits...`);
    const insert = db.prepare("INSERT INTO gallery_photos (folder_id, filename) VALUES (?, ?)");
    let ok = 0, fail = 0;

    for (const file of portraits) {
      try {
        const src = path.join(YEARBOOK_DIR, file);
        const outName = 'yearbook-' + file.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.(jpg|jpeg|png|webp)$/i, '.jpg');
        const outPath = path.join(PHOTOS_DIR, outName);
        if (!fs.existsSync(outPath)) {
          await sharp(src)
            .resize(800, null, { withoutEnlargement: true, fit: 'inside' })
            .jpeg({ quality: 85 })
            .toFile(outPath);
        }
        insert.run(yb.id, outName);
        ok++;
      } catch (e) {
        console.error(`  ✗ ${file}: ${e.message}`);
        fail++;
      }
    }
    console.log(`  Yearbook: ${ok} imported, ${fail} failed`);
  }

  // ── Instagram Archive folder ───────────────────────────────────────────────

  let insta = db.prepare("SELECT id FROM gallery_folders WHERE name = 'Instagram Archive'").get();
  if (insta) {
    console.log('Instagram Archive folder already exists, skipping.');
  } else {
    const res = db.prepare("INSERT INTO gallery_folders (name, description) VALUES (?, ?)").run(
      'Instagram Archive',
      'Foto dan media dari akun Instagram @zapatista7099'
    );
    insta = { id: res.lastInsertRowid };
    console.log(`Created Instagram Archive folder  id=${insta.id}`);

    // Only reference jpg images (not thumbnails or videos) that came from the insta import
    const instaFiles = fs.readdirSync(PHOTOS_DIR)
      .filter(f => /^insta-/.test(f) && /\.jpg$/.test(f) && !/-thumb\.jpg$/.test(f))
      .sort();

    console.log(`Referencing ${instaFiles.length} Instagram images...`);
    const insert = db.prepare("INSERT INTO gallery_photos (folder_id, filename) VALUES (?, ?)");
    instaFiles.forEach(f => insert.run(insta.id, f));
    console.log(`  Instagram Archive: ${instaFiles.length} photos added`);
  }

  console.log('\nSeed complete.');
  db.close();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
