#!/usr/bin/env node
/*
 * merge-dryrun.cjs — DRY RUN ONLY. Reads, never writes.
 *
 * Merges merged_classes_ed.csv (master class roster) into the alumni DB.
 * From the CSV we use ONLY: Kelas -> class, Nama -> name, Nick -> nickname,
 * Tanggal Lahir -> birthday. All other CSV columns are intentionally ignored.
 *
 * Rules:
 *  - Existing alumni (linked or not): backfill ONLY empty class/nickname/birthday.
 *    Never overwrite an existing value; never touch name/email/city/job/etc.
 *  - New alumni: insert name/class/nickname/birthday only (email left null).
 *  - Matching is multi-pass; anything not high-confidence goes to a REVIEW list.
 *
 * Usage: node scripts/merge-dryrun.cjs [path/to/alumni.db]
 * Output: console report + scripts/merge-plan.json
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.argv[2] || path.join(__dirname, "alumni-snapshot.db");
const CSV_PATH = path.join(__dirname, "..", "merged_classes_ed.csv");

// ── CSV parser (quoted-comma safe) ──────────────────────────────
function parseCSV(t) {
  const rows = [];
  let f = "", row = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
      else if (c === "\r") { /* skip */ }
      else f += c;
    }
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// ── Name normalization ──────────────────────────────────────────
const HONORIFICS = new Set([
  "rr", "ra", "raden", "tb", "dr", "drs", "ir", "hj", "haji", "prof",
  "phd", "md", "st", "se", "mm", "mba", "spd", "msi", "mkes"
]);
function norm(s) {
  return (s || "").toLowerCase().normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip diacritics
    .replace(/[^a-z0-9 ]/g, " ")        // punctuation -> space
    .replace(/\s+/g, " ").trim();
}
function tokens(s) {
  return norm(s).split(" ").filter(Boolean).filter(t => !HONORIFICS.has(t));
}
function words(toks) { return toks.filter(t => t.length >= 2); }
function initials(toks) { return toks.filter(t => t.length === 1); }

