# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 7099 Project Context — For AI Assistants

> Load this file at the start of a new conversation to resume work.
> Last updated: 2026-07-30

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

- **Astro v6** + **Tailwind CSS v4** (static site, 14 pages)
- **Express.js** API (`api/server.cjs` — CommonJS, single ~1900-line file)
- **SQLite** via `better-sqlite3`, **Mapbox GL JS v3** globe (CDN, not an npm dep), **Chart.js** stats
  - `leaflet` is still in `package.json` but **unused** — the map was migrated to Mapbox GL. Chart.js and Mapbox are loaded from CDN inside the pages, so most deps in `package.json` are the API's, not the frontend's.
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
- Env vars: `JWT_SECRET` (optional — random per-boot if unset → invalidates all tokens on restart; set in `ecosystem.config.cjs` on the server). `GOOGLE_CLIENT_ID` is read into a const but **never used** — the real client id is hardcoded in `src/pages/login.astro`. SMTP + Telegram creds live in the `config` DB table, set via `/admin`, not env.
- Frontend talks to the API via `/api/*`; in prod Nginx proxies that to `:3000`. For local dev you need a matching proxy or to run the built site behind Nginx — Astro's dev server does not proxy `/api` by itself.
- `npm run build` → `dist/`; `npm run preview` serves the build. There are **no tests, linters, or typecheck scripts** — nothing to run to validate a change beyond `npm run build` and `node --check api/server.cjs`. `tsconfig.json` extends `astro/tsconfigs/strict`, but `@astrojs/check` isn't installed, so `astro check` won't run without installing it.
- `scripts/` has its own `package.json` (CommonJS) — `cd scripts && npm install` before running the one-time importers.

## Code Map & Conventions

**Two halves, no shared code between them.** The frontend is static HTML+inline JS; the backend is one Express file. There is no build step, bundler, or module system on the API side, and no client framework on the frontend side.

### `api/server.cjs` (the whole backend)

