# 7099 — Alumni SMU 70 Angkatan 99

> Reconnecting the Class of 1999 from SMAN 70 Jakarta.

## 🌐 Live Site

**https://zapa.inweb.id**

## Features

| Feature | Status | URL |
|---------|--------|-----|
| Homepage with dynamic stats + floating du-du bubble + auto-incrementing years-since | ✅ | `/` |
| Login (Email + Google OAuth, redirects by profile completeness) | ✅ | `/login` |
| Signup requires full name + ≥1 Kelas (shown to admin for identification) | ✅ | `/login` |
| Password Reset | ✅ | `/reset` |
| Profile (auto-match alumni DB, edit, photo upload, completeness nudge) | ✅ | `/profile` |
| Interactive Globe Map (Mapbox GL) | ✅ | `/map` |
| Directory (browse alumni, login-gated) | ✅ | `/directory` |
| Statistics / Charts (class stats = registered users only) | ✅ | `/stats` |
| Articles (cover + inline images/videos, lightbox) | ✅ | `/articles` |
| Events (RSVP, images, .ics calendar, maps link) | ✅ | `/events` |
| Gallery (folders, 6 view modes, admin layout control) | ✅ | `/gallery` |
| Forum (categories, threads, replies, reactions, @mentions) | ✅ | `/forum` |
| Du-Du Wall (dari-untuk notes, mading-style, @autocomplete) | ✅ | `/dudu` |
| Admin Panel (approval queue, alumni/user mgmt, settings) | ✅ | `/admin` |
| Email Notifications (articles, events, forum, du-du mentions) | ✅ | — |
| Auto-Geocoding (city → lat/lng via Nominatim) | ✅ | — |
| PWA (installable, custom icon, app name) | ✅ | — |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Astro v6 + Tailwind CSS v4 |
| Backend API | Node.js Express (`api/server.cjs`) |
| Database | SQLite via `better-sqlite3` |
| Globe/Map | Mapbox GL JS v3 (globe projection, native clustering) |
| Auth | JWT (HttpOnly cookies) + Google Sign-In |
| Image Processing | sharp (resize to 800px, JPEG 80%) |
| Video | HTML5 `<video>` via `[video:]` tag, ffmpeg for frame extraction |
| Email | nodemailer (SMTP via config table) |
| Geocoding | Nominatim / OpenStreetMap (no API key) |
| Process Manager | PM2 |
| Web Server | Nginx (reverse proxy) |
| SSL | Proxmox/OpenResty (host-level) |
| OS | Debian 12 (Bookworm), Node.js v22 |

## Project Structure

```
├── src/
│   ├── pages/
│   │   ├── index.astro        # Homepage
│   │   ├── login.astro        # Login / signup (Google + email)
│   │   ├── reset.astro        # Password reset
│   │   ├── profile.astro      # Profile edit, photo upload, notification toggle
│   │   ├── map.astro          # Interactive D3 globe map
│   │   ├── directory.astro    # Alumni directory (approved users)
│   │   ├── stats.astro        # Statistics and charts
│   │   ├── articles.astro     # Blog ([foto:] + [video:] tags, lightbox)
│   │   ├── events.astro       # Events (RSVP, cover + inline images)
│   │   ├── gallery.astro      # Photo gallery (6 layouts, folder-based)
│   │   ├── forum.astro        # Discussion forum (categories, threads, reactions)
│   │   ├── dudu.astro         # Du-Du wall (dari-untuk, mading-style, @mention)
│   │   └── admin.astro        # Admin panel
│   └── layouts/
│       └── Layout.astro       # HTML shell with PWA meta tags
├── api/
│   └── server.cjs             # Express API (CommonJS)
├── scripts/
│   ├── import-insta.cjs       # One-time: Instagram folders → articles
│   ├── seed-gallery.cjs       # One-time: seed Yearbook + Instagram gallery folders
│   ├── merge-dryrun.cjs       # Alumni roster merge: name matching → merge-plan.json
│   ├── make-review-files.cjs  # Emit reviewable decision CSVs (merge-review/)
│   ├── build-actions.cjs      # Resolve decisions → merge-actions.json
│   └── apply-actions.cjs      # Backup + transactional apply (safety-guarded)
├── public/
│   ├── photos/                # Uploaded images (symlinked from dist/photos)
│   ├── manifest.json          # PWA manifest
│   ├── icon-192.png           # PWA icon (Android)
│   ├── icon-512.png           # PWA icon (splash)
│   └── icon-180.png           # PWA icon (iOS)
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
| `/api/auth/me` | GET | Yes | Current user + profile + `profile_complete` + `missing_fields` |
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

### Articles
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/articles` | GET | No | List published articles |
| `/api/articles` | POST | Approved | Create article |
| `/api/articles/:id` | GET/PUT/DELETE | — | Read/edit/delete article |
| `/api/articles/:id/cover` | POST | Approved | Upload cover image |
| `/api/articles/upload-image` | POST | Approved | Upload inline image |

