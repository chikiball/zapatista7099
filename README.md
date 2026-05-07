# 7099 — Alumni SMU 70 Angkatan 99

> Reconnecting the Class of 1999 from SMAN 70 Jakarta.

## 🌐 Live Site

**https://zapa.inweb.id**

## Features

| Feature | Status | URL |
|---------|--------|-----|
| Homepage with dynamic stats | ✅ | `/` |
| Login (Email + Google OAuth) | ✅ | `/login` |
| Password Reset | ✅ | `/reset` |
| Profile (auto-match alumni DB, edit, photo upload) | ✅ | `/profile` |
| Interactive Globe Map | ✅ | `/map` |
| Directory (browse alumni, login-gated) | ✅ | `/directory` |
| Statistics / Charts | ✅ | `/stats` |
| Articles / Blog (cover + inline images, lightbox) | ✅ | `/articles` |
| Events (RSVP, images, .ics calendar, maps link) | ✅ | `/events` |
| Admin Panel (approval queue, alumni/user mgmt, settings) | ✅ | `/admin` |
| Email Notifications (new article/event, unsubscribe) | ✅ | — |
| Auto-Geocoding (city → lat/lng via Nominatim) | ✅ | — |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Astro v6 + Tailwind CSS v4 |
| Backend API | Node.js Express (`api/server.cjs`) |
| Database | SQLite via `better-sqlite3` |
| Globe/Map | D3.js + Canvas + TopoJSON |
| Auth | JWT (HttpOnly cookies) + Google Sign-In |
| Image Processing | sharp (resize to 800px, JPEG 80%) |
| Email | nodemailer (SMTP via config table) |
| Geocoding | Nominatim / OpenStreetMap (no API key) |
| Process Manager | PM2 |
| Web Server | Nginx (reverse proxy) |
| SSL | Proxmox/OpenResty (host-level) |
| OS | Debian 12 (Bookworm), Node.js v22 |

## Project Structure

```
├── src/pages/
│   ├── index.astro        # Homepage
│   ├── login.astro        # Login / signup (Google + email)
│   ├── reset.astro        # Password reset
│   ├── profile.astro      # Profile edit, photo upload, notification toggle
│   ├── map.astro          # Interactive D3 globe map
│   ├── directory.astro    # Alumni directory (approved users)
│   ├── stats.astro        # Statistics and charts
│   ├── articles.astro     # Blog (cover image, inline [foto:] tags, lightbox)
│   ├── events.astro       # Events (RSVP, cover + inline images)
│   └── admin.astro        # Admin panel (tabs: dash, pending, alumni, users, events, settings)
├── api/
│   └── server.cjs         # Express API (CommonJS — Astro sets type:module)
├── public/
│   └── photos/            # Uploaded images (symlinked from dist/photos)
├── package.json
└── astro.config.mjs
```

## Server Access

```bash
ssh -i /path/to/zapa7099_key -p 52017 zapa@103.16.198.61
```

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

> **Note:** `dist/photos` must be recreated as a symlink after every build — the build wipes it.

## API Endpoints

### Auth
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/signup` | POST | No | Email/password signup |
| `/api/auth/login` | POST | No | Email/password login |
| `/api/auth/google` | POST | No | Google Sign-In |
| `/api/auth/me` | GET | Yes | Current user + profile + notify_email |
| `/api/auth/logout` | POST | No | Clear auth cookie |
| `/api/auth/forgot` | POST | No | Send password reset email |
| `/api/auth/reset` | POST | No | Reset password with token |

### Profile
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/profile` | GET/PUT | Approved | Get/update alumni profile (auto-geocodes city) |
| `/api/profile/link` | POST | Approved | Link user to existing alumni record |
| `/api/profile/photos` | GET/POST | Approved | Get/upload profile photos |
| `/api/profile/photos/:id` | DELETE | Approved | Delete a photo |
| `/api/profile/notifications` | PUT | Approved | Toggle email notifications |
| `/api/unsubscribe` | GET | No | One-click unsubscribe via token |

### Content
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/articles` | GET | No | List published articles |
| `/api/articles` | POST | Approved | Create article |
| `/api/articles/:id` | GET/PUT/DELETE | — | Read/edit/delete article |
| `/api/articles/:id/cover` | POST | Approved | Upload cover image |
| `/api/articles/upload-image` | POST | Approved | Upload inline image |
| `/api/events` | GET | No | List events (with RSVP status if logged in) |
| `/api/events` | POST | Approved | Create event (triggers email notification) |
| `/api/events/:id` | PUT/DELETE | — | Edit (author/admin) / Delete (admin) |
| `/api/events/:id/cover` | POST | Approved | Upload event cover image |
| `/api/events/upload-image` | POST | Approved | Upload inline event image |
| `/api/events/:id/rsvp` | POST | Approved | Toggle RSVP |
| `/api/events/:id/rsvps` | GET | Admin | List attendees |

### Admin
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/admin/dashboard` | GET | Admin | Stats summary |
| `/api/admin/pending` | GET | Admin | Pending approval queue |
| `/api/admin/approve/:id` | POST | Admin | Approve user (auto-geocodes alumni) |
| `/api/admin/reject/:id` | POST | Admin | Reject user |
| `/api/admin/alumni` | GET/PUT | Admin | List/edit alumni |
| `/api/admin/alumni/:id` | DELETE | Admin | Delete alumni |
| `/api/admin/users` | GET/PUT/DELETE | Admin | Manage users |
| `/api/admin/config` | GET/PUT | Admin | SMTP + Telegram settings |
| `/api/admin/export` | GET | Admin | Export alumni CSV |

## Database Tables

| Table | Key Columns |
|-------|-------------|
| `alumni` | name, city, country, latitude, longitude, job_title, company, class |
| `users` | email, role, status, alumni_id, notify_email, unsubscribe_token |
| `articles` | title, content, status, cover_image, author_id |
| `events` | title, description, event_date, location, cover_image, rsvp_count, created_by |
| `event_rsvp` | event_id, alumni_id |
| `photos` | alumni_id, filename |
| `config` | key, value (smtp_*, telegram_*) |

## What's NOT Built Yet

- Memorial Page
- Photo Gallery from yearbook (243 portraits extracted, not uploaded)
- Auto-Geocoding for cities entered via admin panel (currently only on profile save / approval)
