# 7099 Project Context — For AI Assistants

> Load this file at the start of a new conversation to resume work on this project.
> Last updated: 2026-04-20

## What Is This

**7099** is an alumni website for **SMAN 70 Jakarta, Class of 1999** (Angkatan 99).
- **Live URL:** https://zapa.inweb.id
- **Domain:** zapa.inweb.id → 103.16.198.61

## Server Access

```
SSH: ssh -p 52017 zapa@103.16.198.61
Key auth: ed25519 key (user has it)
Sudo: NOPASSWD configured for user zapa
```

## Architecture

```
Browser → https://zapa.inweb.id
  → Proxmox/OpenResty (SSL termination, port 443→80)
    → Nginx on Debian 12 container (port 80)
      ├── Static: /var/www/alumni/dist/ (Astro build)
      └── /api/* → proxy_pass localhost:3000
            → Node.js Express API (PM2: alumni-api)
              → SQLite: /var/www/alumni/api/alumni.db
```

## Key Paths on Server

- **Project root:** `/var/www/alumni/`
- **Source:** `/var/www/alumni/src/`
- **API:** `/var/www/alumni/api/server.cjs`
- **Database:** `/var/www/alumni/api/alumni.db`
- **Built site:** `/var/www/alumni/dist/`
- **Nginx:** `/etc/nginx/sites-available/alumni`

## Tech Stack

- **Astro v6** (static site generator) + **Tailwind CSS v4**
- **Express.js** API server (CommonJS `.cjs` because Astro sets `"type":"module"`)
- **SQLite** via `better-sqlite3`
- **D3.js v7** + **TopoJSON v3** for globe map (Canvas rendering)
- **JWT** auth with HttpOnly cookies + **Google Sign-In** (client ID: `1035245406806-7dh06iqc9697ssos8tukbho0no2eaut5.apps.googleusercontent.com`)
- **PM2** process manager (auto-start on reboot)
- **Node.js v22** (via NodeSource)

## Database Schema

```sql
CREATE TABLE alumni (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, nickname TEXT, email TEXT, phone TEXT,
  city TEXT, country TEXT, latitude REAL, longitude REAL,
  university TEXT, degree TEXT, job_title TEXT, company TEXT, industry TEXT,
  bio TEXT, photo_url TEXT, is_public INTEGER DEFAULT 1,
  created_at TEXT, google_id TEXT,
  birthday TEXT, gender TEXT, address TEXT, hobby TEXT
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL, password_hash TEXT, google_id TEXT,
  name TEXT, alumni_id INTEGER REFERENCES alumni(id),
  role TEXT DEFAULT 'user', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE articles (id, author_id, title, content, published_at, status DEFAULT 'draft');
CREATE TABLE events (id, title, description, event_date, location, rsvp_count DEFAULT 0);
```

## Pages & Features

### `src/pages/index.astro` — Homepage
- Brown/amber theme, hero with "7099" title
- Dynamic stats from `/api/stats` (total alumni, cities, industries, countries)
- Mobile hamburger menu with JS toggle
- Cards link to `/map` and `/login`

### `src/pages/login.astro` — Auth
- Google Sign-In via `google.accounts.id.renderButton()` (client ID hardcoded)
- Email/password signup & login (toggle mode on same page)
- On signup: auto-matches alumni by email → name → nickname
- JWT stored in HttpOnly cookie, 7-day expiry
- Redirects to `/profile` on success

### `src/pages/profile.astro` — Profile Edit
- Checks auth via `/api/auth/me`
- If alumni matched: shows green banner + pre-filled form
- If no match: shows search box to find & link alumni record
- Fields: name, nickname, birthday (date), gender (select), phone, city, country, job_title, address, company, university (comma-sep), hobby (comma-sep)
- Save creates/updates alumni record

### `src/pages/map.astro` — Interactive Globe
- **D3.js orthographic globe** rendered on Canvas (not SVG — performance)
- Neon green pins (`#39ff14`) with glow effect
- Clusters: nearby alumni grouped, show count badge
- **Desktop** (`@media hover:hover`): hover over pin shows starburst cards
- **Mobile** (`!isHover`): tap pin toggles cards, tap elsewhere dismisses
- Starburst: cards radiate at equal angles, random distance, with slow drift (3s interval, 2.8s CSS transition, ±30px)
- Single-person pins show card next to pin
- City labels (Jabodetabek kotamadya) appear at zoom >8x
- Login-gated: non-logged-in users see pins but no details + "Login untuk melihat" banner
- Zoom: scroll/pinch (0.3x–80x), drag: rotate globe, double-click/tap: reset
- Uses `countries-50m.json` from CDN for detailed coastlines

### `api/server.cjs` — Express API
- Auth: signup, login, Google Sign-In, JWT middleware
- Alumni matching: email (exact) → name (exact) → nickname (partial)
- Profile: GET/PUT with create-or-update logic
- Stats: counts with DISTINCT for cities/industries/countries
- Map: returns lat/lng + name/nickname/city/country/job_title
- CORS enabled, cookie-parser for JWT

## Deploy Workflow

```bash
ssh -p 52017 zapa@103.16.198.61
cd /var/www/alumni
sudo chown -R zapa:zapa dist/ .astro/   # Fix permissions for build
npm run build                             # Astro static build
sudo chown -R www-data:www-data dist/    # Nginx needs www-data ownership
sudo systemctl reload nginx               # Serve new files
pm2 restart alumni-api                    # If API code changed
pm2 save                                  # Persist PM2 config
```

**Shortcut alias** (if configured): `deploy`

## Important Notes

- SSL handled by **Proxmox/OpenResty** reverse proxy — certbot inside container won't work
- API file is `.cjs` (not `.js`) because Astro sets `"type":"module"` in package.json
- `dist/` must be owned by `www-data` for Nginx, but `zapa` for build → chown before/after
- Globe map uses **Canvas** (not SVG) for performance with 50m country data
- Google OAuth only needs client ID (no secret) — frontend-only flow with JWT decode on server
- Alumni coordinates set via SQL UPDATE by city name (approximate lat/lng)
- New cities need manual coordinate assignment in DB

## What's NOT Built Yet

- **Directory page** — browsable/searchable alumni list
- **Statistics page** — Chart.js visualizations (career, university, city distribution)
- **Articles/Blog** — alumni can submit stories (DB table exists, no UI)
- **Events/RSVP** — reunion planning (DB table exists, no UI)
- **Photo gallery** — then vs now
- **Memorial page**
- **Admin panel** — manage users/data
- **Auto-geocoding** — new cities don't auto-get lat/lng
- **Email notifications** — welcome email, password reset