### Events
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/events` | GET | No | List events (with RSVP status if logged in) |
| `/api/events` | POST | Approved | Create event (triggers email notification) |
| `/api/events/:id` | PUT/DELETE | — | Edit (author/admin) / Delete (admin) |
| `/api/events/:id/cover` | POST | Approved | Upload event cover image |
| `/api/events/upload-image` | POST | Approved | Upload inline event image |
| `/api/events/:id/rsvp` | POST | Approved | Toggle RSVP |
| `/api/events/:id/rsvps` | GET | Admin | List attendees |

### Gallery
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/gallery/folders` | GET | No | List folders with preview photos + counts |
| `/api/gallery/folders/:id` | GET | No | List photos in folder |
| `/api/gallery/folders` | POST | Approved | Create folder |
| `/api/gallery/folders/:id/photos` | POST | Approved | Upload photos (up to 20) |
| `/api/gallery/folders/:id/layout` | PUT | Admin | Set default display layout |
| `/api/gallery/folders/:id` | DELETE | Admin | Delete folder + all photos |
| `/api/gallery/photos/:id` | DELETE | Admin | Delete single photo |

### Forum
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/forum/categories` | GET | No | List categories with thread counts |
| `/api/forum/categories/:id/threads` | GET | No | List threads (stickies first) |
| `/api/forum/threads/:id` | GET | No | Thread + replies + reactions |
| `/api/forum/threads` | POST | Approved | Create thread |
| `/api/forum/threads/:id` | PUT | Author/Admin | Edit thread |
| `/api/forum/threads/:id` | DELETE | Admin | Delete thread |
| `/api/forum/threads/:id/sticky` | PUT | Admin | Toggle sticky pin |
| `/api/forum/threads/:id/lock` | PUT | Admin | Toggle lock |
| `/api/forum/threads/:id/replies` | POST | Approved | Add reply (sends notifications) |
| `/api/forum/replies/:id` | PUT | Author/Admin | Edit reply |
| `/api/forum/replies/:id` | DELETE | Admin | Delete reply |
| `/api/forum/react` | POST | Approved | Toggle emoji reaction |

### Du-Du Wall
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/dudu` | GET | No | List all notes with reactions |
| `/api/dudu` | POST | Approved | Create note (fires @mention email notifications) |
| `/api/dudu/:id` | DELETE | Owner/Admin | Delete note |
| `/api/dudu/react` | POST | Approved | Toggle emoji reaction |

### Admin
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/admin/dashboard` | GET | Admin | Stats summary |
| `/api/admin/pending` | GET | Admin | Pending approval queue |
| `/api/admin/approve/:id` | POST | Admin | Approve user (auto-geocodes alumni) |
| `/api/admin/reject/:id` | POST | Admin | Reject user |
| `/api/admin/alumni` | GET/PUT | Admin | List/edit alumni |
| `/api/admin/alumni/:id` | DELETE | Admin | Delete alumni |
| `/api/admin/articles` | GET | Admin | List all articles |
| `/api/admin/articles/:id` | DELETE | Admin | Delete any article |
| `/api/admin/users` | GET/PUT/DELETE | Admin | Manage users |
| `/api/admin/config` | GET/PUT | Admin | SMTP + Telegram settings |
| `/api/admin/export` | GET | Admin | Export alumni CSV |

## Database Tables

| Table | Key Columns |
|-------|-------------|
| `alumni` | name, city, country, latitude, longitude, job_title, company, class, class1, class2 |
| `users` | email, role, status, alumni_id, notify_email, unsubscribe_token, reg_class1/2/3 |
| `articles` | title, content, status, cover_image, author_id |
| `events` | title, description, event_date, location, cover_image, created_by |
| `event_rsvp` | event_id, alumni_id |
| `photos` | alumni_id, filename |
| `gallery_folders` | name, description, icon, sort_order, default_layout |
| `gallery_photos` | folder_id, filename, caption, uploaded_by |
| `forum_categories` | name, description, icon, sort_order |
| `forum_threads` | category_id, author_id, title, body, is_sticky, is_locked, view_count |
| `forum_replies` | thread_id, author_id, body |
| `forum_reactions` | thread_id, reply_id, alumni_id, emoji |
| `dudu_notes` | dari_text, untuk_text, pesan, posted_by |
| `dudu_reactions` | note_id, alumni_id, emoji |
| `config` | key, value (smtp_*, telegram_*) |

## What's NOT Built Yet

- Memorial Page
- Auto-Geocoding for cities entered via admin panel (currently only on profile save / approval)
