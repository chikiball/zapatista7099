const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const fs = require("fs");
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

// ── App Setup ───────────────────────────────────────
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Photo upload config
const storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, require("path").join(__dirname, "..", "public", "photos")) },
  filename: function(req, file, cb) {
    var ext = file.originalname.split(".").pop();
    cb(null, Date.now() + "-" + Math.random().toString(36).substr(2,6) + "." + ext);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 5*1024*1024 }, fileFilter: function(req,file,cb){
  if(file.mimetype.startsWith("image/")) cb(null,true); else cb(new Error("Only images allowed"));
}});

// Photos table
db.exec("CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, alumni_id INTEGER REFERENCES alumni(id), filename TEXT NOT NULL, original_name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");


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
    { id: user.id, email: user.email, name: user.name, alumni_id: user.alumni_id, role: user.role },
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
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    // Check if user exists
    const existing = db.prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)").get(email);
    if (existing) return res.status(409).json({ error: "Email already registered. Try logging in." });

    // Try to match with existing alumni
    const { match, confidence } = findAlumniMatch(email, name);
    const password_hash = bcrypt.hashSync(password, 10);

    const result = db.prepare(
      "INSERT INTO users (email, password_hash, name, alumni_id) VALUES (?, ?, ?, ?)"
    ).run(email.toLowerCase(), password_hash, name || null, match ? match.id : null);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
    const token = generateToken(user);
    setTokenCookie(res, token);

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

    if (user) {
      // Update google_id if not set
      if (!user.google_id) {
        db.prepare("UPDATE users SET google_id = ?, name = COALESCE(name, ?) WHERE id = ?").run(googleId, name, user.id);
      }
    } else {
      // New user - try to match alumni
      const { match, confidence } = findAlumniMatch(email, name);
      db.prepare(
        "INSERT INTO users (email, google_id, name, alumni_id) VALUES (?, ?, ?, ?)"
      ).run(email.toLowerCase(), googleId, name, match ? match.id : null);
      user = db.prepare("SELECT * FROM users WHERE google_id = ?").get(googleId);
    }

    const token = generateToken(user);
    setTokenCookie(res, token);

    const alumniMatch = user.alumni_id ? db.prepare("SELECT * FROM alumni WHERE id = ?").get(user.alumni_id) : null;

    res.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, alumni_id: user.alumni_id },
      alumni_match: alumniMatch ? { id: alumniMatch.id, name: alumniMatch.name, nickname: alumniMatch.nickname } : null,
    });
  } catch(e) {
    console.error("Google auth error:", e);
    res.status(500).json({ error: "Google authentication failed" });
  }
});

// Get current user
app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT id, email, name, alumni_id, role, created_at FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  let profile = null;
  if (user.alumni_id) {
    profile = db.prepare("SELECT * FROM alumni WHERE id = ?").get(user.alumni_id);
  }
  res.json({ user, profile });
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

// Update or create profile
app.put("/api/profile", authMiddleware, (req, res) => {
  try {
    const { name, nickname, phone, city, country, job_title, company, bio, birthday, gender, address, hobby, university, class: kelas } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);

    if (user.alumni_id) {
      // Update existing alumni record
      db.prepare(`
        UPDATE alumni SET name=?, nickname=?, phone=?, city=?, country=?, job_title=?, company=?, bio=?, birthday=?, gender=?, address=?, hobby=?, university=?, class=?
        WHERE id=?
      `).run(name, nickname, phone, city, country, job_title, company, bio, birthday, gender, address, hobby, university, kelas, user.alumni_id);
    } else {
      // Create new alumni record and link
      const result = db.prepare(`
        INSERT INTO alumni (name, nickname, email, phone, city, country, job_title, company, bio, is_public, birthday, gender, address, hobby, university, class)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(name, nickname, user.email, phone, city, country, job_title, company, bio, birthday, gender, address, hobby, university, kelas);
      db.prepare("UPDATE users SET alumni_id = ?, name = ? WHERE id = ?").run(result.lastInsertRowid, name, user.id);
    }

    // Update user name
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
app.get("/api/alumni/search", authMiddleware, (req, res) => {
  const q = req.query.q || "";
  if (q.length < 2) return res.json([]);
  const results = db.prepare(
    "SELECT id, name, nickname, city FROM alumni WHERE name LIKE ? OR nickname LIKE ? LIMIT 10"
  ).all(`%${q}%`, `%${q}%`);
  res.json(results);
});

// Link user to existing alumni
app.post("/api/profile/link", authMiddleware, (req, res) => {
  const { alumni_id } = req.body;
  const alumni = db.prepare("SELECT * FROM alumni WHERE id = ?").get(alumni_id);
  if (!alumni) return res.status(404).json({ error: "Alumni not found" });

  db.prepare("UPDATE users SET alumni_id = ?, name = ? WHERE id = ?").run(alumni_id, alumni.name, req.user.id);
  res.json({ success: true, profile: alumni });
});


// ── PHOTO ROUTES ────────────────────────────────────

// Upload photos
app.post("/api/profile/photos", authMiddleware, upload.array("photos", 10), (req, res) => {
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
app.delete("/api/profile/photos/:id", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND alumni_id = ?").get(req.params.id, user.alumni_id);
  if (!photo) return res.status(404).json({ error: "Photo not found" });
  try { fs.unlinkSync(require("path").join(__dirname, "..", "public", "photos", photo.filename)); } catch(e) {}
  db.prepare("DELETE FROM photos WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── PUBLIC ROUTES ───────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/stats", (req, res) => {
  res.json({
    total_alumni: db.prepare("SELECT COUNT(*) as c FROM alumni").get().c,
    total_cities: db.prepare("SELECT COUNT(DISTINCT city) as c FROM alumni WHERE city IS NOT NULL AND city != ''").get().c,
    total_industries: db.prepare("SELECT COUNT(DISTINCT company) as c FROM alumni WHERE company IS NOT NULL AND company != ''").get().c,
    total_countries: db.prepare("SELECT COUNT(DISTINCT country) as c FROM alumni WHERE country IS NOT NULL AND country != ''").get().c,
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

// ── Start ───────────────────────────────────────────
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Alumni API running on port ${PORT}`);
});
