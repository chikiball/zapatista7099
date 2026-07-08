const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const https = require("https");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

// ── Config ──────────────────────────────────────────
const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const TOKEN_EXPIRY = "7d";

// ── Database ────────────────────────────────────────
const db = new Database(path.join(__dirname, "alumni.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    google_id TEXT,
    name TEXT,
    alumni_id INTEGER REFERENCES alumni(id),
    role TEXT DEFAULT user,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add google_id column to alumni if not exists
try { db.exec("ALTER TABLE alumni ADD COLUMN google_id TEXT"); } catch(e) { /* column exists */ }
// Kelas 1 (1-1..1-12) and Kelas 2 (2-A..2-L) — editable in profile
try { db.exec("ALTER TABLE alumni ADD COLUMN class1 TEXT"); } catch(e) { /* column exists */ }
try { db.exec("ALTER TABLE alumni ADD COLUMN class2 TEXT"); } catch(e) { /* column exists */ }

// ── App Setup ───────────────────────────────────────
const app = express();
app.disable("etag"); // never let auth/session responses be conditionally cached (304)
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
// Auth responses must never be cached — a stale 401 causes "logged out" bounces
app.use("/api/auth", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

// Photo upload config
const storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, require("path").join(__dirname, "..", "public", "photos")) },
  filename: function(req, file, cb) {
    var ext = file.originalname.split(".").pop();
    cb(null, Date.now() + "-" + Math.random().toString(36).substr(2,6) + "." + ext);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 20*1024*1024 }, fileFilter: function(req,file,cb){
  if(file.mimetype.startsWith("image/")) cb(null,true); else cb(new Error("Only images allowed"));
}});

// Photos table
db.exec("CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, alumni_id INTEGER REFERENCES alumni(id), filename TEXT NOT NULL, original_name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");



// Config table
db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS event_rsvp (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER REFERENCES events(id) ON DELETE CASCADE, alumni_id INTEGER REFERENCES alumni(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_id, alumni_id))");
try { db.exec("ALTER TABLE events ADD COLUMN created_by INTEGER REFERENCES users(id)"); } catch(e) {}
try { db.exec("ALTER TABLE events ADD COLUMN cover_image TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN notify_email INTEGER DEFAULT 1"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN unsubscribe_token TEXT"); } catch(e) {}
// Class captured at signup (helps admin identify the person before linking)
try { db.exec("ALTER TABLE users ADD COLUMN reg_class1 TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN reg_class2 TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN reg_class3 TEXT"); } catch(e) {}
// Terms & Conditions acceptance — NULL means the user must still agree
try { db.exec("ALTER TABLE users ADD COLUMN tos_accepted_at TEXT"); } catch(e) {}
db.prepare("UPDATE users SET unsubscribe_token = lower(hex(randomblob(20))) WHERE unsubscribe_token IS NULL").run();

// Gallery tables
db.exec(`CREATE TABLE IF NOT EXISTS gallery_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_by INTEGER REFERENCES alumni(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
try { db.exec("ALTER TABLE gallery_folders ADD COLUMN default_layout TEXT DEFAULT 'magazine'"); } catch(e) {}
db.exec(`CREATE TABLE IF NOT EXISTS gallery_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES gallery_folders(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  caption TEXT,
  uploaded_by INTEGER REFERENCES alumni(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// Telegram notification
function sendTelegram(text) {
  try {
    var token = db.prepare("SELECT value FROM config WHERE key = 'telegram_bot_token'").get();
    var chatId = db.prepare("SELECT value FROM config WHERE key = 'telegram_chat_id'").get();
    if (!token || !chatId || !token.value || !chatId.value) return;
    var data = JSON.stringify({ chat_id: chatId.value, text: text, parse_mode: "HTML" });
    var req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + token.value + "/sendMessage",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    });
    req.on("error", function(e) { console.error("Telegram error:", e.message); });
    req.write(data);
    req.end();
  } catch(e) { console.error("Telegram error:", e); }
}


// Email notification
function sendEmail(to, subject, html) {
  try {
    var host = db.prepare("SELECT value FROM config WHERE key = 'smtp_host'").get();
    var port = db.prepare("SELECT value FROM config WHERE key = 'smtp_port'").get();
    var user = db.prepare("SELECT value FROM config WHERE key = 'smtp_user'").get();
    var pass = db.prepare("SELECT value FROM config WHERE key = 'smtp_pass'").get();
    var from = db.prepare("SELECT value FROM config WHERE key = 'smtp_from'").get();
    if (!host || !user || !pass) return;
    var transporter = nodemailer.createTransport({
      host: host.value, port: parseInt(port ? port.value : "587"),
      secure: false, auth: { user: user.value, pass: pass.value },
      tls: { rejectUnauthorized: false }
    });
    transporter.sendMail({ from: from ? from.value : user.value, to: to, subject: subject, html: html }, function(err) {
      if (err) console.error("Email error:", err.message);
    });
  } catch(e) { console.error("Email error:", e); }
}

function sendNewsletterEmail(subject, html) {
  var subscribers = db.prepare("SELECT email, unsubscribe_token FROM users WHERE status='approved' AND notify_email=1 AND email IS NOT NULL").all();
  subscribers.forEach(function(u) {
    if (!u.unsubscribe_token) return;
    var footer = '<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e7e5e4;text-align:center"><p style="font-size:11px;color:#a8a29e">Tidak ingin menerima notifikasi? <a href="https://zapa.inweb.id/api/unsubscribe?token='+u.unsubscribe_token+'" style="color:#92400e">Berhenti berlangganan</a></p></div>';
    sendEmail(u.email, subject, html + footer);
  });
}

async function geocodeCity(city, country) {
  if (!city) return null;
  const q = [city, country].filter(Boolean).join(", ");
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?q=" + encodeURIComponent(q) + "&format=json&limit=1", {
      headers: { "User-Agent": "alumni7099/1.0 (zapa.inweb.id)" }
    });
    const d = await r.json();
    if (d && d[0]) return { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) };
  } catch(e) { console.error("Geocode error:", e.message); }
  return null;
}

function emailTemplate(title, body, btnText, btnUrl) {
  return '<div style="max-width:500px;margin:0 auto;font-family:sans-serif;background:#faf8f4;padding:30px 20px">' +
    '<div style="text-align:center;margin-bottom:20px"><b style="color:#92400e;font-size:20px">Alumni SMU 70 \x2799</b></div>' +
    '<div style="background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.08)">' +
    '<h2 style="color:#292524;margin:0 0 12px">' + title + '</h2>' +
    '<div style="color:#57534e;font-size:14px;line-height:1.6">' + body + '</div>' +
    (btnText ? '<div style="text-align:center;margin-top:20px"><a href="' + btnUrl + '" style="background:#92400e;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">' + btnText + '</a></div>' : '') +
    '</div><div style="text-align:center;margin-top:16px;color:#a8a29e;font-size:11px">7099 - Alumni SMAN 70 Jakarta</div></div>';
}

// ── Auth Middleware ──────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, alumni_id: user.alumni_id, role: user.role, status: user.status || "pending" },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function setTokenCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

// Is the linked alumni profile complete? (same required fields as /api/auth/me)
function isProfileComplete(user) {
  if (!user || !user.alumni_id) return false;
  const p = db.prepare("SELECT name, city, country, job_title, class FROM alumni WHERE id = ?").get(user.alumni_id);
  if (!p) return false;
  const filled = (v) => v !== null && v !== undefined && String(v).trim() !== "";
  return ["name", "city", "country", "job_title", "class"].every((k) => filled(p[k]));
}


function approvedMiddleware(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    var u = db.prepare("SELECT status, role FROM users WHERE id = ?").get(req.user.id);
    if (!u) return res.status(401).json({ error: "User not found" });
    if (u.status !== "approved" && u.role !== "admin") return res.status(403).json({ error: "pending" });
    next();
  } catch(e) { res.status(401).json({ error: "Invalid token" }); }
}

function adminMiddleware(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    var u = db.prepare("SELECT role FROM users WHERE id = ?").get(req.user.id);
    if (!u || u.role !== "admin") return res.status(403).json({ error: "Admin only" });
    next();
  } catch(e) { res.status(401).json({ error: "Invalid token" }); }
}

// ── Match alumni by email or name ───────────────────
function findAlumniMatch(email, name) {
  // 1. Try exact email match
  let match = db.prepare("SELECT * FROM alumni WHERE LOWER(email) = LOWER(?)").get(email);
  if (match) return { match, confidence: "email_exact" };

  // 2. Try name match (fuzzy)
  if (name) {
    const nameLower = name.toLowerCase().trim();
    // Exact name match
    match = db.prepare("SELECT * FROM alumni WHERE LOWER(name) = ?").get(nameLower);
    if (match) return { match, confidence: "name_exact" };

    // Partial name match (first word matches nickname or name contains)
    const firstName = nameLower.split(/\s+/)[0];
    match = db.prepare("SELECT * FROM alumni WHERE LOWER(nickname) = ? OR LOWER(name) LIKE ?").get(firstName, `%${firstName}%`);
    if (match) return { match, confidence: "name_partial" };
  }

  return { match: null, confidence: "none" };
}

// ── AUTH ROUTES ─────────────────────────────────────

// Sign up with email/password
app.post("/api/auth/signup", (req, res) => {
  try {
    const { email, password, name, class1, class2, class3 } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!name || !name.trim()) return res.status(400).json({ error: "Nama lengkap wajib diisi" });
    const c1 = (class1 || "").trim(), c2 = (class2 || "").trim(), c3 = (class3 || "").trim();
    if (!c1 && !c2 && !c3) return res.status(400).json({ error: "Isi minimal salah satu Kelas (1, 2, atau 3)" });

    // Check if user exists
    const existing = db.prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)").get(email);
    if (existing) return res.status(409).json({ error: "Email already registered. Try logging in." });

    // Try to match with existing alumni
    const { match, confidence } = findAlumniMatch(email, name);
    const password_hash = bcrypt.hashSync(password, 10);

    const result = db.prepare(
      "INSERT INTO users (email, password_hash, name, alumni_id, status, reg_class1, reg_class2, reg_class3) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)"
    ).run(email.toLowerCase(), password_hash, name.trim(), match ? match.id : null, c1 || null, c2 || null, c3 || null);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
    const token = generateToken(user);
    setTokenCookie(res, token);

    const kelasStr = [c1, c2, c3].filter(Boolean).join(" / ");
    sendEmail(email, "Pendaftaran Berhasil - Alumni 7099",
      emailTemplate("Pendaftaran Berhasil! 🎉",
        "Halo " + (name || "Alumni") + ",<br><br>Akun kamu berhasil dibuat. Saat ini akun kamu sedang <b>menunggu persetujuan admin</b>.<br><br>Kamu akan menerima email lagi ketika akun kamu sudah disetujui.",
        "Kunjungi Website", "https://zapa.inweb.id"));
    sendTelegram("🆕 <b>Pendaftaran Baru!</b>\n" +
      "Nama: " + (name || "-") + "\n" +
      "Kelas: " + (kelasStr || "-") + "\n" +
      "Email: " + email + "\n" +
      "Metode: Email/Password\n" +
      (match ? "✅ Matched: " + match.name + " (" + (match.nickname||"") + ")\n" : "❌ No alumni match\n") +
      "Status: ⏳ Pending\n" +
      "👉 https://zapa.inweb.id/admin");
    res.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, alumni_id: user.alumni_id },
      alumni_match: match ? { id: match.id, name: match.name, nickname: match.nickname, confidence } : null,
    });
  } catch(e) {
    console.error("Signup error:", e);
    res.status(500).json({ error: "Signup failed" });
  }
});

