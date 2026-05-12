# 7099 Project Context — For AI Assistants

> Load this file at the start of a new conversation to resume work.
> Last updated: 2026-05-12

## What Is This

**7099** is an alumni website for **SMAN 70 Jakarta, Class of 1999**.
- **Live URL:** https://zapa.inweb.id
- **Server:** ssh -i /path/to/zapa7099_key -p 52017 zapa@103.16.198.61 (ed25519 key auth)

## Architecture

```
Browser → https://zapa.inweb.id
  → Proxmox/OpenResty (SSL, port 443→80)
    → Nginx on Debian 12 (port 80)
      ├── Static: /var/www/alumni/dist/ (Astro build)
      ├── /photos/ → symlink to /var/www/alumni/public/photos/
      └── /api/* → proxy_pass localhost:3000
            → Node.js Express API (PM2: alumni-api)
              → SQLite: /var/www/alumni/api/alumni.db
```

## Tech Stack

- **Astro v6** + **Tailwind CSS v4** (static site, 13 pages)
- **Express.js** API (`api/server.cjs` — CommonJS)
- **SQLite** via `better-sqlite3`, **D3.js** + **Canvas** globe, **Chart.js** stats
- **JWT** auth + **Google Sign-In**, **nodemailer** SMTP, **multer** + **sharp** uploads
- **Nominatim** (OpenStreetMap) for auto-geocoding — no API key needed
- **PM2**, **Node.js v22**
- **PWA:** `public/manifest.json` + icons (icon-192.png, icon-512.png, icon-180.png)
- **Fonts:** Google Fonts `Caveat` loaded globally via Layout.astro (used for du-du handwritten feel)

## Pages (13)

| Page | URL | Auth |
|------|-----|------|
| Homepage | `/` | Public |
| Login | `/login` | Public |
| Reset | `/reset` | Public |
| Profile | `/profile` | Approved |
| Map | `/map` | Public (details: approved) |
| Stats | `/stats` | Public |
| Directory | `/directory` | Approved |
| Articles | `/articles` | Public (write: approved) |
| Events | `/events` | Public (create/RSVP: approved) |
| Gallery | `/gallery` | Public (upload: approved, layout/delete: admin) |
| Forum | `/forum` | Public (post: approved, mod: admin) |
| Du-Du Wall | `/dudu` | Public (post: approved, delete: owner/admin) |
| Admin | `/admin` | Admin only |

## Key Systems

