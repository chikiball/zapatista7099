#!/usr/bin/env node
/*
 * make-review-files.cjs — turns merge-plan.json + live user list into
 * human-reviewable CSV files under merge-review/.  Read-only; writes CSVs only.
 *
 * The only file you must edit is 1-DECIDE-review.csv (the DECISION column).
 * Everything else is FYI so you can audit what the apply step will do.
 */
const fs = require("fs");
const path = require("path");

const plan = require("./merge-plan.json");
const users = require("./srv-users.json");
const OUT = path.join(__dirname, "..", "merge-review");
fs.mkdirSync(OUT, { recursive: true });

const protectedIds = new Set(users.filter(u => u.alumni_id).map(u => u.alumni_id));

function cell(v) {
  v = v == null ? "" : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function writeCSV(file, headers, rows) {
  const body = [headers.join(",")].concat(rows.map(r => r.map(cell).join(","))).join("\n");
  fs.writeFileSync(path.join(OUT, file), body + "\n");
  console.log(`  ${file}  (${rows.length} rows)`);
}

// ── Per-row verdicts for the 43 review items (keyed by roster name) ──
// MERGE #id = same person, fold roster data into that alumni (backfill empty only)
// NEW        = different person, insert as a brand-new alumni
// SKIP #id   = same person, but that alumni is a REGISTERED user -> do nothing
// CONFIRM    = genuinely ambiguous, you must decide (my lean is in the note)
const DECIDE = {
  // -- same as a REGISTERED user -> SKIP --
  "Yolani Rizki":            ["SKIP", 233, "Same as registered #233 Yolani Rizky (typo). Do nothing."],
  "Dimas Fahriza":           ["SKIP", 80,  "Same as registered #80 Dimas Fahrieza (typo). Do nothing."],
  "Bayu Kontoro Ajie":       ["SKIP", 218, "Same as registered #218 Bayu kuntoro ajie (typo). Do nothing."],
  "Wicaksono Nur A.":        ["SKIP", 100, "Same as registered #100 Wicaksono NA (abbrev). Do nothing."],
  "Pramono Aji":             ["SKIP", 223, "Same as registered #223 Agustinus Pramono Ajie. Do nothing."],
  // -- same person, NOT registered -> MERGE --
  "Marsha Sri Rejeki":       ["MERGE", 234, "Rejeki/Rezeki spelling."],
  "Permaswari Wardani":      ["MERGE", 117, "wardanj = wardani typo."],
  "Martha Mozarta":          ["MERGE", 104, "Mozarta/Mozartha."],
  "Wenny Retno Sari L":      ["MERGE", 217, "Sari L = Sarie Lestari."],
  "Dodhy Prasetyo W":        ["MERGE", 118, "Dodhy P. Wijayanto = Dodhy Prasetyo W."],
  "Flourensia Pramesti":     ["MERGE", 254, "Flourensia/Florensia."],
  "Ella Syaputri":           ["MERGE", 257, "Syaputri = Syafputri."],
  "Anggraeni P.":            ["MERGE", 179, "P. = Puspitasari."],
  "Ninna Fardilla K.":       ["MERGE", 200, "Fardilla/Faradilla."],
  "Yuslyawati":              ["MERGE", 249, "Same, DB has ', S.T.' suffix."],
  "Theresia Sitinjak":       ["MERGE", 145, "Only Theresia in IPA 8."],
  "Christine Priscylla M.":  ["MERGE", 55,  "Priscylla/Phriscylla."],
  "Poppy Nirmala D.N.":      ["MERGE", 160, "Only Poppy in IPS 3."],
  "Arno Disaputra":          ["MERGE", 211, "Only Arno in IPS 2."],
  "Hendro Priyo P.":         ["MERGE", 112, "Same. DB class=PINDAHAN; roster says IPA 6 (see class-conflicts)."],
  "Olivia D. Santoso":       ["MERGE", 199, "Same. DB class=PINDAHAN; roster says IPA 7 (see class-conflicts)."],
  "William Amelio":          ["MERGE", 91,  "Same person. Class disagrees: DB IPA 5 vs roster IPA 6 — verify."],
  "Anggi Yuanita":           ["MERGE", 193, "Same person. Class disagrees: DB IPS 3 vs roster IPS 2 — verify."],
  // -- different people (share one token) -> NEW --
  "Ratna Sari Dinaryanti":   ["NEW", "", "Different from #250 Ratna Mustika Sari."],
  "Seruni Purnama Sari":     ["NEW", "", "Different from #135 Santi Purnama Sari."],
  "Jojor Sri Rezeki T.":     ["NEW", "", "Different from #234 Marsha Sri Rezeki."],
  "Adi Nugroho":             ["NEW", "", "Different from #181 Moh. Taufan Nugroho."],
  "Wida Sari":               ["NEW", "", "Different from #254 Florensia (shared 'Sari')."],
  "Resti Dwisetyo Utami":    ["NEW", "", "Different from #109 Yosi utami."],
  "Retno Mayang Sari":       ["NEW", "", "Different from #135 Santi Purnama Sari."],
  "Listiana Wulandari":      ["NEW", "", "Different from #126 Novrita wulandari."],
  "Putri Andini":            ["NEW", "", "Different from #226 Nada putri p."],
  "Irfan Eka Putra":         ["NEW", "", "NOT registered #57 (shared 'Eka'). Insert new; leave #57 alone."],
  "Dian Varuna Dewi":        ["NEW", "", "NOT registered #94 (shared 'Dewi'). Insert new; leave #94 alone."],
  "Sinta Dewi":              ["NEW", "", "NOT registered #94 (shared 'Dewi'). Insert new; leave #94 alone."],
  "Dian Andriyani":          ["NEW", "", "NOT registered #268 (shared 'Dian'). Insert new; leave #268 alone."],
  "Rainny Dian Fitriani":    ["NEW", "", "NOT registered #268 (shared 'Dian'). Insert new; leave #268 alone."],
  "Restu Pratiwi":           ["NEW", "", "NOT registered #214 (shared 'Pratiwi'). Insert new; leave #214 alone."],
  // -- genuinely ambiguous -> CONFIRM (my lean in note) --
  "Restriani":               ["CONFIRM", 152, "Lean SAME as #152 Esti Restriani (same class). Confirm."],
  "Unien Retno":             ["CONFIRM", 235, "'Unien' is rare; maybe same as #235 Unien Anjarsari, maybe two people. Confirm."],
  "Yakubus Ari W.":          ["CONFIRM", 114, "Maybe #114 Ari Wicaksono (W.=Wicaksono?). Confirm."],
  "Kemas Abdul DH":          ["CONFIRM", 136, "Lean DIFFERENT from #136 Kemas Harjanto ('Kemas' is a clan title). Confirm."],
  "Priska A. Sabrina L.":    ["CONFIRM", 156, "Maybe #156 Priska Akwila (A.=Akwila?). Confirm."],
};

// ── 1) The decision file ────────────────────────────────────────
const revRows = plan.review.map(r => {
  const d = DECIDE[r.csvName] || ["CONFIRM", "", "(no default — please decide)"];
  const c0 = r.candidates[0] || {};
  return [
    r.candidates[0] ? r.candidates[0].tier : "",
    r.csvName, r.class, r.nickname, r.birthday,
    d[0],            // my verdict
    d[0],            // DECISION (edit this: MERGE <id> / NEW / SKIP)
    d[1],            // target_db_id (for MERGE/SKIP)
    c0.dbName || "", c0.dbClass || "",
    protectedIds.has(c0.dbId) ? "YES" : "",
    d[2],
  ];
});
// order: SKIP, CONFIRM, then by tier for the rest — surface the ones needing thought
const rank = { SKIP: 0, CONFIRM: 1, MERGE: 2, NEW: 3 };
revRows.sort((a, b) => (rank[a[5]] - rank[b[5]]) || a[1].localeCompare(b[1]));
writeCSV("1-DECIDE-review.csv",
  ["match_tier", "roster_name", "roster_class", "roster_nickname", "roster_birthday",
   "my_verdict", "DECISION", "target_db_id", "candidate_db_name", "candidate_db_class",
   "candidate_is_registered", "note"],
  revRows);

// ── 2) Auto-merge (FYI) ─────────────────────────────────────────
writeCSV("2-auto-merge.csv",
  ["db_id", "db_name", "roster_name", "match_tier", "fills"],
  plan.backfill.map(e => [e.dbId, e.dbName, e.csvName, e.tier, JSON.stringify(e.set)]));

// ── 3) New inserts (FYI, scannable) ─────────────────────────────
writeCSV("3-new-inserts.csv",
  ["name", "class", "nickname", "birthday"],
  plan.new.map(n => [n.name, n.class, n.nickname, n.birthday]));

// ── 4) Protected: linked to a registered user, zero writes ──────
writeCSV("4-protected-registered.csv",
  ["db_id", "db_name", "roster_name", "match_tier"],
  plan.protectedSkip.map(e => [e.dbId, e.dbName, e.csvName, e.tier]));

// ── 5) Held: roster row IS an unlinked registered user ──────────
writeCSV("5-held-registered.csv",
  ["roster_name", "class", "user_id", "user_email", "user_name", "match"],
  plan.heldForRegistered.map(e => [e.csvName, e.class, e.userId, e.userEmail, e.userName, e.how]));

// ── 6) Class conflicts (existing kept, reported only) ───────────
writeCSV("6-class-conflicts.csv",
  ["db_id", "db_name", "db_class", "roster_class"],
  plan.conflicts.map(c => [c.dbId, c.name, c.db, c.csv]));

// ── 7) Pre-existing DB duplicates (manual cleanup) ──────────────
writeCSV("7-db-duplicates.csv",
  ["a_id", "a_name", "a_class", "a_registered", "b_id", "b_name", "b_class", "b_registered", "shared_tokens"],
  plan.dbDup.map(d => [d.a.id, d.a.name, d.a.class, protectedIds.has(d.a.id) ? "YES" : "",
                       d.b.id, d.b.name, d.b.class, protectedIds.has(d.b.id) ? "YES" : "", d.shared]));

console.log("\nAll files written to merge-review/");