- **Layout:** config → DB open/DDL → helpers (email/telegram/geocode) → middlewares → routes, grouped by feature. **Schema DDL is interleaved with routes, not centralized:** `users`/`alumni`/`class_suggestions` at the top (~L27-150), gallery tables ~L154, forum tables ~L1507, du-du tables ~L1789 — each right above its routes. Follow that pattern for a new feature (DDL block, then its routes, at the end of the file).
- **Migrations are idempotent DDL at boot, not files:** `db.exec("CREATE TABLE IF NOT EXISTS …")` for new tables and `try { db.exec("ALTER TABLE x ADD COLUMN y") } catch(e) {}` for new columns. **Never edit an existing `CREATE TABLE`** — live DBs already have the table, so the change silently never applies. Add an `ALTER` line instead.
- **Auth gates are three middlewares** — `authMiddleware` (valid JWT), `approvedMiddleware` (JWT + `status='approved'`), `adminMiddleware` (JWT + `role='admin'`). Pick one per route; there is no per-route permission config anywhere else.
- **Ownership checks are ad hoc,** inside each handler (e.g. articles/forum compare `author_id` to `req.user.id`). Some routes deliberately have none (gallery photo delete) — see the Gallery note below before "fixing" one.
- **Uploads:** one shared `multer` diskStorage → `public/photos/` (20 MB limit, image filter), then `sharp` resize to max 800px. Deletes `fs.unlinkSync` from the same dir. The DB stores only filenames; the bytes live on disk (that's why backups mirror `public/photos/` separately).
- `require()` calls appear both at the top and inline mid-file (`require("path")`); style is ES5-ish (`var`/`function`, string concatenation) throughout. Match it rather than modernizing.

### Frontend (`src/`)

- **Every page in `src/pages/` is self-contained**: markup + its own `<script is:inline>` doing `fetch("/api/…", {credentials:"include"})` and DOM assembly by hand. There are **no Astro components, islands, or client frameworks** — `src/components/Welcome.astro` is leftover Astro boilerplate and is not used. `src/styles/global.css` is just `@import 'tailwindcss'`.
- Inline scripts are written in ES5 style (`var`, `function`, no optional chaining) because they ship unbundled/untranspiled to old in-app WebViews. Keep it that way.
- **`Layout.astro` is the only shared surface** — cross-cutting concerns belong there and nowhere else: the HTTPS redirect, in-app-browser detection + helpers, the site footer (auto-removed if a page has its own `<footer>`), the T&C blocking gate, PWA/icon meta + `iconV` cache-buster.
- **The auth-aware nav is duplicated per page** (`#nav-login` / `#nav-welcome` markup + the `/api/auth/me` swap script exist in each page that has a nav). Changing nav behaviour means editing every page — grep `nav-welcome` to find them all.
- Page-level state is plain globals + `innerHTML`/`createElement`; no shared fetch wrapper, so `credentials:"include"` and `cache:"no-store"` (for `/api/auth/*`) must be repeated at each call site.

### Known rough edges (don't mistake these for bugs to fix silently)

- **`POST /api/auth/google` does not verify the Google credential** — it base64-decodes the JWT payload and trusts `email`/`sub` without checking the signature or `aud`. Any client can mint a payload and be issued a session for an arbitrary email, including an admin's. Fixing it means verifying against Google's JWKS (e.g. `google-auth-library`'s `verifyIdToken` with the client id) — flag it to the user before changing auth behaviour.
- `server/nginx.conf` in the repo is a **reference copy** of the server's config, not something deploy applies.
- **`package-lock.json` is tracked and deploy runs `npm ci`** (since 2026-07-30) — local and server install identical trees. Before that, untracked lockfile + caret ranges let a local `npm install` pull vite 8 / astro 6.4.8, which failed the build with `Missing field 'tsconfigPaths'` from `@tailwindcss/vite` while the server kept building fine on vite 7.3.2 / astro 6.1.8. If a build fails only on one side, check the installed versions before suspecting the code. Local `npm ci` needs **Node 22** (see the Deploy section).

### Outbound network / DNS (first thing to check when notifications "stop working")

Telegram, SMTP email, Nominatim geocoding, and the rclone offsite backup **all depend on outbound DNS from the LXC container**. When they fail together, it is almost never the credentials.

- **2026-07-27 → 2026-07-30 outage:** `/etc/resolv.conf` pointed at `nameserver 100.100.100.100` (Tailscale MagicDNS) but the container has no `tailscale0` interface and no tailscale binary → every lookup timed out. Telegram, welcome/approval emails, geocoding, and the Google Drive backup push were all dead for ~3.5 days while local DB backups kept succeeding. Fixed by setting `nameserver 1.1.1.1` + `8.8.8.8`; old file saved at `/etc/resolv.conf.bak-20260730`.
- **`/etc/resolv.conf` is rewritten by Proxmox on container start** (note the `# --- BEGIN PVE ---` markers), so the in-container fix is temporary. The durable fix is the LXC's DNS field on the Proxmox host: `pct set <CTID> --nameserver "1.1.1.1 8.8.8.8"`.
- Quick triage on the server: `getent hosts api.telegram.org` (fails ⇒ DNS), then `nslookup api.telegram.org 1.1.1.1` (works ⇒ the configured resolver is the problem, not the network).
- `backups/backup.log` is the best outage timeline — it timestamps every offsite success/failure daily, and its rclone errors name the failing DNS server explicitly.


## Pages (14)

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
| Gallery | `/gallery` | **Approved only** (view); upload/photo-delete: approved; folder create/delete/layout: admin |
| Forum | `/forum` | Public (post: approved, mod: admin) |
| Du-Du Wall | `/dudu` | Public (post: approved, delete: owner/admin) |
| Admin | `/admin` | Admin only |
| Terms & Conditions | `/terms` | Public |

## Key Systems

- **Auth:** JWT cookies, Google OAuth, approval system (pending/approved/rejected)
- **Auth cookie / HTTPS (IMPORTANT):** the session cookie is `Secure; HttpOnly; SameSite=Lax`, so it is **only kept over HTTPS**. TLS terminates upstream (Proxmox/OpenResty) and forwards HTTP to nginx:80 — there is no edge HTTP→HTTPS redirect, so `Layout.astro` has an inline top-of-`<head>` script that redirects any `http:` load to `https:` (loop-safe; skips localhost). Without it, browsers with no HSTS (e.g. Chrome incognito) load over HTTP and silently drop the cookie → "login berhasil" then bounce back to `/login`. **Recommended:** add a real 301 + HSTS at the upstream TLS terminator.
- **Auth caching:** `app.disable("etag")` + `Cache-Control: no-store` on all `/api/auth/*` responses; client `/api/auth/me` fetches use `cache:"no-store"`. A cached `304`/stale `401` used to cause phantom logouts.
- **In-app browser handling:** `Layout.astro` detects WebViews (WhatsApp/Instagram/FB/Line/TikTok/Twitter/Android `wv`) via UA → sets `window.__inAppBrowser` + helpers `__openExternal()` (Android `intent://…package=com.android.chrome`) and `__copyLink()`. Google Sign-In is blocked in WebViews (`disallowed_useragent`) and cookies are flaky, so: a **dismissible banner** shows on all pages except `/login`; `/login` shows a **full-screen interstitial** (Android auto-open / iOS "•••→ Buka di Safari" hint / copy-link) and **hides the Google button** + its `#auth-divider`. The interstitial has a "Lanjut dengan email di sini" escape so a UA false-positive never locks anyone out. iOS cannot auto-escape a WebView (platform limit) — instructions only. UA token list needs occasional updates.
- **Login redirect (no second fetch):** `/api/auth/login` and `/api/auth/google` return `profile_complete` in the response; `login.astro` (`goAfterAuth()`) navigates with a **full page load** to `/` or `/profile`. Do NOT re-add a post-login `fetch("/api/auth/me")` — Safari private mode won't send a just-set cookie on an immediate follow-up fetch (it does on navigation).
- **Login flow:** `GET /api/auth/me` returns `profile_complete` + `missing_fields` — a profile is "complete" when **Nama, Kota, Negara, Pekerjaan, Kelas** are all filled. Incomplete profiles go to `/profile`, complete ones to `/`. Already-logged-in visitors to `/login` are routed the same way. On a **401**, `/profile` clears the dead cookie and redirects to `/login` (no dead-end).
- **Signup requirements (email/password):** full name + **≥1 Kelas** (1/2/3) are required, enforced **server-side** in `/api/auth/signup` and client-side in `login.astro`. Captured into `users.reg_class1/2/3` and shown in the admin **Pending** queue + Telegram alert so admins can identify the person before linking.
- **Signup requirements (Google):** Google Sign-In has no form, so `/api/auth/google` returns `needs_reg_info` (+ the JWT `token`) for a new Google user with no alumni link and no `reg_class*`. `login.astro` then shows a **required modal** (name prefilled from Google + ≥1 Kelas) that must be filled before continuing; it saves via `POST /api/auth/complete-registration` using `Authorization: Bearer <token>` (Safari private-mode safe — doesn't rely on the just-set cookie). So both signup paths capture name + kelas. **Modal reappears on re-login only if the user is still unlinked** (`needs_reg_info = !reg_class* && (isNewUser || !alumni_id)`) — a Google user who was auto-matched to an alumni row but abandoned the modal is NOT re-prompted (deliberate, to avoid pestering the ~285 pre-existing linked alumni).
- **Google signup Telegram (two-stage):** the Google path fires the "🆕 Pendaftaran Baru!" Telegram alert immediately on account creation (before the modal) with `Kelas: ⏳ menunggu diisi di form` — this is the safety-net alert so abandoned modals still notify admins. When the modal is submitted, `complete-registration` sends a second "✅ Data Pendaftaran Dilengkapi (Google)" alert with the **final name + kelas** (matching the email/password message format). The second alert is guarded by an `alreadyCompleted` snapshot check so re-submitting the modal on a later login won't send duplicates. (Email/password signup sends its single complete alert directly in `/api/auth/signup` since name + kelas arrive in one request.)
- **Admin user list:** the Users tab shows a **Login** column with method badges — 🔵 Google (`google_id`), ⚪ Email (`password_hash`), or both. `/api/admin/users` returns `has_password` + `google_id` for this.
- **Profile class fields:** alumni have `class1` (Kelas 1: 1-1…1-12, Lainnya), `class2` (Kelas 2: 2-A…2-L, Lainnya), and `class` (Kelas 3: IPA/IPS, Lainnya) — all editable in `/profile` and `/admin`. Only Kelas 3 (`class`) counts toward profile completeness. All three are shown in the **directory** cards (`📗 Kelas 1` / `📘 Kelas 2` in the card's extra section, `🎓` Kelas 3 in the main details) and as columns in the **admin** alumni table; `/api/directory` returns `class1`/`class2` alongside `class`. The directory has **three separate filter dropdowns** (Semua Kelas 1 / 2 / 3), each populated from actual data values and AND-combined with the city filter + search.
- **Profile email field:** `/profile` shows the logged-in account's email in a **read-only, `disabled`** field at the top of the form (populated from `/api/auth/me` → `d.user.email`). It has no `name` attribute, so it's never submitted or editable.
- **Auth-aware nav (all pages):** on login, `#nav-login` swaps "Masuk" → "Profile" (→ `/profile`) and a `#nav-welcome` span shows "Welcome, `<Name>`" on the **left next to the logo** (`truncate` + `shrink-0` so it survives narrow viewports). Homepage also hides the "Masuk/Daftar" CTAs and shows a **"Profil kamu belum lengkap"** banner listing the missing fields. Profile page shows the same notice and highlights the specific empty `[data-req]` inputs.
- **Admin:** Dashboard, approval queue, alumni/user management, events management, articles management, settings (SMTP + Telegram)
- **Telegram:** Bot notifies group on new registration (email/password: one complete alert with name + kelas; Google: a "menunggu" alert on signup + a "Data Pendaftaran Dilengkapi" alert with final name + kelas after the modal — see the Google signup Telegram note above). `sendTelegram()` returns a Promise that **always resolves** `{ok, error}` (never rejects, so fire-and-forget callers stay safe) and **reads Telegram's response body** — Telegram answers HTTP 200 with `{"ok":false,"description":...}` for a bad token/chat id and for HTML it can't parse. All interpolated user values go through `tgEsc()`; without it a name containing `&` or `<` makes Telegram reject the entire message. `/api/admin/telegram-test` + `/api/admin/email-test` return **502 + the real error** so the admin UI shows the actual cause instead of a blind "sent!".
- **Email:** Welcome, approval, rejection, password reset, new article/event notifications, forum reply/mention notifications, du-du mention notifications (SMTP: dr6101.inweb.id)
- **Email notifications:** Broadcast to all approved users with `notify_email=1` via `sendNewsletterEmail()`. One-click unsubscribe via `GET /api/unsubscribe?token=xxx`. Toggle in profile page.
- **Map:** Mapbox GL JS v3 globe projection (`streets-v12`), red translucent pins, native clustering, login-gated starburst cards, city labels
- **Stats:** 12 sections with scroll animations, normalized jobs/industries/universities. **IPA vs IPS** and **Kelas Paling Rame** count **registered users only** (alumni linked to a `users` row) — the roster import added ~285 non-registered alumni that would otherwise skew class stats; all other stats use the full public roster. All count endpoints (`/api/stats`, `/api/stats/detail`, map, directory) filter `is_public = 1` so every page shows the same alumni total (see the is_public note below).
- **Articles:** Magazine layout, masonry photo gallery, lightbox with swipe, inline image/video upload (sharp resize), auto-link URLs, `[foto:]` and `[video:]` tag system. 95 Instagram posts imported as articles under author "Zapatista7099_Insta".
- **Events:** RSVP toggle, cover + inline images, `[foto:]` tag system, lightbox. Any approved user can create; only admin can delete; creator/admin can edit. Date tapping downloads `.ics`. Location links to Google Maps.
- **Class suggestions (crowd-sourced):** in the **directory**, any approved user can suggest a class (Kelas 1/2/3) for **another** alumni — both to **fill an empty field** and to **correct a wrong one** (a filled field shows its value + a small "✎" button and a `📝 Usulan koreksi` tally when others proposed a different value). Suggestions accumulate as a ranked tally; the only suggestion dropped is one that **agrees with the current value** (no signal). Table `class_suggestions(target_alumni_id, field, value, suggested_by_user_id, UNIQUE(target,field,by))` — **one vote per user per field** (upsert). Values validated server-side against `CLASS_OPTIONS` (dropdown enums, incl. "Lainnya" — no free text) via `suggestionsForAlumni()` (returns per-field suggestions that differ from the current value, for empty AND filled fields). Endpoints: `POST/DELETE /api/directory/:id/suggest-class` (approved; blocks your own card + rejects a value equal to the current one), `/api/directory` returns per-card `suggestions`/`my_suggestions`/`is_self`, `/api/auth/me` returns `class_suggestions` for the caller's own fields → **profile prompt** (shows `(sekarang: X)` for filled fields) with one-click adopt (`POST /api/profile/adopt-suggestion` = "admit", overwrites the field). Works on the **~397 non-registered alumni** too — admin **"Usulan Kelas"** tab lists grouped suggestions with counts + suggester names + the current value, and can **promote** (`POST /api/admin/alumni/:id/promote-class`) or **delete** (`DELETE /api/admin/suggestions/:id`). Public cards show counts only (not who suggested); admin sees names.
- **Gallery:** Folder-based photo gallery. **View is approved-users-only** (`/api/gallery/folders*` require `approvedMiddleware`; the page shows a login gate otherwise). 6 display modes: Polaroid, Magazine Editorial, Filmstrip, Feed, Slideshow, Yearbook. Layout stored per folder (admin sets it). Upload: any approved user. **Photo delete: any approved user** (no ownership check — `canDelPhoto` in gallery.astro; `DELETE /api/gallery/photos/:id` + `DELETE /api/profile/photos/:id` are `approvedMiddleware`). Folder create/delete: admin. Seeded: "Yearbook" (239 portraits) + "Instagram Archive" (129 photos).
- **Terms & Conditions (`/terms`):** full T&C (data collected, third parties, **AI use**, conduct, data rights). `users.tos_accepted_at` (NULL = must agree). `POST /api/auth/accept-tos` records it; `/api/auth/me` returns `tos_accepted`. `Layout.astro` shows a **blocking gate** to any logged-in user who hasn't accepted, on every page except `/login`/`/terms`/`/reset` — so all existing users must agree on next visit. Footer link on every page (site-wide footer in `Layout.astro`; deduped when a page has its own `<footer>`).
- **Forum:** Category-based discussion board. 5 categories + 2 sticky how-to posts pre-seeded. Threads + replies + 5 emoji reactions. `@mention` notifications (email to mentioned alumni). Reply notifications (email to thread author). Admin: pin/lock/delete threads and replies.
- **Du-Du Wall:** Nostalgic "dari-untuk" (from-to) messaging wall à la 1999 school mading. Short notes (60/60/280 char) with 3 fixed fields: Dari, Untuk, Pesan. 7 rotating pastel colors, rotated notes, Caveat handwritten font. `@nickname` autocomplete dropdown on Untuk + Pesan (keyboard nav + click). Email notifications to `@mentioned` alumni. 5 emoji reactions. Shuffle button. JS masonry (flex columns with shortest-column placement) for clean wrapping at any viewport. Delete: owner + admin.
- **Photos:** Symlink dist/photos → public/photos (survives builds), sharp auto-resize max 800px
- **Auto-Geocoding:** On profile save, admin approval, **and admin alumni edit**, the location is sent to Nominatim to fill lat/lng automatically (background, non-blocking). Uses `geocodeLocation(address, city, country)` — **address-first with city fallback**: tries `"<address>, <city>, <country>"`, and if Nominatim returns nothing (common for Indonesian house-number addresses like `Jl. … No. 8`) falls back to `"<city>, <country>"` so the pin degrades to the city centroid instead of vanishing. Resolved coords are **jittered ~±500m** (`jitterCoords`, neighbourhood-level) for privacy — never the exact doorstep; city-only pins get spread out too. Existing coords aren't overwritten unless city changes (editing *only* the address does not re-trigger geocoding). Legacy `geocodeCity(city, country)` remains as a thin shim.
- **Map "Null Island" guard:** un-located alumni must have `latitude`/`longitude` = **`NULL`**, never empty string `''`. An empty string passes `latitude IS NOT NULL` (SQL) and `== null` (JS) and Mapbox coerces it to `0` → pin lands at `[0,0]` off West Africa. Guards: `PUT /api/admin/alumni/:id` coerces empty form values to `NULL` (`nz()` helper); `/api/map` filters `latitude != ''`; `map.astro` uses `parseFloat`+`isFinite` and skips `(0,0)`. (Fixed 2026-07-08 for 5 affected alumni.)
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

**`/var/www/alumni` is a git checkout of `origin/main`** (adopted in place 2026-07-10). Deploy is git-pull-based via `deploy.sh` (tracked in the repo, lives at the server root):

```bash
ssh -i /path/to/zapa7099_key -p 52017 zapa@103.16.198.61
cd /var/www/alumni && ./deploy.sh
```

`deploy.sh` does: chown build dirs → `git fetch` + `git reset --hard origin/main` → **re-exec itself if `deploy.sh` changed** → `npm ci` (only if `package.json`/`package-lock.json` changed) → `npm run build` → chown `dist/` to www-data → recreate `dist/photos` symlink → reload nginx → `pm2 restart alumni-api` **only if `api/`, `ecosystem.config.cjs`, `package.json`, or `package-lock.json` changed**. So the normal flow is: commit + `git push` locally, then run `./deploy.sh` on the server.

- **Self-update guard:** bash reads a script incrementally *while running it*, so `git reset --hard` can swap `deploy.sh` out mid-execution — the remaining steps then run the old logic, or a mis-parsed hybrid at shifted byte offsets. (Real case 2026-07-30: the deploy that introduced `npm ci` ran the previous script and skipped it.) The script now re-execs itself once via `DEPLOY_REEXEC=1`, passing the first pass's file list in `DEPLOY_CHANGED` — the second pass **must not** recompute the diff, since `HEAD` already equals `origin/main` and the empty result would silently skip `npm ci` and the API restart.

- **Edits must go through git now** — anything edited directly in a tracked file on the server is wiped by the next `git reset --hard`. Server-only files stay untracked & safe: `ecosystem.config.cjs` (holds `JWT_SECRET`), `api/alumni.db`, `backups/`, `node_modules/`, `dist/`, `public/photos/`.
- `package-lock.json` **is tracked** (added 2026-07-30, seeded from the server's working tree) and deploy uses **`npm ci`**, so local and server install byte-identical dependency trees. Don't run a bare `npm install`/`npm update` casually — it re-resolves the caret ranges and reintroduces the drift; if you do change deps, commit the updated lockfile in the same commit.
- **Local Node must be v22 to build `better-sqlite3`.** The server runs Node v22.22.2; `better-sqlite3@12.9.0` has no prebuilt binary for Node 26, so `npm ci` on a Node 26 machine fails at `node-gyp rebuild`. Use `nvm use 22`, or `npm ci --ignore-scripts` if you only need to build the frontend (the local API won't start without the native binding — `npm rebuild better-sqlite3` under Node 22 fixes it).
- Manual longhand (if not using the script): `sudo chown -R zapa:zapa dist/ .astro/ && npm run build && sudo chown -R www-data:www-data dist/ && sudo rm -rf dist/photos && sudo ln -sf /var/www/alumni/public/photos dist/photos && sudo systemctl reload nginx && pm2 restart alumni-api`. (There's also a `deploy` bash alias on the server doing the chown+build+reload part, but it predates git and doesn't pull — prefer `./deploy.sh`.)

### DB backups

`backup-db.sh` (tracked) takes a **WAL-safe `sqlite3 .backup`** snapshot of `api/alumni.db`, gzips it into `backups/` (keeps newest 30), pushes a client-side-encrypted copy offsite to Google Drive via `rclone copy` to `gdrive-crypt:` (also keeps newest 30), **and mirrors `public/photos/` (image files, not in the DB) to `gdrive-crypt:photos` via `rclone sync`**. All offsite steps are non-fatal — a Drive/network failure logs but never fails the local DB backup. Scheduled via **cron for user `zapa`, daily 03:00**:

```cron
0 3 * * * /var/www/alumni/backup-db.sh >> /var/www/alumni/backups/backup.log 2>&1
```

- **What's backed up:** the DB (all records) **and** the 348 uploaded image files (~302 MB) under `public/photos/`. The DB only stores photo *filenames*; the pixels live on disk, so both are needed for a full restore.
- **Photos mirror:** `rclone sync` (deletions on the live folder propagate offsite). Guards: skips if the source dir looks empty/missing (won't wipe offsite if unmounted), and `--max-delete 100` aborts a runaway mass-deletion. First run ~13 min for 302 MB; subsequent runs near-instant (only changed files).
- **Offsite (rclone):** `gdrive-base` (Google Drive, `drive.file` scope = least privilege) wrapped by `gdrive-crypt` (client-side encryption — Google only ever stores ciphertext + encrypted filenames). Config at `~/.config/rclone/rclone.conf` (chmod 600) on the server. The crypt password + salt are held in the site owner's password manager — **required to decrypt a backup if the server is lost** (they also live obscured in `rclone.conf`, but that's gone if the box is gone).
- **Restore (local DB):** `gunzip -c backups/alumni-YYYYMMDD-HHMMSS.db.gz > api/alumni.db` (stop the API first).
- **Restore (offsite DB):** `rclone copy gdrive-crypt:alumni-YYYYMMDD-HHMMSS.db.gz /tmp/ && gunzip /tmp/alumni-*.db.gz` — the crypt remote decrypts transparently; needs `rclone.conf` (or the saved crypt password + salt on a fresh rclone setup).
- **Restore (offsite photos):** `rclone copy gdrive-crypt:photos /var/www/alumni/public/photos` — then recreate the `dist/photos` symlink if needed.
- Verified end-to-end 2026-07-10: DB download → decrypt → `integrity_check ok` (508 alumni / 110 users); photos 348 offsite = 348 live, byte-for-byte spot-check.


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