- **Auth:** JWT cookies, Google OAuth, approval system (pending/approved/rejected)
- **Admin:** Dashboard, approval queue, alumni/user management, events management, articles management, settings (SMTP + Telegram)
- **Telegram:** Bot notifies group on new registration
- **Email:** Welcome, approval, rejection, password reset, new article/event notifications, forum reply/mention notifications, du-du mention notifications (SMTP: dr6101.inweb.id)
- **Email notifications:** Broadcast to all approved users with `notify_email=1` via `sendNewsletterEmail()`. One-click unsubscribe via `GET /api/unsubscribe?token=xxx`. Toggle in profile page.
- **Map:** D3 orthographic globe, neon pins, dynamic clustering, starburst cards, city labels
- **Stats:** 12 sections with scroll animations, normalized jobs/industries/universities
- **Articles:** Magazine layout, masonry photo gallery, lightbox with swipe, inline image/video upload (sharp resize), auto-link URLs, `[foto:]` and `[video:]` tag system. 95 Instagram posts imported as articles under author "Zapatista7099_Insta".
- **Events:** RSVP toggle, cover + inline images, `[foto:]` tag system, lightbox. Any approved user can create; only admin can delete; creator/admin can edit. Date tapping downloads `.ics`. Location links to Google Maps.
- **Gallery:** Folder-based photo gallery. 6 display modes: Polaroid, Magazine Editorial, Filmstrip, Feed, Slideshow, Yearbook. Layout stored per folder (admin sets it). Upload: any approved user. Delete: admin only. Seeded: "Yearbook" (239 portraits) + "Instagram Archive" (129 photos).
- **Forum:** Category-based discussion board. 5 categories + 2 sticky how-to posts pre-seeded. Threads + replies + 5 emoji reactions. `@mention` notifications (email to mentioned alumni). Reply notifications (email to thread author). Admin: pin/lock/delete threads and replies.
- **Du-Du Wall:** Nostalgic "dari-untuk" (from-to) messaging wall à la 1999 school mading. Short notes (60/60/280 char) with 3 fixed fields: Dari, Untuk, Pesan. 7 rotating pastel colors, rotated notes, Caveat handwritten font. `@nickname` autocomplete dropdown on Untuk + Pesan (keyboard nav + click). Email notifications to `@mentioned` alumni. 5 emoji reactions. Shuffle button. JS masonry (flex columns with shortest-column placement) for clean wrapping at any viewport. Delete: owner + admin.
- **Photos:** Symlink dist/photos → public/photos (survives builds), sharp auto-resize max 800px
- **Auto-Geocoding:** When alumni saves profile or is approved by admin, city+country is sent to Nominatim to fill lat/lng automatically. Fires in background (non-blocking). Existing coords not overwritten unless city changes.
- **PWA:** `public/manifest.json` declares app name "Zapatista 7099", standalone display, amber theme. Icons: icon-512.png, icon-192.png, icon-180.png (from zapa_icon_2.png). All iOS/Android meta tags in Layout.astro.
- **Homepage feature grid:** 5 button cards (Map, Stats, Articles, Gallery, Forum) in responsive grid (2 mobile / 3 tablet / 5 desktop). Each uses a PNG icon + short Indonesian description.
- **Floating du-du bubble:** Comic-book speech bubble SVG fixed in bottom-right of homepage, rotated -8°, Caveat font, "du / du" text, links to `/dudu`.

## Important Notes

- `dist/photos` is a **symlink** to `public/photos` — must be recreated after each build
- Astro escapes `<>` in `<script is:inline>` — use `document.createElement()` or `String.fromCharCode()` to build HTML tags in JS
- API file is `.cjs` (CommonJS) because Astro sets `type:module`
- `'99` in JS strings causes syntax errors — use `\x2799`
- `sendNewsletterEmail(subject, html)` is a fire-and-forget broadcast helper — appends unsubscribe footer per user
- `sendEmail(to, subject, html)` is a direct targeted email helper (used by forum/du-du notifications, password reset, etc.)
- `emailTemplate(title, body, btnText, btnUrl)` returns a styled HTML email string
- `getMentionedEmails(body, excludeAlumniId)` — helper that parses `@nickname` and returns emails for notification
- Gallery layout toggle is **admin-only**; layout is stored in `gallery_folders.default_layout`
- `[video:FILENAME]` tag in articles renders as HTML5 `<video controls>` player inline
- Forum deep-links: `/forum?thread=X`, `/forum?category=X`
- Caveat web font loaded from Google Fonts in Layout.astro for consistent cursive rendering across devices (iOS/Android/desktop)
- Du-Du wall uses **JS-driven flex-column masonry** — each card is appended to the currently shortest column. Do NOT use CSS `columns:` with rotated cards — `break-inside: avoid` is unreliable with transforms.

## Deploy

```bash
ssh -i /path/to/zapa7099_key -p 52017 zapa@103.16.198.61
cd /var/www/alumni
sudo chown -R zapa:zapa dist/ .astro/
npm run build
sudo chown -R www-data:www-data dist/
sudo rm -rf dist/photos && sudo ln -sf /var/www/alumni/public/photos dist/photos
sudo systemctl reload nginx
pm2 restart alumni-api  # if API changed
```

## One-Time Scripts (in scripts/)

| Script | Purpose |
|--------|---------|
| `import-insta.cjs` | Import 95 Instagram folders → articles (run on server, requires ffmpeg) |
| `seed-gallery.cjs` | Seed Yearbook + Instagram Archive gallery folders (run on server) |

## What's NOT Built Yet

- Memorial Page
- Auto-Geocoding when admin manually edits alumni city in admin panel (only fires on profile save and approval currently)
