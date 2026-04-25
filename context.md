# 7099 Project Context — For AI Assistants

> Load this file at the start of a new conversation to resume work.
> Last updated: 2026-04-25

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
      └── /api/* → proxy_pass localhost:3000
            → Node.js Express API (PM2: alumni-api)
              → SQLite: /var/www/alumni/api/alumni.db
```

## Tech Stack

- **Astro v6** + **Tailwind CSS v4** (static site)
- **Express.js** API (`api/server.cjs` — CommonJS because Astro sets type:module)
- **SQLite** via `better-sqlite3`
- **D3.js v7** + **TopoJSON** + **Canvas** for globe map
- **Chart.js** for statistics
- **JWT** auth (HttpOnly cookies) + **Google Sign-In**
- **nodemailer** for SMTP emails
- **multer** for photo uploads
- **PM2** process manager, **Node.js v22**

## Database Schema

```sql
-- 210 alumni records
CREATE TABLE alumni (id, name, nickname, email, phone, city, country,
  latitude, longitude, university, degree, job_title, company, industry,
  bio, photo_url, is_public, created_at, google_id,
  birthday, gender, address, hobby, class);

-- Users with approval system
CREATE TABLE users (id, email, password_hash, google_id, name,
  alumni_id REFERENCES alumni(id), role DEFAULT 'user',
  status DEFAULT 'pending', -- pending|approved|rejected
  reset_token, reset_expires, created_at);

CREATE TABLE photos (id, alumni_id, filename, original_name, created_at);
CREATE TABLE articles (id, author_id, title, content, published_at, status DEFAULT 'draft');
CREATE TABLE events (id, title, description, event_date, location, rsvp_count);
CREATE TABLE config (key PRIMARY KEY, value); -- telegram + smtp settings
```

## Pages (8 total)

| Page | URL | Auth | Description |
|------|-----|------|-------------|
| Homepage | `/` | Public | Hero with Zapa logo, dynamic stats, feature cards, mobile menu |
| Login | `/login` | Public | Google + email signup/login, forgot password link |
| Reset | `/reset` | Public | Password reset form (token from email) |
| Profile | `/profile` | Approved | Edit all fields, photo upload, class dropdown |
| Map | `/map` | Public (details: approved) | D3 canvas globe, neon pins, starburst cards, dynamic clustering |
| Stats | `/stats` | Public | 12 chart sections, scroll animations, Chart.js |
| Directory | `/directory` | Approved | Searchable card grid, filter by class/city |
| Admin | `/admin` | Admin only | Dashboard, approval queue, alumni/user management, settings |

## Auth System

- **3 middlewares:** `authMiddleware` (JWT valid), `approvedMiddleware` (status=approved), `adminMiddleware` (role=admin)
- **Signup flow:** New user → status='pending' → admin approves → status='approved'
- **Protected by approvedMiddleware:** directory, profile edit, photo upload, alumni search, profile link
- **Admin account:** bengek70@gmail.com (role=admin, status=approved)

## Notifications

- **Telegram:** Bot sends to group on new registration. Config in DB (token + chat_id).
- **Email (SMTP):** Welcome on signup, approval/rejection from admin, password reset. SMTP: dr6101.inweb.id:587, zapa@inweb.id
- Both configurable in admin Settings tab

## Map Features

- D3 orthographic globe on Canvas (not SVG)
- Neon green pins (#39ff14) with glow
- Dynamic clustering: threshold = 2.0/zoom, splits on zoom in
- Starburst cards: random radii, 3s drift interval, 2.8s CSS transition, z-index shuffle
- Desktop: hover to show (@media hover:hover), Mobile: tap to toggle
- Touch guard (500ms) blocks synthetic mouse events after touch
- City labels at zoom >8x (Jabodetabek)
- Login-gated: non-approved see pins but no details

## Stats Features

- /api/stats/detail returns all aggregated data
- Job normalization (Swasta, PNS, etc), Industry normalization, University normalization (UI, ITB, UGM)
- Scroll-triggered animations via IntersectionObserver
- Hero counters animate immediately, bars animate on scroll with staggered delay

## Deploy Workflow

```bash
ssh -p 52017 zapa@103.16.198.61
cd /var/www/alumni
sudo chown -R zapa:zapa dist/ .astro/
npm run build
sudo chown -R www-data:www-data dist/
sudo systemctl reload nginx
pm2 restart alumni-api  # if API changed
```

## What's NOT Built Yet

- Articles/Blog (DB table exists, no UI)
- Events/RSVP (DB table exists, no UI)
- Photo Gallery (photos only on individual profiles)
- Memorial Page
- Auto-Geocoding for new cities
- Admin CSV import, merge duplicates, normalize cities
- Pending user banner on pages
- WhatsApp integration
- In-app notifications