function eqMultiset(a, b) {
  if (a.length !== b.length) return false;
  const m = {};
  a.forEach(x => m[x] = (m[x] || 0) + 1);
  for (const x of b) { if (!m[x]) return false; m[x]--; }
  return true;
}
// every word of `short` is present in `long`'s words
function wordsSubset(short, long) {
  const set = new Set(long);
  return short.every(w => set.has(w));
}
function sharedCount(a, b) {
  const set = new Set(b);
  return a.filter(x => set.has(x)).length;
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// ── Birthday DD-MM-YYYY -> YYYY-MM-DD ───────────────────────────
function convBirthday(s) {
  s = (s || "").trim();
  const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return { val: null, raw: s, bad: !!s };
  let [_, d, mo, y] = m;
  d = +d; mo = +mo;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return { val: null, raw: s, bad: true };
  const pad = n => String(n).padStart(2, "0");
  return { val: `${y}-${pad(mo)}-${pad(d)}`, raw: s, bad: false };
}

// ── Load DB ──────────────────────────────────────────────────────
const db = new Database(DB_PATH, { readonly: true });
const alumni = db.prepare(`
  SELECT a.id, a.name, a.nickname, a.class, a.birthday, a.email,
    (SELECT COUNT(*) FROM users u WHERE u.alumni_id = a.id) AS linked
  FROM alumni a ORDER BY a.id`).all();
alumni.forEach(a => {
  a._toks = tokens(a.name);
  a._words = words(a._toks);
});

// Registered users — MUST NOT be touched.
//  - protectedAlumni: alumni rows a registered user is linked to (no writes at all)
//  - unlinkedUsers: registered users with no alumni link yet; inserting a roster
//    row that IS one of these people would create a shadow duplicate, so hold it.
const usersRaw = db.prepare("SELECT id, email, name, alumni_id, status FROM users").all();
const protectedAlumni = new Set(usersRaw.filter(u => u.alumni_id).map(u => u.alumni_id));
const unlinkedUsers = usersRaw.filter(u => !u.alumni_id).map(u => ({ ...u, _toks: tokens(u.name), _words: words(tokens(u.name)) }));
console.error(`[users] total=${usersRaw.length} linked=${protectedAlumni.size} unlinked=${unlinkedUsers.length}`);

// ── Load CSV ─────────────────────────────────────────────────────
const rows = parseCSV(fs.readFileSync(CSV_PATH, "utf8"));
const csv = rows.slice(1)
  .filter(r => r.length > 4 && r[4] && r[4].trim())
  .map(r => {
    const bd = convBirthday(r[7]);
    return {
      name: r[4].trim(),
      class: (r[0] || "").trim(),
      nickname: (r[5] || "").trim(),
      birthday: bd.val,
      birthdayBad: bd.bad,
      _toks: tokens(r[4]),
      _words: words(tokens(r[4])),
    };
  });

// ── Matching ─────────────────────────────────────────────────────
// tier priority (lower = higher confidence)
const TIER = { exact: 0, abbrev_strong: 1, review_typo: 2, review_multi: 3, review_diffclass: 4, review_weak: 5 };

function classify(c, a) {
  const cw = c._words, aw = a._words;
  const ct = c._toks, at = a._toks;
  const sameClass = c.class && a.class && norm(c.class) === norm(a.class);
  if (eqMultiset(ct, at)) return "exact";
  const shared = sharedCount(cw, aw);
  const subset = wordsSubset(cw, aw) || wordsSubset(aw, cw);
  // near-identical full string within same class = almost certainly a typo variant
  const editSame = sameClass && levenshtein(norm(c.name), norm(a.name)) <= 2
    && Math.abs(norm(c.name).length - norm(a.name).length) <= 3;
  if (sameClass) {
    if (subset && shared >= 2) return "abbrev_strong";
    if (editSame) return "review_typo";
    if (shared >= 2) return "review_multi";
    if (shared === 1) return "review_weak";
    return null;
  } else {
    if (shared >= 2) return "review_diffclass";
    return null;
  }
}

const claimedAuto = new Set(); // db ids consumed by an auto-merge
const plan = { backfill: [], noop: [], new: [], review: [], conflicts: [], protectedSkip: [], heldForRegistered: [] };

// Does this CSV roster row correspond to an existing (unlinked) registered user?
// If so we must NOT insert it as a new alumni (that would shadow-duplicate a real user).
function matchUnlinkedUser(c) {
  const cn = norm(c.name), cw = c._words;
  for (const u of unlinkedUsers) {
    if (!u._words.length) continue;                      // junk names ("null","Tester")
    if (cn === norm(u.name)) return { ...u, how: "exact" };
    if (levenshtein(cn, norm(u.name)) <= 1) return { ...u, how: "typo" };
    const sh = sharedCount(cw, u._words);
    const subset = wordsSubset(cw, u._words) || wordsSubset(u._words, cw);
    if (subset && sh >= 1) return { ...u, how: "abbrev" };
  }
  return null;
}

// pass 1: gather best candidate per csv row
const scored = csv.map(c => {
  const cands = [];
  for (const a of alumni) {
    const tier = classify(c, a);
    if (tier) cands.push({ a, tier, p: TIER[tier] });
  }
  cands.sort((x, y) => x.p - y.p);
  return { c, cands };
});
// process auto-confident first so they claim db rows before weaker rows
scored.sort((A, B) => (A.cands[0] ? A.cands[0].p : 99) - (B.cands[0] ? B.cands[0].p : 99));

for (const { c, cands } of scored) {
  // pick best not-yet-auto-claimed candidate
  let best = cands.find(x => !claimedAuto.has(x.a.id)) || cands[0];
  if (!best) { // no alumni match -> would be a NEW insert, unless it's a registered (unlinked) user
    const u = matchUnlinkedUser(c);
    if (u) {
      plan.heldForRegistered.push({ csvName: c.name, class: c.class, nickname: c.nickname || null, birthday: c.birthday, userId: u.id, userEmail: u.email, userName: u.name, how: u.how });
    } else {
      plan.new.push({ name: c.name, class: c.class, nickname: c.nickname || null, birthday: c.birthday });
    }
    continue;
  }
  const auto = best.tier === "exact" || best.tier === "abbrev_strong";
  if (auto) {
    const a = best.a;
    claimedAuto.add(a.id);
    // Registered user linked to this alumni -> DO NOT TOUCH. Record and skip.
    if (protectedAlumni.has(a.id)) {
      plan.protectedSkip.push({ dbId: a.id, dbName: a.name, csvName: c.name, tier: best.tier });
      continue;
    }
    const set = {};
    if ((!a.class || !a.class.trim()) && c.class) set.class = c.class;
    if ((!a.nickname || !a.nickname.trim()) && c.nickname) set.nickname = c.nickname;
    if ((!a.birthday || !a.birthday.trim()) && c.birthday) set.birthday = c.birthday;
    // record conflicts (differing non-empty class) — reported, NOT applied
    if (a.class && a.class.trim() && c.class && norm(a.class) !== norm(c.class)) {
      plan.conflicts.push({ dbId: a.id, field: "class", db: a.class, csv: c.class, name: a.name });
    }
    const entry = { dbId: a.id, dbName: a.name, csvName: c.name, linked: a.linked, tier: best.tier, set };
    if (Object.keys(set).length) plan.backfill.push(entry);
    else plan.noop.push(entry);
  } else {
    plan.review.push({
      csvName: c.name, class: c.class, nickname: c.nickname || null, birthday: c.birthday,
      candidates: cands.slice(0, 3).map(x => ({ dbId: x.a.id, dbName: x.a.name, dbClass: x.a.class, linked: x.a.linked, tier: x.tier }))
    });
  }
}

// ── Suspected pre-existing in-DB duplicates ──────────────────────
const dbDup = [];
for (let i = 0; i < alumni.length; i++) {
  for (let j = i + 1; j < alumni.length; j++) {
    const a = alumni[i], b = alumni[j];
    const sig = a._words.filter(w => w.length >= 3);
    const shared = sharedCount(sig, b._words.filter(w => w.length >= 3));
    if (eqMultiset(a._toks, b._toks) || shared >= 2) {
      dbDup.push({ a: { id: a.id, name: a.name, class: a.class, linked: a.linked }, b: { id: b.id, name: b.name, class: b.class, linked: b.linked }, shared });
    }
  }
}

// ── Report ───────────────────────────────────────────────────────
const linkedTouched = plan.backfill.filter(e => e.linked).length;
console.log("========================================================");
console.log("  MERGE DRY RUN — merged_classes_ed.csv  (NO WRITES)");
console.log("  DB:", DB_PATH);
console.log("========================================================");
console.log("CSV roster rows:        ", csv.length);
console.log("DB alumni:              ", alumni.length, "(linked to a user:", alumni.filter(a => a.linked).length + ")");
console.log("");
console.log("AUTO-MERGE (backfill empty fields):", plan.backfill.length);
console.log("   of which touch a LINKED user:   ", linkedTouched, "(should be 0 — protected)");
console.log("AUTO-MATCH but nothing to fill:    ", plan.noop.length);
console.log("PROTECTED (linked to reg. user) skip:", plan.protectedSkip.length);
console.log("NEW inserts:                       ", plan.new.length);
console.log("HELD — matches unlinked reg. user: ", plan.heldForRegistered.length);
console.log("NEEDS REVIEW (ambiguous):          ", plan.review.length);
console.log("Class conflicts (reported only):   ", plan.conflicts.length);
console.log("Suspected pre-existing DB dupes:   ", dbDup.length);
console.log("Bad/again birthday parse in CSV:   ", csv.filter(c => c.birthdayBad).length);
console.log("Sanity: all buckets =", plan.backfill.length + plan.noop.length + plan.protectedSkip.length + plan.new.length + plan.heldForRegistered.length + plan.review.length, "(should equal", csv.length + ")");

console.log("\n----- PROTECTED: linked to a registered user, ZERO writes -----");
plan.protectedSkip.forEach(e => console.log(`  #${e.dbId} "${e.dbName}"  (roster: "${e.csvName}") [${e.tier}]`));

console.log("\n----- HELD: roster row IS an unlinked registered user — NOT inserted -----");
plan.heldForRegistered.forEach(e => console.log(`  roster "${e.csvName}" (${e.class}) == user#${e.userId} ${e.userEmail} "${e.userName}" [${e.how}]`));

console.log("\n----- SAMPLE AUTO-MERGE (first 20) -----");
plan.backfill.slice(0, 20).forEach(e =>
  console.log(`  #${e.dbId} "${e.dbName}"${e.linked ? " *LINKED*" : ""}  [${e.tier}]  <= ${JSON.stringify(e.set)}`));

console.log("\n----- NEEDS REVIEW (all, best candidate first) -----");
const revOrder = ["review_typo", "review_multi", "review_diffclass", "review_weak"];
const revByTier = {};
plan.review.forEach(r => { const t = r.candidates[0] ? r.candidates[0].tier : "?"; (revByTier[t] = revByTier[t] || []).push(r); });
console.log("  tiers:", revOrder.map(t => `${t}=${(revByTier[t] || []).length}`).join("  "));
revOrder.forEach(t => (revByTier[t] || []).forEach(r => {
  console.log(`  [${t}] CSV "${r.csvName}" (${r.class})`);
  r.candidates.forEach(x => console.log(`       ? #${x.dbId} "${x.dbName}" (${x.dbClass})${x.linked ? " *LINKED*" : ""} [${x.tier}]`));
}));

console.log("\n----- CLASS CONFLICTS (existing value kept, NOT changed) -----");
plan.conflicts.forEach(c => console.log(`  #${c.dbId} "${c.name}": DB=${c.db}  CSV=${c.csv}`));

console.log("\n----- SUSPECTED PRE-EXISTING DB DUPLICATES -----");
dbDup.forEach(d => console.log(`  #${d.a.id} "${d.a.name}" (${d.a.class})${d.a.linked ? "*L*" : ""}  <=>  #${d.b.id} "${d.b.name}" (${d.b.class})${d.b.linked ? "*L*" : ""}  shared=${d.shared}`));

console.log("\n----- SAMPLE NEW INSERTS (first 25 of " + plan.new.length + ") -----");
plan.new.slice(0, 25).forEach(n => console.log(`  + "${n.name}" (${n.class}) nick=${n.nickname || "-"} bd=${n.birthday || "-"}`));

fs.writeFileSync(path.join(__dirname, "merge-plan.json"), JSON.stringify({ ...plan, dbDup }, null, 2));
console.log("\nWrote scripts/merge-plan.json");
db.close();
