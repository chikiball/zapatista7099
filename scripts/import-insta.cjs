'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const INSTA_DIR = path.join(ROOT, 'insta_resource');
const PHOTOS_DIR = path.join(ROOT, 'public', 'photos');
const DB_PATH = path.join(ROOT, 'api', 'alumni.db');

fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const db = new Database(DB_PATH);

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanCaption(text) {
  return (text || '')
    .replace(/\n\d+\s+years?\s+ago\s*$/im, '')
    .replace(/\n\d+\s+months?\s+ago\s*$/im, '')
    .replace(/\n\d+\s+weeks?\s+ago\s*$/im, '')
    .replace(/\n\d+\s+days?\s+ago\s*$/im, '')
    .replace(/\n\d+\s+hours?\s+ago\s*$/im, '')
    .trim();
}

function extractTitle(caption, takenAt) {
  const lines = caption.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const core = line.replace(/#\S+/g, '').replace(/@\S+/g, '').replace(/[\uD800-\uDFFF]./g, '').trim();
    if (core.length > 3) return line.substring(0, 80).trim();
  }
  const d = new Date(takenAt);
  const label = d.toLocaleString('id-ID', { month: 'long', year: 'numeric' });
  return `Instagram – ${label}`;
}

async function processImage(srcPath, destPath) {
  await sharp(srcPath)
    .resize(800, null, { withoutEnlargement: true, fit: 'inside' })
    .jpeg({ quality: 80 })
    .toFile(destPath);
}

async function extractVideoThumb(videoPath, destPath) {
  const tmpPath = destPath + '.raw.jpg';
  execSync(`ffmpeg -y -i "${videoPath}" -vframes 1 -q:v 2 "${tmpPath}"`, { stdio: 'pipe' });
  await sharp(tmpPath)
    .resize(800, null, { withoutEnlargement: true, fit: 'inside' })
    .jpeg({ quality: 80 })
    .toFile(destPath);
  fs.unlinkSync(tmpPath);
}

function copyVideo(srcPath, destPath) {
  fs.copyFileSync(srcPath, destPath);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Ensure Zapatista7099_Insta alumni record exists
  let row = db.prepare("SELECT id FROM alumni WHERE name = 'Zapatista7099_Insta'").get();
  if (!row) {
    const r = db.prepare("INSERT INTO alumni (name, is_public) VALUES ('Zapatista7099_Insta', 0)").run();
    row = { id: r.lastInsertRowid };
    console.log(`Created Zapatista7099_Insta alumni  id=${row.id}`);
  } else {
    console.log(`Found existing Zapatista7099_Insta   id=${row.id}`);
  }
  const authorId = row.id;

  // 2. Wipe all existing articles
  const del = db.prepare('DELETE FROM articles').run();
  console.log(`Deleted ${del.changes} existing articles\n`);

  // 3. Prepare insert
  const insert = db.prepare(`
    INSERT INTO articles
      (author_id, title, content, status, cover_image, published_at, created_at, updated_at)
    VALUES
      (?, ?, ?, 'published', ?, ?, ?, ?)
  `);

  // 4. Process each folder
  const folders = fs.readdirSync(INSTA_DIR)
    .filter(name => {
      try { return fs.statSync(path.join(INSTA_DIR, name)).isDirectory(); } catch { return false; }
    })
    .sort();

  console.log(`Found ${folders.length} folders to import\n`);

  let ok = 0, fail = 0;

  for (const folder of folders) {
    const dir = path.join(INSTA_DIR, folder);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
      const rawCaption = fs.readFileSync(path.join(dir, 'caption.txt'), 'utf8');
      const caption = cleanCaption(rawCaption);
      const title = extractTitle(caption, meta.taken_at);
      const ts = meta.taken_at;
      const instaUrl = meta.url;
      const slug = meta.code || folder;

      // Sorted media files
      const mediaFiles = fs.readdirSync(dir)
        .filter(f => /^media_\d+\.(webp|jpg|jpeg|mp4)$/i.test(f))
        .sort((a, b) => {
          const n = f => parseInt(f.match(/\d+/)[0]);
          return n(a) - n(b);
        });

      let coverImage = null;
      const fotoTags = [];
      const videoTags = [];

      for (let i = 0; i < mediaFiles.length; i++) {
        const file = mediaFiles[i];
        const src = path.join(dir, file);
        const ext = path.extname(file).toLowerCase();
        const base = `insta-${slug}-${i + 1}`;

        if (ext === '.mp4') {
          const thumbName = `${base}-thumb.jpg`;
          const videoName = `${base}.mp4`;
          await extractVideoThumb(src, path.join(PHOTOS_DIR, thumbName));
          copyVideo(src, path.join(PHOTOS_DIR, videoName));
          if (!coverImage) coverImage = thumbName;
          videoTags.push(`[video:${videoName}]`);
        } else {
          const imgName = `${base}.jpg`;
          await processImage(src, path.join(PHOTOS_DIR, imgName));
          if (!coverImage) coverImage = imgName;
          fotoTags.push(`[foto:${imgName}]`);
        }
      }

      const mediaPart = [...fotoTags, ...videoTags].join('\n');
      const content = `${caption}\n\n${mediaPart}\n\n---\nOriginal: ${instaUrl}`;

      insert.run(authorId, title, content, coverImage, ts, ts, ts);
      console.log(`✓  ${folder}  →  "${title}"`);
      ok++;
    } catch (err) {
      console.error(`✗  ${folder}  →  ${err.message}`);
      fail++;
    }
  }

  console.log(`\n──────────────────────────────────`);
  console.log(`Done: ${ok} imported, ${fail} failed`);
  db.close();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