// Login with email/password
app.post("/api/auth/login", (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const user = db.prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?)").get(email);
    if (!user) return res.status(401).json({ error: "Email not found. Try signing up." });
    if (!user.password_hash) return res.status(401).json({ error: "This account uses Google login" });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: "Wrong password" });

    const token = generateToken(user);
    setTokenCookie(res, token);

    res.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, alumni_id: user.alumni_id },
      profile_complete: isProfileComplete(user),
    });
  } catch(e) {
    console.error("Login error:", e);
    res.status(500).json({ error: "Login failed" });
  }
});

// Google Sign-In (verify Google token from frontend)
app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: "Google credential required" });

    // Decode the JWT from Google (header.payload.signature)
    const payload = JSON.parse(Buffer.from(credential.split(".")[1], "base64").toString());
    const { sub: googleId, email, name, picture } = payload;

    if (!email) return res.status(400).json({ error: "Could not get email from Google" });

    // Check if user exists
    let user = db.prepare("SELECT * FROM users WHERE google_id = ? OR LOWER(email) = LOWER(?)").get(googleId, email);
    var isNewUser = !user;

    if (user) {
      // Update google_id if not set
      if (!user.google_id) {
        db.prepare("UPDATE users SET google_id = ?, name = COALESCE(name, ?) WHERE id = ?").run(googleId, name, user.id);
      }
    } else {
      // New user - try to match alumni
      const { match, confidence } = findAlumniMatch(email, name);
      db.prepare(
        "INSERT INTO users (email, google_id, name, alumni_id, status) VALUES (?, ?, ?, ?, 'pending')"
      ).run(email.toLowerCase(), googleId, name, match ? match.id : null);
      user = db.prepare("SELECT * FROM users WHERE google_id = ?").get(googleId);
    }

    const token = generateToken(user);
    setTokenCookie(res, token);

    const alumniMatch = user.alumni_id ? db.prepare("SELECT * FROM alumni WHERE id = ?").get(user.alumni_id) : null;

    // Notify only on NEW Google signup (not returning users)
    if (isNewUser) {
      sendEmail(email, "Pendaftaran Berhasil - Alumni 7099",
      emailTemplate("Pendaftaran Berhasil! 🎉",
        "Halo " + (name || "Alumni") + ",<br><br>Akun kamu berhasil dibuat. Saat ini akun kamu sedang <b>menunggu persetujuan admin</b>.<br><br>Kamu akan menerima email lagi ketika akun kamu sudah disetujui.",
        "Kunjungi Website", "https://zapa.inweb.id"));
    sendTelegram("🆕 <b>Pendaftaran Baru!</b>\n" +
        "Nama: " + (name || "-") + "\n" +
        "Kelas: ⏳ menunggu diisi di form\n" +
        "Email: " + email + "\n" +
        "Metode: Google\n" +
        (alumniMatch ? "✅ Matched: " + alumniMatch.name + " (" + (alumniMatch.nickname||"") + ")\n" : "❌ No alumni match\n") +
        "Status: ⏳ Pending\n" +
        "👉 https://zapa.inweb.id/admin");
    }
    res.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, alumni_id: user.alumni_id },
      profile_complete: isProfileComplete(user),
      token, // returned so the post-Google completion call can use Bearer (Safari private-mode safe)
      // Show the name/kelas modal whenever it hasn't been captured yet — regardless of
      // any (possibly wrong, fuzzy) alumni match — for new signups or still-unlinked users,
      // so admins always get identifying info. Established linked users aren't pestered.
      needs_reg_info: !(user.reg_class1 || user.reg_class2 || user.reg_class3) && (isNewUser || !user.alumni_id),
      alumni_match: alumniMatch ? { id: alumniMatch.id, name: alumniMatch.name, nickname: alumniMatch.nickname } : null,
    });
  } catch(e) {
    console.error("Google auth error:", e);
    res.status(500).json({ error: "Google authentication failed" });
  }
});

// Post-Google completion: capture full name + >=1 Kelas for a new Google user
// (Google Sign-In has no form, so this collects what email/password signup requires).
app.post("/api/auth/complete-registration", authMiddleware, (req, res) => {
  try {
    const { name, class1, class2, class3 } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Nama lengkap wajib diisi" });
    const c1 = (class1 || "").trim(), c2 = (class2 || "").trim(), c3 = (class3 || "").trim();
    if (!c1 && !c2 && !c3) return res.status(400).json({ error: "Isi minimal salah satu Kelas (1, 2, atau 3)" });

    // Snapshot before update so we only notify on the FIRST completion (avoid
    // re-notifying if an unmatched user re-opens the modal on a later login).
    const before = db.prepare("SELECT email, alumni_id, reg_class1, reg_class2, reg_class3 FROM users WHERE id = ?").get(req.user.id);
    const alreadyCompleted = !!(before && (before.reg_class1 || before.reg_class2 || before.reg_class3));

    db.prepare("UPDATE users SET name = ?, reg_class1 = ?, reg_class2 = ?, reg_class3 = ? WHERE id = ?")
      .run(name.trim(), c1 || null, c2 || null, c3 || null, req.user.id);

    // Now that we have the final name + kelas from the modal, send the complete
    // Telegram alert (the Google signup alert fired earlier without kelas).
    if (before && !alreadyCompleted) {
      const kelasStr = [c1, c2, c3].filter(Boolean).join(" / ");
      const alumniMatch = before.alumni_id ? db.prepare("SELECT name, nickname FROM alumni WHERE id = ?").get(before.alumni_id) : null;
      sendTelegram("✅ <b>Data Pendaftaran Dilengkapi (Google)</b>\n" +
        "Nama: " + name.trim() + "\n" +
        "Kelas: " + (kelasStr || "-") + "\n" +
        "Email: " + before.email + "\n" +
        "Metode: Google\n" +
        (alumniMatch ? "✅ Matched: " + alumniMatch.name + " (" + (alumniMatch.nickname||"") + ")\n" : "❌ No alumni match\n") +
        "Status: ⏳ Pending\n" +
        "👉 https://zapa.inweb.id/admin");
    }
    res.json({ success: true });
  } catch(e) {
    console.error("complete-registration error:", e);
    res.status(500).json({ error: "Failed to save" });
  }
});

// Record Terms & Conditions acceptance for the logged-in user
app.post("/api/auth/accept-tos", authMiddleware, (req, res) => {
  try {
    db.prepare("UPDATE users SET tos_accepted_at = datetime('now') WHERE id = ? AND tos_accepted_at IS NULL").run(req.user.id);
    res.json({ success: true });
  } catch(e) {
    console.error("accept-tos error:", e);
    res.status(500).json({ error: "Failed to save" });
  }
});

// Get current user
app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT id, email, name, alumni_id, role, status, created_at, notify_email, (password_hash IS NOT NULL) AS has_password, (tos_accepted_at IS NOT NULL) AS tos_accepted FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  let profile = null;
  if (user.alumni_id) {
    profile = db.prepare("SELECT * FROM alumni WHERE id = ?").get(user.alumni_id);
  }
  // Profile completeness — core fields that power the Map, Directory & Stats.
  // missing_fields lists only the empty required ones (so the UI can nudge specifics).
  const REQUIRED = [
    { key: "name", label: "Nama" },
    { key: "city", label: "Kota" },
    { key: "country", label: "Negara" },
    { key: "job_title", label: "Pekerjaan" },
    { key: "class", label: "Kelas" },
  ];
  const isFilled = (v) => v !== null && v !== undefined && String(v).trim() !== "";
  const missing_fields = REQUIRED.filter((f) => !(profile && isFilled(profile[f.key])));
  const profile_complete = missing_fields.length === 0;
  res.json({ user, profile, profile_complete, missing_fields });
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

// ── PROFILE ROUTES ──────────────────────────────────

// Get profile
app.get("/api/profile", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  let profile = null;
  if (user.alumni_id) {
    profile = db.prepare("SELECT * FROM alumni WHERE id = ?").get(user.alumni_id);
  }
  res.json({ user: { id: user.id, email: user.email, name: user.name }, profile });
});

app.put("/api/profile/notifications", approvedMiddleware, (req, res) => {
  const { notify_email } = req.body;
  db.prepare("UPDATE users SET notify_email=? WHERE id=?").run(notify_email ? 1 : 0, req.user.id);
  res.json({ success: true });
});

app.get("/api/unsubscribe", (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Link tidak valid");
  const user = db.prepare("SELECT id, email FROM users WHERE unsubscribe_token=?").get(token);
  if (!user) return res.status(404).send("Link tidak valid");
  db.prepare("UPDATE users SET notify_email=0 WHERE id=?").run(user.id);
  res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribe - 7099</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#faf8f4"><div style="max-width:400px;margin:0 auto;background:white;border-radius:16px;padding:40px;box-shadow:0 2px 8px rgba(0,0,0,.08)"><h2 style="color:#92400e;margin-bottom:8px">Berhasil &#10003;</h2><p style="color:#57534e;margin-bottom:16px">Email <b>'+user.email+'</b> tidak akan menerima notifikasi lagi.</p><p style="font-size:13px;color:#a8a29e">Kamu bisa mengaktifkan kembali notifikasi kapan saja melalui halaman Profil.</p><a href="https://zapa.inweb.id" style="display:inline-block;margin-top:24px;background:#92400e;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:14px">Kembali ke 7099</a></div></body></html>');
});

