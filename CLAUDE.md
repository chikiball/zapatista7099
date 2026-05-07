# 7099 Project Context — For AI Assistants

> Load this file at the start of a new conversation to resume work.
> Last updated: 2026-04-27

## What Is This

**7099** is an alumni website for **SMAN 70 Jakarta, Class of 1999**.
- **Live URL:** https://zapa.inweb.id
- **Server:** ssh -p 52017 zapa@103.16.198.61 (ed25519 key auth)

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

- **Astro v6** + **Tailwind CSS v4** (static site, 9 pages)
- **Express.js** API (`api/server.cjs` — CommonJS)
- **SQLite** via `better-sqlite3`, **D3.js** + **Canvas** globe, **Chart.js** stats
- **JWT** auth + **Google Sign-In**, **nodemailer** SMTP, **multer** + **sharp** uploads
- **PM2**, **Node.js v22**

## Pages (9)

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
| Admin | `/admin` | Admin only |

## Key Systems

- **Auth:** JWT cookies, Google OAuth, approval system (pending/approved/rejected)
- **Admin:** Dashboard, approval queue with unlink button, alumni/user management, settings
- **Telegram:** Bot notifies group on new registration
- **Email:** Welcome, approval, rejection, password reset (SMTP: dr6101.inweb.id)
- **Map:** D3 orthographic globe, neon pins, dynamic clustering, starburst cards, city labels
- **Stats:** 12 sections with scroll animations, normalized jobs/industries/universities
- **Articles:** Magazine layout, masonry photo gallery, lightbox with swipe, inline image upload (sharp resize), auto-link URLs, [foto:] tag system
- **Photos:** Symlink dist/photos → public/photos (survives builds), sharp auto-resize max 800px

## Important Notes

- `dist/photos` is a **symlink** to `public/photos` — must be recreated after each build
- Astro escapes `<>` in `<script is:inline>` — use `document.createElement()` or `String.fromCharCode()` to build HTML tags in JS
- API file is `.cjs` (CommonJS) because Astro sets `type:module`
- `'99` in JS strings causes syntax errors — use `\x2799`

## Deploy

```bash
ssh -p 52017 zapa@103.16.198.61
cd /var/www/alumni
sudo chown -R zapa:zapa dist/ .astro/
npm run build
sudo chown -R www-data:www-data dist/
sudo rm -rf dist/photos && sudo ln -sf /var/www/alumni/public/photos dist/photos
sudo systemctl reload nginx
pm2 restart alumni-api  # if API changed
```

## What's NOT Built Yet

- Events/RSVP (DB table exists, no UI)
- Photo Gallery from yearbook (243 portraits extracted, not uploaded)
- Memorial Page
- Auto-Geocoding for new cities
