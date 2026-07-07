# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 7099 Project Context — For AI Assistants

> Load this file at the start of a new conversation to resume work.
> Last updated: 2026-07-07

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

## Local Development

There is **no bundled dev script for the API** — the two halves run as separate processes:

```bash
npm install                 # root deps (Astro frontend)
npm run dev                 # Astro dev server (frontend only)
node api/server.cjs         # Express API — binds 127.0.0.1:3000, opens api/alumni.db
```

- API reads `alumni.db` from its own dir (`api/`); `better-sqlite3` is synchronous — no `await` on queries.
- Env vars (all optional, have fallbacks): `JWT_SECRET` (random per-boot if unset → invalidates tokens on restart), `GOOGLE_CLIENT_ID`. SMTP + Telegram creds live in the `config` DB table, set via `/admin`, not env.
- Frontend talks to the API via `/api/*`; in prod Nginx proxies that to `:3000`. For local dev you need a matching proxy or to run the built site behind Nginx — Astro's dev server does not proxy `/api` by itself.
- `npm run build` → `dist/`; `npm run preview` serves the build. There are **no tests or linters** configured.
- `scripts/` has its own `package.json` (CommonJS) — `cd scripts && npm install` before running the one-time importers.

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
- **Auth cookie / HTTPS (IMPORTANT):** the session cookie is `Secure; HttpOnly; SameSite=Lax`, so it is **only kept over HTTPS**. TLS terminates upstream (Proxmox/OpenResty) and forwards HTTP to nginx:80 — there is no edge HTTP→HTTPS redirect, so `Layout.astro` has an inline top-of-`<head>` script that redirects any `http:` load to `https:` (loop-safe; skips localhost). Without it, browsers with no HSTS (e.g. Chrome incognito) load over HTTP and silently drop the cookie → "login berhasil" then bounce back to `/login`. **Recommended:** add a real 301 + HSTS at the upstream TLS terminator.
- **Auth caching:** `app.disable("etag")` + `Cache-Control: no-store` on all `/api/auth/*` responses; client `/api/auth/me` fetches use `cache:"no-store"`. A cached `304`/stale `401` used to cause phantom logouts.
- **In-app browser handling:** `Layout.astro` detects WebViews (WhatsApp/Instagram/FB/Line/TikTok/Twitter/Android `wv`) via UA → sets `window.__inAppBrowser` + helpers `__openExternal()` (Android `intent://…package=com.android.chrome`) and `__copyLink()`. Google Sign-In is blocked in WebViews (`disallowed_useragent`) and cookies are flaky, so: a **dismissible banner** shows on all pages except `/login`; `/login` shows a **full-screen interstitial** (Android auto-open / iOS "•••→ Buka di Safari" hint / copy-link) and **hides the Google button** + its `#auth-divider`. The interstitial has a "Lanjut dengan email di sini" escape so a UA false-positive never locks anyone out. iOS cannot auto-escape a WebView (platform limit) — instructions only. UA token list needs occasional updates.
- **Login redirect (no second fetch):** `/api/auth/login` and `/api/auth/google` return `profile_complete` in the response; `login.astro` (`goAfterAuth()`) navigates with a **full page load** to `/` or `/profile`. Do NOT re-add a post-login `fetch("/api/auth/me")` — Safari private mode won't send a just-set cookie on an immediate follow-up fetch (it does on navigation).
- **Login flow:** `GET /api/auth/me` returns `profile_complete` + `missing_fields` — a profile is "complete" when **Nama, Kota, Negara, Pekerjaan, Kelas** are all filled. Incomplete profiles go to `/profile`, complete ones to `/`. Already-logged-in visitors to `/login` are routed the same way. On a **401**, `/profile` clears the dead cookie and redirects to `/login` (no dead-end).
- **Signup requirements (email/password):** full name + **≥1 Kelas** (1/2/3) are required, enforced **server-side** in `/api/auth/signup` and client-side in `login.astro`. Captured into `users.reg_class1/2/3` and shown in the admin **Pending** queue + Telegram alert so admins can identify the person before linking.
- **Signup requirements (Google):** Google Sign-In has no form, so `/api/auth/google` returns `needs_reg_info` (+ the JWT `token`) for a new Google user with no alumni link and no `reg_class*`. `login.astro` then shows a **required modal** (name prefilled from Google + ≥1 Kelas) that must be filled before continuing; it saves via `POST /api/auth/complete-registration` using `Authorization: Bearer <token>` (Safari private-mode safe — doesn't rely on the just-set cookie). So both signup paths capture name + kelas.
- **Admin user list:** the Users tab shows a **Login** column with method badges — 🔵 Google (`google_id`), ⚪ Email (`password_hash`), or both. `/api/admin/users` returns `has_password` + `google_id` for this.
- **Profile class fields:** alumni have `class1` (Kelas 1: 1-1…1-12, Lainnya), `class2` (Kelas 2: 2-A…2-L, Lainnya), and `class` (Kelas 3: IPA/IPS, Lainnya) — all editable in `/profile` and `/admin`. Only Kelas 3 (`class`) counts toward profile completeness.
- **Auth-aware nav (all pages):** on login, `#nav-login` swaps "Masuk" → "Profile" (→ `/profile`) and a `#nav-welcome` span shows "Welcome, `<Name>`" on the **left next to the logo** (`truncate` + `shrink-0` so it survives narrow viewports). Homepage also hides the "Masuk/Daftar" CTAs and shows a **"Profil kamu belum lengkap"** banner listing the missing fields. Profile page shows the same notice and highlights the specific empty `[data-req]` inputs.
- **Admin:** Dashboard, approval queue, alumni/user management, events management, articles management, settings (SMTP + Telegram)
- **Telegram:** Bot notifies group on new registration
- **Email:** Welcome, approval, rejection, password reset, new article/event notifications, forum reply/mention notifications, du-du mention notifications (SMTP: dr6101.inweb.id)
- **Email notifications:** Broadcast to all approved users with `notify_email=1` via `sendNewsletterEmail()`. One-click unsubscribe via `GET /api/unsubscribe?token=xxx`. Toggle in profile page.
- **Map:** Mapbox GL JS v3 globe projection (`streets-v12`), red translucent pins, native clustering, login-gated starburst cards, city labels
- **Stats:** 12 sections with scroll animations, normalized jobs/industries/universities. **IPA vs IPS** and **Kelas Paling Rame** count **registered users only** (alumni linked to a `users` row) — the roster import added ~285 non-registered alumni that would otherwise skew class stats; all other stats use the full public roster. All count endpoints (`/api/stats`, `/api/stats/detail`, map, directory) filter `is_public = 1` so every page shows the same alumni total (see the is_public note below).
- **Articles:** Magazine layout, masonry photo gallery, lightbox with swipe, inline image/video upload (sharp resize), auto-link URLs, `[foto:]` and `[video:]` tag system. 95 Instagram posts imported as articles under author "Zapatista7099_Insta".
- **Events:** RSVP toggle, cover + inline images, `[foto:]` tag system, lightbox. Any approved user can create; only admin can delete; creator/admin can edit. Date tapping downloads `.ics`. Location links to Google Maps.
- **Gallery:** Folder-based photo gallery. 6 display modes: Polaroid, Magazine Editorial, Filmstrip, Feed, Slideshow, Yearbook. Layout stored per folder (admin sets it). Upload: any approved user. Delete: admin only. Seeded: "Yearbook" (239 portraits) + "Instagram Archive" (129 photos).
- **Forum:** Category-based discussion board. 5 categories + 2 sticky how-to posts pre-seeded. Threads + replies + 5 emoji reactions. `@mention` notifications (email to mentioned alumni). Reply notifications (email to thread author). Admin: pin/lock/delete threads and replies.
- **Du-Du Wall:** Nostalgic "dari-untuk" (from-to) messaging wall à la 1999 school mading. Short notes (60/60/280 char) with 3 fixed fields: Dari, Untuk, Pesan. 7 rotating pastel colors, rotated notes, Caveat handwritten font. `@nickname` autocomplete dropdown on Untuk + Pesan (keyboard nav + click). Email notifications to `@mentioned` alumni. 5 emoji reactions. Shuffle button. JS masonry (flex columns with shortest-column placement) for clean wrapping at any viewport. Delete: owner + admin.
- **Photos:** Symlink dist/photos → public/photos (survives builds), sharp auto-resize max 800px
- **Auto-Geocoding:** When alumni saves profile or is approved by admin, city+country is sent to Nominatim to fill lat/lng automatically. Fires in background (non-blocking). Existing coords not overwritten unless city changes.
- **PWA:** `public/manifest.json` declares app name "Zapatista 7099", standalone display, amber theme. Icons: icon-512.png, icon-192.png, icon-180.png (from zapa_icon_2.png). All iOS/Android meta tags in Layout.astro.
- **Homepage feature grid:** 5 button cards (Map, Stats, Articles, Gallery, Forum) in responsive grid (2 mobile / 3 tablet / 5 desktop). Each uses a PNG icon + short Indonesian description.
- **Homepage hero subtitle:** "X Tahun Kemudian, Tetap Terhubung" — auto-computed as `currentYear - 1999` via inline JS on page load. No annual maintenance needed.
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
- **Icon cache-busting:** favicon/manifest/apple-touch links in `Layout.astro` carry a `?v=${iconV}` query, driven by the `iconV` constant in the frontmatter. When you replace any icon asset, **bump `iconV`** so browsers refetch instead of serving the stale cached icon. The browser tab favicon is `favicon.ico` + `favicon-16/32.png` (generated from `icon-512.png` via sharp — NOT the old Astro placeholder `favicon.svg`, which browsers preferred over PNGs).
- **Map:** `/map` uses **Mapbox GL JS v3** (`projection: 'globe'`, `streets-v12` style) with native GeoJSON clustering and red translucent pins. Public `pk.` token is inline in `map.astro` — must be **URL-restricted** in the Mapbox account. The starburst name cards are a login-gated DOM overlay positioned via `map.project()`; `/api/map` is unchanged.
- **`is_public` / alumni count:** the DB holds 508 alumni rows but one (`Zapatista7099_Insta`, the Instagram-articles author) has `is_public = 0`, so the real, listable count is **507**. Every count/list endpoint filters `WHERE is_public = 1` — keep it that way so the homepage, stats, map, and directory stay consistent (don't count the bot).
- **Profile save feedback:** the `#save-msg`/`#save-err` banners render **directly below the "Simpan" button** (not above the form) so the user sees confirmation where they clicked.

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
| `merge-dryrun.cjs` | Alumni roster merge: multi-pass name matching (registered-user aware), writes `merge-plan.json` |
| `make-review-files.cjs` | Emit human-reviewable decision CSVs to `merge-review/` from the plan |
| `build-actions.cjs` | Resolve review decisions → concrete op list `merge-actions.json` |
| `apply-actions.cjs` | Backup + transactional apply of `merge-actions.json` (runtime safety guards) |

> The `merge-*` scripts imported `merged_classes_ed.csv` (490-row class roster) on 2026-07-07, taking alumni from 225 → 508. Only `name/class/nickname/birthday` were imported (addresses/phones dropped). Registered users' records and the `users` table were never touched; 2 pre-existing duplicates were removed. Raw/personal data (roster CSV, review CSVs, user dumps, plan/actions JSON) is **gitignored** — only the reusable tooling is tracked. A timestamped DB backup lives at `api/alumni.backup-*.db` on the server.

## What's NOT Built Yet

- Memorial Page
- Auto-Geocoding when admin manually edits alumni city in admin panel (only fires on profile save and approval currently)
