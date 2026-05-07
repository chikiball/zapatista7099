# 7099 Project Context — For AI Assistants

> Load this file at the start of a new conversation to resume work.
> Last updated: 2026-05-08

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

- **Astro v6** + **Tailwind CSS v4** (static site, 10 pages)
- **Express.js** API (`api/server.cjs` — CommonJS)
- **SQLite** via `better-sqlite3`, **D3.js** + **Canvas** globe, **Chart.js** stats
- **JWT** auth + **Google Sign-In**, **nodemailer** SMTP, **multer** + **sharp** uploads
- **Nominatim** (OpenStreetMap) for auto-geocoding — no API key needed
- **PM2**, **Node.js v22**

## Pages (10)

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
| Admin | `/admin` | Admin only |

## Key Systems

- **Auth:** JWT cookies, Google OAuth, approval system (pending/approved/rejected)
- **Admin:** Dashboard, approval queue, alumni/user management, events management, settings (SMTP + Telegram)
- **Telegram:** Bot notifies group on new registration
- **Email:** Welcome, approval, rejection, password reset, new article notification, new event notification (SMTP: dr6101.inweb.id)
- **Email notifications:** Sent to all approved users with `notify_email=1`. Each user has a unique `unsubscribe_token` for one-click opt-out via `GET /api/unsubscribe?token=xxx`. Toggle in profile page.
- **Map:** D3 orthographic globe, neon pins, dynamic clustering, starburst cards, city labels
- **Stats:** 12 sections with scroll animations, normalized jobs/industries/universities
- **Articles:** Magazine layout, masonry photo gallery, lightbox with swipe, inline image upload (sharp resize), auto-link URLs, [foto:] tag system
- **Events:** RSVP toggle, cover + inline images, [foto:] tag system, lightbox. Any approved user can create; only admin can delete; creator/admin can edit.
- **Photos:** Symlink dist/photos → public/photos (survives builds), sharp auto-resize max 800px
- **Auto-Geocoding:** When alumni saves profile or is approved by admin, city+country is sent to Nominatim to fill lat/lng automatically. Fires in background (non-blocking). Existing coords not overwritten unless city changes.

## Important Notes

- `dist/photos` is a **symlink** to `public/photos` — must be recreated after each build
- Astro escapes `<>` in `<script is:inline>` — use `document.createElement()` or `String.fromCharCode()` to build HTML tags in JS
- API file is `.cjs` (CommonJS) because Astro sets `type:module`
- `'99` in JS strings causes syntax errors — use `\x2799`
- `sendNewsletterEmail(subject, html)` is a fire-and-forget helper — appends unsubscribe footer per user automatically

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

## What's NOT Built Yet

- Memorial Page
- Photo Gallery from yearbook (243 portraits extracted, not uploaded)
- Auto-Geocoding when admin manually edits alumni city in admin panel (only fires on profile save and approval currently)
