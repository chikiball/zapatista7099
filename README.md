# 7099 — Alumni SMU 70 Angkatan 99

> Reconnecting the Class of 1999 from SMAN 70 Jakarta.

## 🌐 Live Site

**https://zapa.inweb.id**

## Features

| Feature | Status | URL |
|---------|--------|-----|
| Homepage with dynamic stats | ✅ | `/` |
| Login (Email + Google OAuth) | ✅ | `/login` |
| Profile (auto-match alumni DB, edit) | ✅ | `/profile` |
| Interactive Globe Map | ✅ | `/map` |
| Directory (browse alumni) | 🔲 | — |
| Statistics/Charts | 🔲 | — |
| Articles/Blog | 🔲 | — |
| Events/RSVP | 🔲 | — |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Astro v6 + Tailwind CSS v4 |
| Backend API | Node.js (Express) |
| Database | SQLite via `better-sqlite3` |
| Globe/Map | D3.js + Canvas + TopoJSON |
| Auth | JWT (HttpOnly cookies) + Google Sign-In |
| Process Manager | PM2 |
| Web Server | Nginx (reverse proxy) |
| SSL | Proxmox/OpenResty (host-level) |
| OS | Debian 12 (Bookworm) |

## Project Structure

```
├── src/
│   ├── layouts/Layout.astro      # Base layout with Tailwind
│   ├── pages/
│   │   ├── index.astro           # Homepage (dynamic stats, mobile menu)
│   │   ├── login.astro           # Login/signup (Google + email)
│   │   ├── profile.astro         # Profile edit with alumni matching
│   │   └── map.astro             # Interactive globe map
│   └── styles/global.css         # Tailwind imports
├── api/
│   └── server.cjs                # Express API (auth, profile, alumni, map)
├── public/                       # Static assets (favicons)
├── package.json
├── astro.config.mjs
└── tsconfig.json
```

## Server Access

```bash
ssh -p 52017 zapa@103.16.198.61
```

## Deploy

```bash
cd /var/www/alumni
sudo chown -R zapa:zapa dist/ .astro/
npm run build
sudo chown -R www-data:www-data dist/
sudo systemctl reload nginx

# If API changed:
pm2 restart alumni-api
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Health check |
| `/api/stats` | GET | No | Alumni counts (total, cities, etc.) |
| `/api/alumni` | GET | No | List all public alumni |
| `/api/map` | GET | No | Alumni locations (lat/lng) |
| `/api/auth/signup` | POST | No | Email/password signup |
| `/api/auth/login` | POST | No | Email/password login |
| `/api/auth/google` | POST | No | Google Sign-In |
| `/api/auth/me` | GET | Yes | Current user + profile |
| `/api/auth/logout` | POST | No | Clear auth cookie |
| `/api/profile` | GET/PUT | Yes | Get/update alumni profile |
| `/api/profile/link` | POST | Yes | Link user to alumni record |
| `/api/alumni/search` | GET | Yes | Search alumni by name |

## Data

- **Source:** `DatabaseAlumni.csv` (47 alumni from SMA 70, graduated 1999)
- **Database:** SQLite at `/var/www/alumni/api/alumni.db`
- **Tables:** `alumni`, `users`, `articles`, `events`
