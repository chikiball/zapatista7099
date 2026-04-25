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

- **Astro v6** + **Tailwind CSS v4** (static site, 9 pages)
- **Express.js** API (`api/server.cjs` — CommonJS)
- **SQLite** via `better-sqlite3`
- **D3.js v7** + **TopoJSON** + **Canvas** for globe map
- **Chart.js** for statistics
- **JWT** auth (HttpOnly cookies) + **Google Sign-In**
- **nodemailer** for SMTP emails
- **multer** for file uploads + **sharp** for image resizing
- **PM2** process manager, **Node.js v22**

## Database Schema

```sql
CREATE TABLE alumni (id, name, nickname, email, phone, city, country,
  latitude, longitude, university, degree, job_title, company, industry,
  bio, photo_url, is_public, created_at, google_id,
  birthday, gender, address, hobby, class);

CREATE TABLE users (id, email, password_hash, google_id, name,
  alumni_id REFERENCES alumni(id), role DEFAULT 'user',
  status DEFAULT 'pending', reset_token, reset_expires, created_at);

CREATE TABLE photos (id, alumni_id, filename, original_name, created_at);
CREATE TABLE articles (id, author_id, title, content, cover_image,
  published_at, status DEFAULT 'draft', created_at, updated_at);
CREATE TABLE events (id, title, description, event_date, location, rsvp_count);
CREATE TABLE config (key PRIMARY KEY, value); -- telegram + smtp settings
```

## Pages (9 total)

| Page | URL | Auth | Description |
|------|-----|------|-------------|
| Homepage | `/` | Public | Hero with Zapa logo, dynamic stats, feature cards, mobile menu |
| Login | `/login` | Public | Google + email signup/login, forgot password link |
| Reset | `/reset` | Public | Password reset form (token from email) |
| Profile | `/profile` | Approved | Edit all fields, photo upload, class dropdown |
| Map | `/map` | Public (details: approved) | D3 canvas globe, neon pins, starburst cards, dynamic clustering |
| Stats | `/stats` | Public | 12 chart sections, scroll animations, Chart.js |
| Directory | `/directory` | Approved | Searchable card grid, filter by class/city |
| Articles | `/articles` | Public (write: approved) | Article list, read, write/edit with inline image upload |
| Admin | `/admin` | Admin only | Dashboard, approval queue, alumni/user management, settings |

## Auth & Approval System

- **3 middlewares:** `authMiddleware`, `approvedMiddleware`, `adminMiddleware`
- **Signup flow:** New user → status='pending' → admin approves → status='approved'
- **Admin account:** bengek70@gmail.com
- **Google OAuth Client ID:** 1035245406806-...

## Notifications

- **Telegram:** Bot notifies group on new registration. Token + chat_id in config table.
- **Email (SMTP):** dr6101.inweb.id:587, zapa@inweb.id. Welcome, approval, rejection, password reset emails.
- Both configurable in admin Settings tab with test buttons.

## Articles System

- 36 articles imported from Instagram (@zapatista7099)
- Public can read published articles
- Approved users can write/edit own articles
- Inline image upload with auto-resize (sharp, max 800px, JPEG 80%)
- Cover image upload with auto-resize
- `[foto: /photos/xxx.jpg]` syntax in content renders as inline images
- Author or admin can edit/delete any article

## Key Features

- **Globe Map:** D3 orthographic canvas, neon green pins, dynamic clustering, starburst cards with drift, touch/hover separation via @media(hover:hover)
- **Statistics:** IPA vs IPS, class ranking, zodiac, birthdays, city/job/university bars, hobby cloud, progress ring, scroll animations
- **Directory:** Login-gated searchable card grid with class/city filters
- **Profile:** Auto-match alumni on signup, all fields including class/photo/university
- **Branding:** Zapa logos (nav + hero), brown/#b39c82 gradient theme

## Deploy

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

- Events/RSVP (DB table exists, no UI)
- Photo Gallery (photos only on individual profiles)
- Memorial Page
- Auto-Geocoding for new cities
- Admin CSV import, merge duplicates, normalize cities
- Pending user banner on pages
- WhatsApp integration