// Update or create profile
app.put("/api/profile", approvedMiddleware, async (req, res) => {
  try {
    const { name, nickname, phone, city, country, job_title, company, bio, birthday, gender, address, hobby, university, class: kelas, class1, class2 } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);

    if (user.alumni_id) {
      const existing = db.prepare("SELECT city, latitude FROM alumni WHERE id = ?").get(user.alumni_id);
      db.prepare(`
        UPDATE alumni SET name=?, nickname=?, phone=?, city=?, country=?, job_title=?, company=?, bio=?, birthday=?, gender=?, address=?, hobby=?, university=?, class=?, class1=?, class2=?
        WHERE id=?
      `).run(name, nickname, phone, city, country, job_title, company, bio, birthday, gender, address, hobby, university, kelas, class1, class2, user.alumni_id);
      if (city && (!existing.latitude || existing.city !== city)) {
        geocodeCity(city, country).then(c => {
          if (c) db.prepare("UPDATE alumni SET latitude=?, longitude=? WHERE id=?").run(c.lat, c.lon, user.alumni_id);
        }).catch(() => {});
      }
    } else {
      const result = db.prepare(`
        INSERT INTO alumni (name, nickname, email, phone, city, country, job_title, company, bio, is_public, birthday, gender, address, hobby, university, class, class1, class2)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, nickname, user.email, phone, city, country, job_title, company, bio, birthday, gender, address, hobby, university, kelas, class1, class2);
      db.prepare("UPDATE users SET alumni_id = ?, name = ? WHERE id = ?").run(result.lastInsertRowid, name, user.id);
      if (city) {
        const newId = result.lastInsertRowid;
        geocodeCity(city, country).then(c => {
          if (c) db.prepare("UPDATE alumni SET latitude=?, longitude=? WHERE id=?").run(c.lat, c.lon, newId);
        }).catch(() => {});
      }
    }

    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, user.id);

    const profile = user.alumni_id
      ? db.prepare("SELECT * FROM alumni WHERE id = ?").get(user.alumni_id)
      : db.prepare("SELECT * FROM alumni WHERE email = ?").get(user.email);

    res.json({ success: true, profile });
  } catch(e) {
    console.error("Profile update error:", e);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// Search alumni (for matching)
app.get("/api/alumni/search", approvedMiddleware, (req, res) => {
  const q = req.query.q || "";
  if (q.length < 2) return res.json([]);
  const results = db.prepare(
    "SELECT id, name, nickname, city FROM alumni WHERE name LIKE ? OR nickname LIKE ? LIMIT 10"
  ).all(`%${q}%`, `%${q}%`);
  res.json(results);
});

// Link user to existing alumni
app.post("/api/profile/link", approvedMiddleware, (req, res) => {
  const { alumni_id } = req.body;
  const alumni = db.prepare("SELECT * FROM alumni WHERE id = ?").get(alumni_id);
  if (!alumni) return res.status(404).json({ error: "Alumni not found" });

  db.prepare("UPDATE users SET alumni_id = ?, name = ? WHERE id = ?").run(alumni_id, alumni.name, req.user.id);
  res.json({ success: true, profile: alumni });
});


// ── PHOTO ROUTES ────────────────────────────────────

// Upload photos
app.post("/api/profile/photos", approvedMiddleware, upload.array("photos", 10), (req, res) => {
  try {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!user || !user.alumni_id) return res.status(400).json({ error: "No profile linked" });
    const insert = db.prepare("INSERT INTO photos (alumni_id, filename, original_name) VALUES (?, ?, ?)");
    const saved = [];
    for (const file of req.files) {
      insert.run(user.alumni_id, file.filename, file.originalname);
      saved.push({ filename: file.filename, original_name: file.originalname });
    }
    res.json({ success: true, photos: saved });
  } catch(e) {
    console.error("Photo upload error:", e);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Get photos for current user
app.get("/api/profile/photos", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user || !user.alumni_id) return res.json([]);
  const photos = db.prepare("SELECT * FROM photos WHERE alumni_id = ? ORDER BY created_at DESC").all(user.alumni_id);
  res.json(photos);
});

// Delete a photo
app.delete("/api/profile/photos/:id", approvedMiddleware, (req, res) => {
  const photo = db.prepare("SELECT * FROM photos WHERE id = ?").get(req.params.id);
  if (!photo) return res.status(404).json({ error: "Photo not found" });
  try { fs.unlinkSync(require("path").join(__dirname, "..", "public", "photos", photo.filename)); } catch(e) {}
  db.prepare("DELETE FROM photos WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});


// Directory (login required)
app.get("/api/directory", approvedMiddleware, (req, res) => {
  const alumni = db.prepare("SELECT id, name, nickname, city, country, job_title, company, class, class1, class2, hobby, university, bio FROM alumni WHERE is_public = 1 ORDER BY name").all();
  const photos = db.prepare("SELECT alumni_id, filename FROM photos ORDER BY created_at DESC").all();
  const photoMap = {};
  photos.forEach(p => { if(!photoMap[p.alumni_id]) photoMap[p.alumni_id] = p.filename; });
  alumni.forEach(a => { a.photo = photoMap[a.id] || null; });
  res.json(alumni);
});


// ── ARTICLE ROUTES ──────────────────────────────────

// List published articles (public)
app.get("/api/articles", (req, res) => {
  var articles = db.prepare("SELECT a.*, al.name as author_name, al.nickname as author_nick FROM articles a LEFT JOIN alumni al ON a.author_id = al.id WHERE a.status = 'published' ORDER BY a.published_at DESC").all();
  res.json(articles);
});

// Single article (public if published)
app.get("/api/articles/:id", (req, res) => {
  var a = db.prepare("SELECT a.*, al.name as author_name, al.nickname as author_nick FROM articles a LEFT JOIN alumni al ON a.author_id = al.id WHERE a.id = ?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  if (a.status !== "published") {
    var token = req.cookies.token || (req.headers.authorization || "").replace("Bearer ", "");
    try { var user = jwt.verify(token, JWT_SECRET); if (a.author_id !== user.alumni_id && user.role !== "admin") return res.status(404).json({ error: "Not found" }); }
    catch(e) { return res.status(404).json({ error: "Not found" }); }
  }
  res.json(a);
});

// My articles (drafts + published)
app.get("/api/articles/mine/list", approvedMiddleware, (req, res) => {
  var user = db.prepare("SELECT alumni_id FROM users WHERE id = ?").get(req.user.id);
  if (!user || !user.alumni_id) return res.json([]);
  res.json(db.prepare("SELECT * FROM articles WHERE author_id = ? ORDER BY created_at DESC").all(user.alumni_id));
});

// Create article
app.post("/api/articles", approvedMiddleware, (req, res) => {
  var user = db.prepare("SELECT alumni_id FROM users WHERE id = ?").get(req.user.id);
  if (!user || !user.alumni_id) return res.status(400).json({ error: "No profile" });
  var { title, content, status } = req.body;
  if (!title) return res.status(400).json({ error: "Title required" });
  var now = new Date().toISOString();
  var pub = status === "published" ? now : null;
  var result = db.prepare("INSERT INTO articles (author_id, title, content, status, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(user.alumni_id, title, content || "", status || "draft", pub, now, now);
  if (status === "published") {
    var author = db.prepare("SELECT name, nickname FROM alumni WHERE id=?").get(user.alumni_id);
    var authorName = author ? (author.nickname || author.name) : "Alumni";
    var excerpt = (content || "").replace(/\[foto:[^\]]+\]/g,"").trim().substring(0,150);
    sendNewsletterEmail("Artikel Baru: " + title, emailTemplate("Artikel Baru di 7099 ✍️", "<b>" + authorName + "</b> baru saja menerbitkan artikel baru:<br><br><b style='font-size:16px'>" + title + "</b>" + (excerpt ? "<br><br><span style='color:#57534e;font-size:14px'>" + excerpt + (excerpt.length >= 150 ? "..." : "") + "</span>" : ""), "Baca Sekarang", "https://zapa.inweb.id/articles"));
  }
  res.json({ success: true, id: result.lastInsertRowid });
});

// Update article
app.put("/api/articles/:id", approvedMiddleware, (req, res) => {
  var user = db.prepare("SELECT alumni_id FROM users WHERE id = ?").get(req.user.id);
  var article = db.prepare("SELECT * FROM articles WHERE id = ?").get(req.params.id);
  if (!article) return res.status(404).json({ error: "Not found" });
  if (article.author_id !== user.alumni_id && req.user.role !== "admin") return res.status(403).json({ error: "Not yours" });
  var { title, content, status } = req.body;
  var now = new Date().toISOString();
  var pub = status === "published" && !article.published_at ? now : article.published_at;
  var isFirstPublish = status === "published" && !article.published_at;
  db.prepare("UPDATE articles SET title=?, content=?, status=?, published_at=?, updated_at=? WHERE id=?").run(title, content, status, pub, now, req.params.id);
  if (isFirstPublish) {
    var author = db.prepare("SELECT name, nickname FROM alumni WHERE id=?").get(user.alumni_id);
    var authorName = author ? (author.nickname || author.name) : "Alumni";
    var excerpt = (content || "").replace(/\[foto:[^\]]+\]/g,"").trim().substring(0,150);
    sendNewsletterEmail("Artikel Baru: " + title, emailTemplate("Artikel Baru di 7099 ✍️", "<b>" + authorName + "</b> baru saja menerbitkan artikel baru:<br><br><b style='font-size:16px'>" + title + "</b>" + (excerpt ? "<br><br><span style='color:#57534e;font-size:14px'>" + excerpt + (excerpt.length >= 150 ? "..." : "") + "</span>" : ""), "Baca Sekarang", "https://zapa.inweb.id/articles"));
  }
  res.json({ success: true });
});

// Delete article
app.delete("/api/articles/:id", approvedMiddleware, (req, res) => {
  var user = db.prepare("SELECT alumni_id FROM users WHERE id = ?").get(req.user.id);
  var article = db.prepare("SELECT * FROM articles WHERE id = ?").get(req.params.id);
  if (!article) return res.status(404).json({ error: "Not found" });
  if (article.author_id !== user.alumni_id && req.user.role !== "admin") return res.status(403).json({ error: "Not yours" });
  db.prepare("DELETE FROM articles WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Upload cover image
app.post("/api/articles/:id/cover", approvedMiddleware, upload.single("cover"), async (req, res) => {
  var user = db.prepare("SELECT alumni_id FROM users WHERE id = ?").get(req.user.id);
  var article = db.prepare("SELECT * FROM articles WHERE id = ?").get(req.params.id);
  if (!article || (article.author_id !== user.alumni_id && req.user.role !== "admin")) return res.status(403).json({ error: "Not allowed" });
  // Resize cover
    var outName = "cover-" + Date.now() + ".jpg";
    var outPath = require("path").join(__dirname, "..", "public", "photos", outName);
    await sharp(req.file.path).resize(800, null, { withoutEnlargement: true, fit: "inside" }).jpeg({ quality: 80 }).toFile(outPath);
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    db.prepare("UPDATE articles SET cover_image = ? WHERE id = ?").run(outName, req.params.id);
    res.json({ success: true, filename: outName });
});


// Upload inline image for article (resized to max 800px wide)
app.post("/api/articles/upload-image", approvedMiddleware, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    var ext = req.file.originalname.split(".").pop().toLowerCase();
    var outName = Date.now() + "-" + Math.random().toString(36).substr(2,6) + ".jpg";
    var outPath = require("path").join(__dirname, "..", "public", "photos", outName);
    await sharp(req.file.path).resize(800, null, { withoutEnlargement: true, fit: "inside" }).jpeg({ quality: 80 }).toFile(outPath);
    // Remove original
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.json({ success: true, url: "/photos/" + outName, filename: outName });
  } catch(e) {
    console.error("Image upload error:", e);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ── PUBLIC ROUTES ───────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/stats", (req, res) => {
  res.json({
    total_alumni: db.prepare("SELECT COUNT(*) as c FROM alumni WHERE is_public = 1").get().c,
    total_cities: db.prepare("SELECT COUNT(DISTINCT city) as c FROM alumni WHERE is_public = 1 AND city IS NOT NULL AND city != ''").get().c,
    total_industries: db.prepare("SELECT COUNT(DISTINCT company) as c FROM alumni WHERE is_public = 1 AND company IS NOT NULL AND company != ''").get().c,
    total_countries: db.prepare("SELECT COUNT(DISTINCT country) as c FROM alumni WHERE is_public = 1 AND country IS NOT NULL AND country != ''").get().c,
  });
});

app.get("/api/alumni", (req, res) => {
  const alumni = db.prepare("SELECT id, name, nickname, city, country, university, job_title, company, industry FROM alumni WHERE is_public = 1").all();
  res.json(alumni);
});

app.get("/api/map", (req, res) => {
  const locations = db.prepare("SELECT name, nickname, city, country, latitude, longitude, job_title FROM alumni WHERE latitude IS NOT NULL AND is_public = 1").all();
  res.json(locations);
});


// Detailed stats for statistics page
app.get("/api/stats/detail", (req, res) => {
  const all = db.prepare("SELECT * FROM alumni WHERE is_public = 1").all();
  
  // Class distribution — REGISTERED users only (roster import adds many
  // non-registered alumni, which would otherwise skew IPA/IPS + Kelas Paling Rame)
  const regAlumniIds = new Set(
    db.prepare("SELECT alumni_id FROM users WHERE alumni_id IS NOT NULL").all().map(r => r.alumni_id)
  );
  const classes = {};
  let ipaTotal=0, ipsTotal=0;
  all.forEach(a => {
    if(a.class && regAlumniIds.has(a.id)){classes[a.class]=(classes[a.class]||0)+1;if(a.class.startsWith("IPA"))ipaTotal++;else if(a.class.startsWith("IPS"))ipsTotal++;}
  });

  // Cities
  const cities = {};
  all.forEach(a => { if(a.city) cities[a.city.trim()]=(cities[a.city.trim()]||0)+1; });

  // Countries
  const countries = {};
  all.forEach(a => { if(a.country) countries[a.country.trim()]=(countries[a.country.trim()]||0)+1; });

  // Jobs - normalize
  const jobs = {};
  const jobMap = {"swata":"Swasta","swasta":"Swasta","pegawai swasta":"Swasta","karyawan swasta":"Swasta","karyawan":"Swasta","bumn":"BUMN","pns":"PNS","wirausaha":"Wirausaha","wiraswasta":"Wirausaha","wiraswata":"Wirausaha","guru":"Guru/Dosen","dosen":"Guru/Dosen","dokter":"Dokter","polri":"TNI/Polri","housewife":"Ibu Rumah Tangga","irt":"Ibu Rumah Tangga","ibu rumah tangga":"Ibu Rumah Tangga","ibu rmh tangga":"Ibu Rumah Tangga","pensiunan":"Pensiunan"};
  all.forEach(a => {
    if(a.job_title){
      var j=a.job_title.trim().toLowerCase();
      var norm=jobMap[j]||a.job_title.trim();
      jobs[norm]=(jobs[norm]||0)+1;
    }
  });

  // Industry/Company - normalized
  const industries = {};
  const indMap = {"pt petrindo semesta":"Manufacturing","pink tank":"Lainnya","al adzkar modern islamic boarding school":"Pendidikan","rumah":"Ibu Rumah Tangga","puskesmas":"Kesehatan","asuransi":"Asuransi","jasa perparkiran":"Jasa","perbankan":"Perbankan","life products":"Retail","teknologi informasi":"IT/Teknologi","penerbangan":"Transportasi","management training":"Pendidikan","seni budaya":"Seni & Budaya","kesehatan":"Kesehatan","konstruksi dan konsultan teknik":"Konstruksi","coal mining":"Pertambangan","konsultan, agensi, teknikal":"Konsultan","pemerintahan":"Pemerintahan","keuangan":"Keuangan","legislatif":"Pemerintahan","ngo":"NGO/Nonprofit","hukum":"Hukum","petronas":"Energi","badan informasi geospasial":"Pemerintahan","kuliner & jasa pendidikan":"Kuliner","travel haji dan umroh":"Travel","das map":"Jasa","desain & konstruksi":"Konstruksi","pendidikan":"Pendidikan","perdagangan":"Perdagangan","konsultan":"Konsultan","media":"Media","ajb bumiputera 1912":"Asuransi","pt.aj.manulife indonesia":"Asuransi"};
  all.forEach(a => {
    if(a.company && a.company.trim()){
      var c=a.company.trim();
      var key=c.toLowerCase();
      var norm=indMap[key]||c;
      industries[norm]=(industries[norm]||0)+1;
    }
  });

  // Universities - normalized
  const unis = {};
  const uniMap = {"university of indonesia":"UI","universitas indonesia":"UI","ui":"UI","itb":"ITB","bandung institute of technology":"ITB","institut teknologi bandung":"ITB","institute teknologi bandung":"ITB","ugm":"UGM","universitas gadjah mada":"UGM","universitas gajah mada":"UGM","gadjah mada university":"UGM","gajah mada university":"UGM","universitas trisakti":"Trisakti","trisakti":"Trisakti","universitas padjadjaran":"UNPAD","unpad":"UNPAD","universitas diponegoro":"UNDIP","undip":"UNDIP","universitas airlangga":"UNAIR","unair":"UNAIR","universitas brawijaya":"UB","ub":"UB","binus":"BINUS","binus university":"BINUS","universitas bina nusantara":"BINUS","ipb":"IPB","institut pertanian bogor":"IPB","its":"ITS","institut teknologi sepuluh nopember":"ITS","universitas pelita harapan":"UPH","uph":"UPH","universitas gunadarma":"Gunadarma","gunadarma":"Gunadarma","stie":"STIE","universitas pancasila":"Universitas Pancasila","universitas yarsi":"Universitas Yarsi"};
  all.forEach(a => {
    if(a.university){
      a.university.split(",").forEach(u => {
        var t=u.trim();
        if(!t)return;
        var key=t.toLowerCase();
        var norm=uniMap[key]||t;
        unis[norm]=(unis[norm]||0)+1;
      });
    }
  });

  // Hobbies
  const hobbies = {};
  all.forEach(a => {
    var h=a.hobby||a.bio||"";
    h.split(",").forEach(x => {
      var t=x.trim().toLowerCase();if(t&&t.length>1)hobbies[t]=(hobbies[t]||0)+1;
    });
  });

  // Zodiac from birthday
  const zodiacs = {};
  const months = {};
  const bdayThisMonth = [];
  const now = new Date();
  const curMonth = now.getMonth();
  
  const zodiacRanges = [
    {name:"Capricorn",icon:"♑",s:1222,e:119},{name:"Aquarius",icon:"♒",s:120,e:218},
    {name:"Pisces",icon:"♓",s:219,e:320},{name:"Aries",icon:"♈",s:321,e:419},
    {name:"Taurus",icon:"♉",s:420,e:520},{name:"Gemini",icon:"♊",s:521,e:620},
    {name:"Cancer",icon:"♋",s:621,e:722},{name:"Leo",icon:"♌",s:723,e:822},
    {name:"Virgo",icon:"♍",s:823,e:922},{name:"Libra",icon:"♎",s:923,e:1022},
    {name:"Scorpio",icon:"♏",s:1023,e:1121},{name:"Sagittarius",icon:"♐",s:1122,e:1221}
  ];
  const monthNames = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];

  all.forEach(a => {
    if(!a.birthday) return;
    // Parse various date formats
    var bd = a.birthday;
    var m=null, d=null;
    // Try "DD Month YYYY" or "DD-Mon-YY" or ISO
    var parts;
    var mMap={"januari":0,"februari":1,"maret":2,"april":3,"mei":4,"juni":5,"juli":6,"agustus":7,"september":8,"oktober":9,"november":10,"desember":11,"jan":0,"feb":1,"mar":2,"apr":3,"may":4,"jun":5,"jul":6,"aug":7,"sep":8,"oct":9,"nov":10,"dec":11};
    
    if(bd.match(/^\d{4}-\d{2}-\d{2}/)){
      var p=bd.split("-");m=parseInt(p[1])-1;d=parseInt(p[2]);
    } else if(parts=bd.match(/(\d+)[\s-]+([a-zA-Z]+)[\s-]+(\d+)/)){
      d=parseInt(parts[1]);m=mMap[parts[2].toLowerCase()];
    }
    
    if(m===null||m===undefined||d===null)return;
    
    months[monthNames[m]]=(months[monthNames[m]]||0)+1;
    
    // Zodiac
    var md=(m+1)*100+d;
    for(var z of zodiacRanges){
      if(z.s>z.e){if(md>=z.s||md<=z.e){zodiacs[z.icon+" "+z.name]=(zodiacs[z.icon+" "+z.name]||0)+1;break}}
      else{if(md>=z.s&&md<=z.e){zodiacs[z.icon+" "+z.name]=(zodiacs[z.icon+" "+z.name]||0)+1;break}}
    }
    
    // Birthday this month
    if(m===curMonth) bdayThisMonth.push({name:a.name,nickname:a.nickname,day:d});
  });

  // Farthest from Jakarta (-6.2, 106.8)
  const jktLat=-6.2,jktLng=106.8;
  const farthest = all.filter(a=>a.latitude&&a.longitude).map(a=>{
    var R=6371;var dLat=(a.latitude-jktLat)*Math.PI/180;var dLon=(a.longitude-jktLng)*Math.PI/180;
    var aa=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(jktLat*Math.PI/180)*Math.cos(a.latitude*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
    var c=2*Math.atan2(Math.sqrt(aa),Math.sqrt(1-aa));
    return{name:a.name,nickname:a.nickname,city:a.city,country:a.country,km:Math.round(R*c)};
  }).sort((a,b)=>b.km-a.km).slice(0,10);

  // Registered users count
  const registered = db.prepare("SELECT COUNT(*) as c FROM users").get().c;

  res.json({
    total:all.length, registered,
    ipa:ipaTotal, ips:ipsTotal,
    classes, cities, countries, jobs, industries, unis, hobbies,
    zodiacs, months, bdayThisMonth: bdayThisMonth.sort((a,b)=>a.day-b.day),
    farthest
  });
});



// Forgot password
app.post("/api/auth/forgot-password", (req, res) => {
  try {
    var { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    var user = db.prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?)").get(email);
    if (!user) return res.json({ success: true }); // Don't reveal if email exists
    if (!user.password_hash) return res.json({ success: true }); // Google users can't reset
    var token = crypto.randomBytes(32).toString("hex");
    var expires = new Date(Date.now() + 3600000).toISOString(); // 1 hour
    db.prepare("UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?").run(token, expires, user.id);
    sendEmail(user.email, "Reset Password - Alumni 7099",
      emailTemplate("Reset Password",
        "Halo " + (user.name || "Alumni") + ",<br><br>Kamu meminta reset password. Klik tombol di bawah untuk membuat password baru. Link ini berlaku <b>1 jam</b>.<br><br>Jika kamu tidak meminta ini, abaikan email ini.",
        "Reset Password", "https://zapa.inweb.id/reset?token=" + token));
    res.json({ success: true });
  } catch(e) { console.error("Forgot password error:", e); res.status(500).json({ error: "Failed" }); }
});

// Reset password
app.post("/api/auth/reset-password", (req, res) => {
  try {
    var { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password min 6 characters" });
    var user = db.prepare("SELECT * FROM users WHERE reset_token = ?").get(token);
    if (!user) return res.status(400).json({ error: "Invalid or expired link" });
    if (new Date(user.reset_expires) < new Date()) return res.status(400).json({ error: "Link expired" });
    var hash = bcrypt.hashSync(password, 10);
    db.prepare("UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?").run(hash, user.id);
    res.json({ success: true });
  } catch(e) { console.error("Reset password error:", e); res.status(500).json({ error: "Failed" }); }
});

// Change password (logged in). Sets a new password; if the account already has one,
// the current password must be provided and match. Google-only accounts can set one
// without a current password (gains an email-login fallback).
app.post("/api/auth/change-password", authMiddleware, (req, res) => {
  try {
    var { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: "Password baru minimal 6 karakter" });
    var user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.password_hash) {
      if (!current_password) return res.status(400).json({ error: "Password saat ini wajib diisi" });
      if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: "Password saat ini salah" });
    }
    var hash = bcrypt.hashSync(new_password, 10);
    db.prepare("UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?").run(hash, user.id);
    res.json({ success: true, had_password: !!user.password_hash });
  } catch(e) { console.error("Change password error:", e); res.status(500).json({ error: "Gagal mengubah password" }); }
});

// ── ADMIN ROUTES ────────────────────────────────────

app.get("/api/admin/dashboard", adminMiddleware, (req, res) => {
  res.json({
    total_alumni: db.prepare("SELECT COUNT(*) as c FROM alumni").get().c,
    total_users: db.prepare("SELECT COUNT(*) as c FROM users").get().c,
    pending_users: db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'pending'").get().c,
    approved_users: db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'approved'").get().c,
    rejected_users: db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'rejected'").get().c,
    total_photos: db.prepare("SELECT COUNT(*) as c FROM photos").get().c,
    total_cities: db.prepare("SELECT COUNT(DISTINCT city) as c FROM alumni WHERE city IS NOT NULL AND city != ''").get().c,
  });
});

app.get("/api/admin/pending", adminMiddleware, (req, res) => {
  const users = db.prepare("SELECT u.id, u.email, u.name, u.google_id, u.alumni_id, u.status, u.created_at, u.reg_class1, u.reg_class2, u.reg_class3, a.name as alumni_name, a.nickname as alumni_nick, a.city as alumni_city FROM users u LEFT JOIN alumni a ON u.alumni_id = a.id WHERE u.status = 'pending' ORDER BY u.created_at DESC").all();
  res.json(users);
});

// ── Events ──────────────────────────────────────────
app.get("/api/events", (req, res) => {
  let alumniId = null;
  try {
    const token = req.cookies.token;
    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);
      const u = db.prepare("SELECT alumni_id, status FROM users WHERE id = ?").get(decoded.id);
      if (u && u.status === "approved" && u.alumni_id) alumniId = u.alumni_id;
    }
  } catch(e) {}
  const events = db.prepare("SELECT e.*, u.name as created_by_name FROM events e LEFT JOIN users u ON u.id = e.created_by ORDER BY e.event_date ASC").all();
  let userId = null;
  try {
    const token = req.cookies.token;
    if (token) { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.id; }
  } catch(e) {}
  res.json(events.map(ev => Object.assign({}, ev, {
    rsvped: alumniId ? !!db.prepare("SELECT 1 FROM event_rsvp WHERE event_id=? AND alumni_id=?").get(ev.id, alumniId) : false,
    can_edit: userId ? (ev.created_by === userId || !!db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin'").get(userId)) : false
  })));
});

app.post("/api/events", approvedMiddleware, (req, res) => {
  const { title, description, event_date, location } = req.body;
  const r = db.prepare("INSERT INTO events (title, description, event_date, location, rsvp_count, created_by) VALUES (?,?,?,?,0,?)").run(title, description, event_date, location, req.user.id);
  var dateStr = event_date ? new Date(event_date).toLocaleDateString('id-ID',{weekday:'long',year:'numeric',month:'long',day:'numeric'}) : '';
  var evBody = 'Ada event baru yang ditambahkan:<br><br><b style="font-size:16px">'+title+'</b>'+(dateStr?'<br><br>&#128197; '+dateStr:'')+(location?'<br>&#128205; '+location:'')+(description?'<br><br><span style="color:#57534e;font-size:14px">'+description.substring(0,150)+(description.length>150?'...':'')+'</span>':'');
  sendNewsletterEmail('Event Baru: '+title, emailTemplate('Event Baru di 7099 &#128197;', evBody, 'Lihat Event', 'https://zapa.inweb.id/events'));
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put("/api/events/:id", approvedMiddleware, (req, res) => {
  const ev = db.prepare("SELECT created_by FROM events WHERE id=?").get(req.params.id);
  if (!ev) return res.status(404).json({ error: "Not found" });
  const user = db.prepare("SELECT role FROM users WHERE id=?").get(req.user.id);
  if (ev.created_by !== req.user.id && user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  const { title, description, event_date, location } = req.body;
  db.prepare("UPDATE events SET title=?, description=?, event_date=?, location=? WHERE id=?").run(title, description, event_date, location, req.params.id);
  res.json({ success: true });
});

app.delete("/api/events/:id", adminMiddleware, (req, res) => {
  db.prepare("DELETE FROM event_rsvp WHERE event_id=?").run(req.params.id);
  db.prepare("DELETE FROM events WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/events/upload-image", approvedMiddleware, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    var outName = "ev-" + Date.now() + "-" + Math.random().toString(36).substr(2,6) + ".jpg";
    var outPath = path.join(__dirname, "..", "public", "photos", outName);
    await sharp(req.file.path).resize(800, null, { withoutEnlargement: true, fit: "inside" }).jpeg({ quality: 80 }).toFile(outPath);
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.json({ success: true, url: "/photos/" + outName });
  } catch(e) { res.status(500).json({ error: "Upload failed" }); }
});

app.post("/api/events/:id/cover", approvedMiddleware, upload.single("cover"), async (req, res) => {
  const ev = db.prepare("SELECT created_by FROM events WHERE id=?").get(req.params.id);
  if (!ev) return res.status(404).json({ error: "Not found" });
  const user = db.prepare("SELECT role FROM users WHERE id=?").get(req.user.id);
  if (ev.created_by !== req.user.id && user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  try {
    var outName = "ev-cover-" + Date.now() + ".jpg";
    var outPath = path.join(__dirname, "..", "public", "photos", outName);
    await sharp(req.file.path).resize(800, null, { withoutEnlargement: true, fit: "inside" }).jpeg({ quality: 80 }).toFile(outPath);
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    db.prepare("UPDATE events SET cover_image=? WHERE id=?").run(outName, req.params.id);
    res.json({ success: true, filename: outName });
  } catch(e) { res.status(500).json({ error: "Upload failed" }); }
});

app.post("/api/events/:id/rsvp", approvedMiddleware, (req, res) => {
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  if (!user || !user.alumni_id) return res.status(400).json({ error: "No alumni profile" });
  const existing = db.prepare("SELECT id FROM event_rsvp WHERE event_id=? AND alumni_id=?").get(req.params.id, user.alumni_id);
  if (existing) {
    db.prepare("DELETE FROM event_rsvp WHERE event_id=? AND alumni_id=?").run(req.params.id, user.alumni_id);
    db.prepare("UPDATE events SET rsvp_count = MAX(0, rsvp_count-1) WHERE id=?").run(req.params.id);
    res.json({ rsvped: false });
  } else {
    db.prepare("INSERT INTO event_rsvp (event_id, alumni_id) VALUES (?,?)").run(req.params.id, user.alumni_id);
    db.prepare("UPDATE events SET rsvp_count = rsvp_count+1 WHERE id=?").run(req.params.id);
    res.json({ rsvped: true });
  }
});

app.get("/api/events/:id/rsvps", adminMiddleware, (req, res) => {
  res.json(db.prepare("SELECT a.name, a.nickname, a.city FROM event_rsvp r JOIN alumni a ON a.id=r.alumni_id WHERE r.event_id=? ORDER BY r.created_at").all(req.params.id));
});

app.post("/api/admin/approve/:id", adminMiddleware, (req, res) => {
  db.prepare("UPDATE users SET status = 'approved' WHERE id = ?").run(req.params.id);
  var u = db.prepare("SELECT email, name, alumni_id FROM users WHERE id = ?").get(req.params.id);
  if (u) {
    sendEmail(u.email, "Akun Disetujui - Alumni 7099",
      emailTemplate("Akun Kamu Disetujui! ✅",
        "Halo " + (u.name || "Alumni") + ",<br><br>Selamat! Akun kamu telah <b>disetujui</b> oleh admin. Kamu sekarang bisa mengakses semua fitur website alumni termasuk:<br><br>• Direktori alumni<br>• Peta interaktif<br>• Edit profil<br>• Upload foto",
        "Masuk Sekarang", "https://zapa.inweb.id/login"));
    if (u.alumni_id) {
      var a = db.prepare("SELECT id, city, country, latitude FROM alumni WHERE id = ?").get(u.alumni_id);
      if (a && a.city && !a.latitude) {
        geocodeCity(a.city, a.country).then(c => {
          if (c) db.prepare("UPDATE alumni SET latitude=?, longitude=? WHERE id=?").run(c.lat, c.lon, a.id);
        }).catch(() => {});
      }
    }
  }
  res.json({ success: true });
});

app.post("/api/admin/reject/:id", adminMiddleware, (req, res) => {
  db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(req.params.id);
  var u = db.prepare("SELECT email, name FROM users WHERE id = ?").get(req.params.id);
  if (u) sendEmail(u.email, "Pendaftaran Ditolak - Alumni 7099",
    emailTemplate("Pendaftaran Ditolak",
      "Halo " + (u.name || "") + ",<br><br>Maaf, pendaftaran akun kamu <b>tidak disetujui</b> oleh admin.<br><br>Jika kamu merasa ini adalah kesalahan, silakan hubungi admin di grup alumni.",
      null, null));
  res.json({ success: true });
});

app.get("/api/admin/articles", adminMiddleware, (req, res) => {
  res.json(db.prepare("SELECT a.*, al.name as author_name, al.nickname as author_nick FROM articles a LEFT JOIN alumni al ON a.author_id = al.id ORDER BY a.created_at DESC").all());
});

app.delete("/api/admin/articles/:id", adminMiddleware, (req, res) => {
  db.prepare("DELETE FROM articles WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.get("/api/admin/alumni", adminMiddleware, (req, res) => {
  res.json(db.prepare("SELECT * FROM alumni ORDER BY name").all());
});

app.put("/api/admin/alumni/:id", adminMiddleware, (req, res) => {
  const { name, nickname, email, phone, city, country, job_title, company, class: kelas, class1, class2, university, hobby, birthday, gender, address, latitude, longitude } = req.body;
  db.prepare("UPDATE alumni SET name=?, nickname=?, email=?, phone=?, city=?, country=?, job_title=?, company=?, class=?, class1=?, class2=?, university=?, hobby=?, birthday=?, gender=?, address=?, latitude=?, longitude=? WHERE id=?")
    .run(name, nickname, email, phone, city, country, job_title, company, kelas, class1, class2, university, hobby, birthday, gender, address, latitude, longitude, req.params.id);
  res.json({ success: true });
});

app.delete("/api/admin/alumni/:id", adminMiddleware, (req, res) => {
  db.prepare("DELETE FROM photos WHERE alumni_id = ?").run(req.params.id);
  db.prepare("UPDATE users SET alumni_id = NULL WHERE alumni_id = ?").run(req.params.id);
  db.prepare("DELETE FROM alumni WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});


// Admin unlink user from alumni (wrong match)
app.post("/api/admin/unlink/:id", adminMiddleware, (req, res) => {
  db.prepare("UPDATE users SET alumni_id = NULL WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.get("/api/admin/users", adminMiddleware, (req, res) => {
  res.json(db.prepare("SELECT u.id, u.email, u.name, u.role, u.status, u.alumni_id, u.google_id, (u.password_hash IS NOT NULL) AS has_password, u.created_at, a.name as alumni_name FROM users u LEFT JOIN alumni a ON u.alumni_id = a.id ORDER BY u.created_at DESC").all());
});

app.put("/api/admin/users/:id", adminMiddleware, (req, res) => {
  const { role, status } = req.body;
  if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
  if (status) db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ success: true });
});

app.delete("/api/admin/users/:id", adminMiddleware, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.get("/api/admin/export", adminMiddleware, (req, res) => {
  const alumni = db.prepare("SELECT * FROM alumni ORDER BY name").all();
  var csv = Object.keys(alumni[0] || {}).join(",") + "\n";
  alumni.forEach(a => { csv += Object.values(a).map(v => '"'+(v||"").toString().replace(/"/g,'""')+'"').join(",") + "\n"; });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=alumni_export.csv");
  res.send(csv);
});


// Config endpoints
app.get("/api/admin/config", adminMiddleware, (req, res) => {
  var rows = db.prepare("SELECT * FROM config").all();
  var cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });
  res.json(cfg);
});

app.put("/api/admin/config", adminMiddleware, (req, res) => {
  var { telegram_bot_token, telegram_chat_id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
  if (telegram_bot_token !== undefined) db.prepare("INSERT OR REPLACE INTO config VALUES ('telegram_bot_token', ?)").run(telegram_bot_token);
  if (telegram_chat_id !== undefined) db.prepare("INSERT OR REPLACE INTO config VALUES ('telegram_chat_id', ?)").run(telegram_chat_id);
  if (smtp_host !== undefined) db.prepare("INSERT OR REPLACE INTO config VALUES ('smtp_host', ?)").run(smtp_host);
  if (smtp_port !== undefined) db.prepare("INSERT OR REPLACE INTO config VALUES ('smtp_port', ?)").run(smtp_port);
  if (smtp_user !== undefined) db.prepare("INSERT OR REPLACE INTO config VALUES ('smtp_user', ?)").run(smtp_user);
  if (smtp_pass !== undefined) db.prepare("INSERT OR REPLACE INTO config VALUES ('smtp_pass', ?)").run(smtp_pass);
  if (smtp_from !== undefined) db.prepare("INSERT OR REPLACE INTO config VALUES ('smtp_from', ?)").run(smtp_from);
  res.json({ success: true });
});

app.post("/api/admin/email-test", adminMiddleware, (req, res) => {
  var admin = db.prepare("SELECT email, name FROM users WHERE id = ?").get(req.user.id);
  sendEmail(admin.email, "Test Email - Alumni 7099",
    emailTemplate("Test Email 🔔", "Jika kamu menerima email ini, konfigurasi SMTP sudah benar!", "Buka Admin", "https://zapa.inweb.id/admin"));
  res.json({ success: true });
});

app.post("/api/admin/telegram-test", adminMiddleware, (req, res) => {
  sendTelegram("🔔 <b>Test Notification</b>\nBot 7099 Alumni is working!\n👉 https://zapa.inweb.id/admin");
  res.json({ success: true });
});

// ── Gallery ─────────────────────────────────────────
// GET /api/gallery/folders — list all folders with photo count + 4 random preview filenames
app.get("/api/gallery/folders", approvedMiddleware, (req, res) => {
  const folders = db.prepare("SELECT * FROM gallery_folders ORDER BY created_at ASC").all();
  const result = folders.map(f => {
    const count = db.prepare("SELECT COUNT(*) as c FROM gallery_photos WHERE folder_id=?").get(f.id).c;
    const previews = db.prepare("SELECT filename FROM gallery_photos WHERE folder_id=? ORDER BY RANDOM() LIMIT 4").all(f.id).map(r => r.filename);
    return { ...f, count, previews };
  });
  res.json(result);
});

// GET /api/gallery/folders/:id — list all photos in a folder
app.get("/api/gallery/folders/:id", approvedMiddleware, (req, res) => {
  const folder = db.prepare("SELECT * FROM gallery_folders WHERE id=?").get(req.params.id);
  if (!folder) return res.status(404).json({ error: "Not found" });
  const photos = db.prepare("SELECT * FROM gallery_photos WHERE folder_id=? ORDER BY created_at ASC").all(req.params.id);
  res.json({ folder, photos });
});

// POST /api/gallery/folders — create a new folder (approved users)
app.post("/api/gallery/folders", approvedMiddleware, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  const result = db.prepare("INSERT INTO gallery_folders (name, description, created_by) VALUES (?,?,?)").run(name.trim(), description || null, user ? user.alumni_id : null);
  res.json({ success: true, id: result.lastInsertRowid });
});

// POST /api/gallery/folders/:id/photos — upload photos to a folder (approved users)
app.post("/api/gallery/folders/:id/photos", approvedMiddleware, upload.array("photos", 20), async (req, res) => {
  const folder = db.prepare("SELECT * FROM gallery_folders WHERE id=?").get(req.params.id);
  if (!folder) return res.status(404).json({ error: "Folder not found" });
  if (!req.files || !req.files.length) return res.status(400).json({ error: "No files" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  const alumniId = user ? user.alumni_id : null;
  const inserted = [];
  for (const file of req.files) {
    try {
      const outName = "gallery-" + Date.now() + "-" + Math.random().toString(36).substr(2,6) + ".jpg";
      const outPath = path.join(__dirname, "..", "public", "photos", outName);
      await sharp(file.path).resize(1200, null, { withoutEnlargement: true, fit: "inside" }).jpeg({ quality: 82 }).toFile(outPath);
      try { fs.unlinkSync(file.path); } catch(e) {}
      const caption = (req.body.caption && typeof req.body.caption === "string") ? req.body.caption : null;
      db.prepare("INSERT INTO gallery_photos (folder_id, filename, caption, uploaded_by) VALUES (?,?,?,?)").run(folder.id, outName, caption, alumniId);
      inserted.push(outName);
    } catch(e) {
      console.error("Gallery upload error:", e.message);
    }
  }
  res.json({ success: true, uploaded: inserted.length });
});

// DELETE /api/gallery/folders/:id — delete folder + all its photos (admin only)
app.delete("/api/gallery/folders/:id", adminMiddleware, (req, res) => {
  const photos = db.prepare("SELECT filename FROM gallery_photos WHERE folder_id=?").all(req.params.id);
  photos.forEach(p => {
    try { fs.unlinkSync(path.join(__dirname, "..", "public", "photos", p.filename)); } catch(e) {}
  });
  db.prepare("DELETE FROM gallery_folders WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// DELETE /api/gallery/photos/:id — delete single photo (any approved user)
app.delete("/api/gallery/photos/:id", approvedMiddleware, (req, res) => {
  const photo = db.prepare("SELECT * FROM gallery_photos WHERE id=?").get(req.params.id);
  if (!photo) return res.status(404).json({ error: "Not found" });
  try { fs.unlinkSync(path.join(__dirname, "..", "public", "photos", photo.filename)); } catch(e) {}
  db.prepare("DELETE FROM gallery_photos WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// PUT /api/gallery/folders/:id/layout — save default layout for folder (admin only)
app.put("/api/gallery/folders/:id/layout", adminMiddleware, (req, res) => {
  const valid = ['polaroid','magazine','filmstrip','feed','slideshow','yearbook'];
  const { layout } = req.body;
  if (!valid.includes(layout)) return res.status(400).json({ error: "Invalid layout" });
  db.prepare("UPDATE gallery_folders SET default_layout=? WHERE id=?").run(layout, req.params.id);
  res.json({ success: true });
});

// ── Forum ────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS forum_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, description TEXT, icon TEXT DEFAULT '💬',
  sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS forum_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES forum_categories(id),
  author_id INTEGER REFERENCES alumni(id),
  title TEXT NOT NULL, body TEXT NOT NULL,
  is_sticky INTEGER DEFAULT 0, is_locked INTEGER DEFAULT 0, view_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS forum_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES alumni(id),
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS forum_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER REFERENCES forum_threads(id) ON DELETE CASCADE,
  reply_id INTEGER REFERENCES forum_replies(id) ON DELETE CASCADE,
  alumni_id INTEGER NOT NULL REFERENCES alumni(id), emoji TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(thread_id, reply_id, alumni_id, emoji)
)`);

// Seed default categories + sticky how-to posts once
if (!db.prepare("SELECT id FROM forum_categories LIMIT 1").get()) {
  const cats = [
    { name: "Pengumuman", description: "Info resmi dan pengumuman dari admin", icon: "📌", sort: 0 },
    { name: "Obrolan",    description: "Ngobrol bebas — topik apapun boleh",   icon: "💬", sort: 1 },
    { name: "Reuni & Acara", description: "Rencanain ketemu dan acara bareng",  icon: "🎉", sort: 2 },
    { name: "Bantuan & Karir", description: "Cari kerja, koneksi, atau minta saran", icon: "💼", sort: 3 },
    { name: "Kenangan 7099",   description: "Foto jadul, cerita SMA, nostalgia",    icon: "📸", sort: 4 },
  ];
  const insC = db.prepare("INSERT INTO forum_categories (name,description,icon,sort_order) VALUES (?,?,?,?)");
  cats.forEach(c => insC.run(c.name, c.description, c.icon, c.sort));
  const pengId = db.prepare("SELECT id FROM forum_categories WHERE name='Pengumuman'").get().id;
  const insT = db.prepare("INSERT INTO forum_threads (category_id,author_id,title,body,is_sticky) VALUES (?,NULL,?,?,1)");
  insT.run(pengId, "📖 Cara Menggunakan Forum Ini",
`Selamat datang di Forum 7099! 👋

Forum ini adalah tempat kita ngobrol, berbagi cerita, dan saling bantu sesama alumni SMAN 70 Angkatan 99.

📌 KATEGORI
• Pengumuman – Info resmi dari admin
• Obrolan – Ngobrol bebas, apapun topiknya
• Reuni & Acara – Rencanain ketemu bareng
• Bantuan & Karir – Cari kerja, koneksi, atau minta saran
• Kenangan 7099 – Foto jadul, cerita SMA, nostalgia

✍️ CARA BUAT THREAD BARU
1. Pilih kategori yang sesuai
2. Klik tombol "+ Thread Baru"
3. Tulis judul yang jelas dan isi postingan lengkap
4. Klik Kirim

💬 CARA REPLY
Buka sebuah thread, scroll ke bawah, tulis balasanmu di kolom reply dan klik Kirim.

@MENTION
Mention teman dengan nulis @nickname mereka di postingan atau reply. Mereka akan dapat notifikasi email otomatis!

❤️ REAKSI
Klik salah satu emoji (❤️ 👍 😂 🎉 😮) di bawah postingan atau reply untuk kasih reaksi tanpa perlu nulis komentar.

Selamat ngobrol dan reconnect! 🎉`);
  insT.run(pengId, "📜 Aturan & Etika Komunitas 7099",
`Supaya forum ini nyaman buat semua, tolong ikuti aturan berikut:

✅ BOLEH
• Berbagi cerita, pengalaman, dan tips
• Minta saran, bantuan, atau referensi
• Promosi usaha dengan sopan di kategori yang tepat
• Berbagi foto atau kenangan SMA
• Berdiskusi dengan santun meski beda pendapat

❌ TIDAK BOLEH
• SARA, ujaran kebencian, atau konten ofensif
• Spam atau iklan berlebihan
• Menyebarkan informasi palsu atau hoaks
• Memposting konten pribadi orang lain tanpa izin
• Bahasa kasar atau menyerang pribadi

🔧 PELANGGARAN
Postingan yang melanggar aturan akan dihapus oleh admin. Pelanggaran berulang dapat berakibat pada pembatasan akun.

Inget, kita semua alumni yang sama — jaga nama baik 7099! 💪`);
}

// Helper — send targeted email to one address
function sendForumEmail(toEmail, subject, html) {
  if (!toEmail) return;
  sendEmail(toEmail, subject, html);
}

// Helper — parse @mentions from body, return matched alumni emails (excluding excludeAlumniId)
function getMentionedEmails(body, excludeAlumniId) {
  var mentions = (body.match(/@(\w+)/g) || []).map(m => m.slice(1));
  if (!mentions.length) return [];
  var emails = [];
  mentions.forEach(function(nick) {
    var row = db.prepare(`SELECT u.email FROM alumni al JOIN users u ON u.alumni_id=al.id
      WHERE (LOWER(al.nickname)=LOWER(?) OR LOWER(al.name)=LOWER(?)) AND al.id!=? AND u.email IS NOT NULL LIMIT 1`)
      .get(nick, nick, excludeAlumniId || 0);
    if (row && row.email && !emails.includes(row.email)) emails.push(row.email);
  });
  return emails;
}

// GET /api/forum/categories
app.get("/api/forum/categories", (req, res) => {
  const cats = db.prepare("SELECT * FROM forum_categories ORDER BY sort_order").all();
  const result = cats.map(c => {
    const threadCount = db.prepare("SELECT COUNT(*) as n FROM forum_threads WHERE category_id=?").get(c.id).n;
    const last = db.prepare(`SELECT t.updated_at, al.name as author_name, al.nickname as author_nick
      FROM forum_threads t LEFT JOIN alumni al ON t.author_id=al.id
      WHERE t.category_id=? ORDER BY t.updated_at DESC LIMIT 1`).get(c.id);
    return { ...c, thread_count: threadCount, last_activity: last ? last.updated_at : null, last_author: last ? (last.author_nick || last.author_name) : null };
  });
  res.json(result);
});

// GET /api/forum/categories/:id/threads
app.get("/api/forum/categories/:id/threads", (req, res) => {
  const cat = db.prepare("SELECT * FROM forum_categories WHERE id=?").get(req.params.id);
  if (!cat) return res.status(404).json({ error: "Not found" });
  const threads = db.prepare(`SELECT t.*, al.name as author_name, al.nickname as author_nick,
    (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id=t.id) as reply_count,
    (SELECT MAX(r.created_at) FROM forum_replies r WHERE r.thread_id=t.id) as last_reply_at
    FROM forum_threads t LEFT JOIN alumni al ON t.author_id=al.id
    WHERE t.category_id=? ORDER BY t.is_sticky DESC, COALESCE((SELECT MAX(r.created_at) FROM forum_replies r WHERE r.thread_id=t.id), t.created_at) DESC`).all(req.params.id);
  res.json({ category: cat, threads });
});

// GET /api/forum/threads/:id
app.get("/api/forum/threads/:id", (req, res) => {
  const thread = db.prepare(`SELECT t.*, al.name as author_name, al.nickname as author_nick
    FROM forum_threads t LEFT JOIN alumni al ON t.author_id=al.id WHERE t.id=?`).get(req.params.id);
  if (!thread) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE forum_threads SET view_count=view_count+1 WHERE id=?").run(req.params.id);
  const replies = db.prepare(`SELECT r.*, al.name as author_name, al.nickname as author_nick
    FROM forum_replies r LEFT JOIN alumni al ON r.author_id=al.id WHERE r.thread_id=? ORDER BY r.created_at ASC`).all(req.params.id);

  // Get current user alumni_id for reaction "reacted" flag
  var myAlumniId = 0;
  try {
    const token = req.cookies.token || (req.headers.authorization || "").replace("Bearer ", "");
    if (token) { const u = jwt.verify(token, JWT_SECRET); const row = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(u.id); if (row) myAlumniId = row.alumni_id || 0; }
  } catch(e) {}

  function getReactions(threadId, replyId) {
    const rows = db.prepare("SELECT emoji, COUNT(*) as cnt, MAX(CASE WHEN alumni_id=? THEN 1 ELSE 0 END) as reacted FROM forum_reactions WHERE thread_id IS ? AND reply_id IS ? GROUP BY emoji")
      .all(myAlumniId, threadId, replyId);
    return rows.map(r => ({ emoji: r.emoji, count: r.cnt, reacted: r.reacted === 1 }));
  }
  thread.reactions = getReactions(thread.id, null);
  replies.forEach(r => { r.reactions = getReactions(null, r.id); });
  res.json({ thread, replies });
});

// POST /api/forum/threads
app.post("/api/forum/threads", approvedMiddleware, (req, res) => {
  const { category_id, title, body } = req.body;
  if (!category_id || !title || !body) return res.status(400).json({ error: "category_id, title, body required" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  const now = new Date().toISOString();
  const result = db.prepare("INSERT INTO forum_threads (category_id,author_id,title,body,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(category_id, user ? user.alumni_id : null, title.trim(), body.trim(), now, now);
  res.json({ success: true, id: result.lastInsertRowid });
});

// PUT /api/forum/threads/:id
app.put("/api/forum/threads/:id", approvedMiddleware, (req, res) => {
  const thread = db.prepare("SELECT * FROM forum_threads WHERE id=?").get(req.params.id);
  if (!thread) return res.status(404).json({ error: "Not found" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  if (thread.author_id !== (user && user.alumni_id) && req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  const { title, body } = req.body;
  db.prepare("UPDATE forum_threads SET title=?,body=?,updated_at=? WHERE id=?").run(title || thread.title, body || thread.body, new Date().toISOString(), req.params.id);
  res.json({ success: true });
});

// DELETE /api/forum/threads/:id (admin only)
app.delete("/api/forum/threads/:id", adminMiddleware, (req, res) => {
  db.prepare("DELETE FROM forum_threads WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// PUT /api/forum/threads/:id/sticky (admin)
app.put("/api/forum/threads/:id/sticky", adminMiddleware, (req, res) => {
  const t = db.prepare("SELECT is_sticky FROM forum_threads WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE forum_threads SET is_sticky=? WHERE id=?").run(t.is_sticky ? 0 : 1, req.params.id);
  res.json({ success: true, is_sticky: !t.is_sticky });
});

// PUT /api/forum/threads/:id/lock (admin)
app.put("/api/forum/threads/:id/lock", adminMiddleware, (req, res) => {
  const t = db.prepare("SELECT is_locked FROM forum_threads WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE forum_threads SET is_locked=? WHERE id=?").run(t.is_locked ? 0 : 1, req.params.id);
  res.json({ success: true, is_locked: !t.is_locked });
});

// POST /api/forum/threads/:id/replies
app.post("/api/forum/threads/:id/replies", approvedMiddleware, (req, res) => {
  const thread = db.prepare("SELECT * FROM forum_threads WHERE id=?").get(req.params.id);
  if (!thread) return res.status(404).json({ error: "Not found" });
  if (thread.is_locked) return res.status(403).json({ error: "Thread is locked" });
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Body required" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  const alumniId = user ? user.alumni_id : null;
  const now = new Date().toISOString();
  const result = db.prepare("INSERT INTO forum_replies (thread_id,author_id,body,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(thread.id, alumniId, body.trim(), now, now);
  db.prepare("UPDATE forum_threads SET updated_at=? WHERE id=?").run(now, thread.id);

  // Notify thread author (if not self)
  if (thread.author_id && thread.author_id !== alumniId) {
    const authorUser = db.prepare("SELECT u.email, al.nickname, al.name FROM users u JOIN alumni al ON u.alumni_id=al.id WHERE al.id=?").get(thread.author_id);
    if (authorUser && authorUser.email) {
      const replier = alumniId ? db.prepare("SELECT nickname, name FROM alumni WHERE id=?").get(alumniId) : null;
      const replierName = replier ? (replier.nickname || replier.name) : "Seseorang";
      sendForumEmail(authorUser.email, "Reply baru di forum 7099",
        emailTemplate("Ada reply baru! 💬", "<b>" + replierName + "</b> membalas thread kamu:<br><br><b>" + thread.title + "</b><br><br><span style='color:#57534e'>" + body.trim().substring(0, 200) + (body.length > 200 ? "..." : "") + "</span>", "Lihat Thread", "https://zapa.inweb.id/forum?thread=" + thread.id));
    }
  }
  // Notify @mentions
  const mentionEmails = getMentionedEmails(body, alumniId);
  const mentioner = alumniId ? db.prepare("SELECT nickname, name FROM alumni WHERE id=?").get(alumniId) : null;
  const mentionerName = mentioner ? (mentioner.nickname || mentioner.name) : "Seseorang";
  mentionEmails.forEach(email => {
    sendForumEmail(email, "Kamu di-mention di forum 7099",
      emailTemplate("Kamu di-mention! 👋", "<b>" + mentionerName + "</b> menyebut kamu di forum:<br><br><b>" + thread.title + "</b><br><br><span style='color:#57534e'>" + body.trim().substring(0, 200) + (body.length > 200 ? "..." : "") + "</span>", "Lihat Thread", "https://zapa.inweb.id/forum?thread=" + thread.id));
  });

  res.json({ success: true, id: result.lastInsertRowid });
});

// PUT /api/forum/replies/:id
app.put("/api/forum/replies/:id", approvedMiddleware, (req, res) => {
  const reply = db.prepare("SELECT * FROM forum_replies WHERE id=?").get(req.params.id);
  if (!reply) return res.status(404).json({ error: "Not found" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  if (reply.author_id !== (user && user.alumni_id) && req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Body required" });
  db.prepare("UPDATE forum_replies SET body=?,updated_at=? WHERE id=?").run(body.trim(), new Date().toISOString(), req.params.id);
  res.json({ success: true });
});

// DELETE /api/forum/replies/:id (admin)
app.delete("/api/forum/replies/:id", adminMiddleware, (req, res) => {
  db.prepare("DELETE FROM forum_replies WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// POST /api/forum/react — toggle reaction
app.post("/api/forum/react", approvedMiddleware, (req, res) => {
  const { thread_id, reply_id, emoji } = req.body;
  const validEmoji = ["❤️","👍","😂","🎉","😮"];
  if (!validEmoji.includes(emoji)) return res.status(400).json({ error: "Invalid emoji" });
  if (!thread_id && !reply_id) return res.status(400).json({ error: "thread_id or reply_id required" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  if (!user || !user.alumni_id) return res.status(400).json({ error: "No profile" });
  const tid = thread_id || null, rid = reply_id || null;
  const existing = db.prepare("SELECT id FROM forum_reactions WHERE thread_id IS ? AND reply_id IS ? AND alumni_id=? AND emoji=?").get(tid, rid, user.alumni_id, emoji);
  if (existing) {
    db.prepare("DELETE FROM forum_reactions WHERE id=?").run(existing.id);
    res.json({ success: true, action: "removed" });
  } else {
    db.prepare("INSERT INTO forum_reactions (thread_id,reply_id,alumni_id,emoji) VALUES (?,?,?,?)").run(tid, rid, user.alumni_id, emoji);
    res.json({ success: true, action: "added" });
  }
});

// ── Du-Du (Dari-Untuk wall) ─────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS dudu_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dari_text TEXT NOT NULL,
  untuk_text TEXT NOT NULL,
  pesan TEXT NOT NULL,
  posted_by INTEGER REFERENCES alumni(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS dudu_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES dudu_notes(id) ON DELETE CASCADE,
  alumni_id INTEGER NOT NULL REFERENCES alumni(id),
  emoji TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(note_id, alumni_id, emoji)
)`);

// GET /api/dudu — list all notes with reactions
app.get("/api/dudu", (req, res) => {
  const notes = db.prepare(`SELECT n.*, al.name as poster_name, al.nickname as poster_nick
    FROM dudu_notes n LEFT JOIN alumni al ON n.posted_by=al.id ORDER BY n.created_at DESC`).all();
  var myAlumniId = 0;
  try {
    const token = req.cookies.token || (req.headers.authorization || "").replace("Bearer ", "");
    if (token) { const u = jwt.verify(token, JWT_SECRET); const row = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(u.id); if (row) myAlumniId = row.alumni_id || 0; }
  } catch(e) {}
  notes.forEach(n => {
    const rx = db.prepare("SELECT emoji, COUNT(*) as cnt, MAX(CASE WHEN alumni_id=? THEN 1 ELSE 0 END) as reacted FROM dudu_reactions WHERE note_id=? GROUP BY emoji")
      .all(myAlumniId, n.id);
    n.reactions = rx.map(r => ({ emoji: r.emoji, count: r.cnt, reacted: r.reacted === 1 }));
  });
  res.json(notes);
});

// POST /api/dudu — create note
app.post("/api/dudu", approvedMiddleware, (req, res) => {
  const { dari_text, untuk_text, pesan } = req.body;
  if (!dari_text || !untuk_text || !pesan) return res.status(400).json({ error: "Semua field wajib diisi" });
  if (dari_text.length > 60 || untuk_text.length > 60 || pesan.length > 280) return res.status(400).json({ error: "Terlalu panjang" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  const alumniId = user ? user.alumni_id : null;
  const result = db.prepare("INSERT INTO dudu_notes (dari_text, untuk_text, pesan, posted_by) VALUES (?,?,?,?)")
    .run(dari_text.trim(), untuk_text.trim(), pesan.trim(), alumniId);

  // Notify @mentions in untuk + pesan
  const mentionEmails = getMentionedEmails(untuk_text + " " + pesan, alumniId);
  mentionEmails.forEach(email => {
    sendEmail(email, "Ada Du-Du buat kamu di 7099",
      emailTemplate("Kamu dapat Du-Du! 💌",
        "<b>Dari:</b> " + dari_text.trim() + "<br><b>Untuk:</b> " + untuk_text.trim() + "<br><br><i>\"" + pesan.trim() + "\"</i>",
        "Lihat di Wall", "https://zapa.inweb.id/dudu"));
  });

  res.json({ success: true, id: result.lastInsertRowid });
});

// DELETE /api/dudu/:id — admin or owner
app.delete("/api/dudu/:id", approvedMiddleware, (req, res) => {
  const note = db.prepare("SELECT * FROM dudu_notes WHERE id=?").get(req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  if (note.posted_by !== (user && user.alumni_id) && req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  db.prepare("DELETE FROM dudu_notes WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// POST /api/dudu/react — toggle reaction
app.post("/api/dudu/react", approvedMiddleware, (req, res) => {
  const { note_id, emoji } = req.body;
  const valid = ["❤️","👍","😂","🎉","😮"];
  if (!valid.includes(emoji) || !note_id) return res.status(400).json({ error: "Invalid input" });
  const user = db.prepare("SELECT alumni_id FROM users WHERE id=?").get(req.user.id);
  if (!user || !user.alumni_id) return res.status(400).json({ error: "No profile" });
  const existing = db.prepare("SELECT id FROM dudu_reactions WHERE note_id=? AND alumni_id=? AND emoji=?").get(note_id, user.alumni_id, emoji);
  if (existing) {
    db.prepare("DELETE FROM dudu_reactions WHERE id=?").run(existing.id);
    res.json({ success: true, action: "removed" });
  } else {
    db.prepare("INSERT INTO dudu_reactions (note_id, alumni_id, emoji) VALUES (?,?,?)").run(note_id, user.alumni_id, emoji);
    res.json({ success: true, action: "added" });
  }
});

// ── Start ───────────────────────────────────────────
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Alumni API running on port ${PORT}`);
});
