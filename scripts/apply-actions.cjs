#!/usr/bin/env node
/*
 * apply-actions.cjs — applies scripts/merge-actions.json to the alumni DB.
 *
 *   node apply-actions.cjs <db-path>          # DRY: apply in a txn, print, ROLLBACK
 *   node apply-actions.cjs <db-path> --go     # COMMIT (takes a backup first)
 *
 * Runtime safety (re-checked against LIVE data, not the snapshot):
 *  - never writes to / deletes an alumni currently linked to a registered user
 *  - never deletes an alumni that has any dependent rows
 *  - never inserts a name that exactly matches a current unlinked registered user
 *  - 'fill' ops only write when the current value is empty; 'set' ops overwrite
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.argv[2];
const GO = process.argv.includes("--go");
if (!DB_PATH) { console.error("usage: apply-actions.cjs <db-path> [--go]"); process.exit(1); }

const actions = JSON.parse(fs.readFileSync(path.join(__dirname, "merge-actions.json"), "utf8"));
function norm(s) { return (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

(async () => {
// backup before a real run (db.backup is async in this version — must await)
if (GO) {
  const d = new Date();
  const stamp = d.toISOString().replace(/[:.]/g, "-");
  const bak = path.join(path.dirname(DB_PATH), `alumni.backup-${stamp}.db`);
  await db.backup(bak); // consistent copy, completes before any writes
  console.log("BACKUP written:", bak);
}

// live safety sets
const users = db.prepare("SELECT id, name, alumni_id FROM users").all();
const protectedIds = new Set(users.filter(u => u.alumni_id).map(u => u.alumni_id));
const unlinkedNorms = new Map(users.filter(u => !u.alumni_id && norm(u.name)).map(u => [norm(u.name), u]));
const existsStmt = db.prepare("SELECT id, name, nickname, class, birthday FROM alumni WHERE id = ?");
const DEP_TABLES = [
  ["photos", "alumni_id"], ["event_rsvp", "alumni_id"], ["users", "alumni_id"],
  ["articles", "author_id"], ["forum_threads", "author_id"], ["forum_replies", "author_id"],
  ["forum_reactions", "alumni_id"], ["dudu_reactions", "alumni_id"],
];
function deps(id) {
  let n = 0; const hit = [];
  for (const [t, c] of DEP_TABLES) { try { const k = db.prepare(`SELECT COUNT(*) x FROM ${t} WHERE ${c}=?`).get(id).x; if (k) { n += k; hit.push(`${t}:${k}`); } } catch (e) {} }
  return { n, hit };
}

const log = { updated: 0, fieldWrites: 0, fieldFillNoop: 0, inserted: 0, deleted: 0, skipped: [] };

const run = db.transaction(() => {
  // ── deletes ──
  for (const id of actions.deletes) {
    const row = existsStmt.get(id);
    if (!row) { log.skipped.push(`delete #${id}: not found`); continue; }
    if (protectedIds.has(id)) { log.skipped.push(`delete #${id} "${row.name}": now linked to a registered user — SKIP`); continue; }
    const d = deps(id);
    if (d.n) { log.skipped.push(`delete #${id} "${row.name}": has dependents (${d.hit.join(",")}) — SKIP`); continue; }
    db.prepare("DELETE FROM alumni WHERE id=?").run(id);
    log.deleted++;
  }

  // ── updates ──
  for (const u of actions.updates) {
    const row = existsStmt.get(u.id);
    if (!row) { log.skipped.push(`update #${u.id}: not found`); continue; }
    if (protectedIds.has(u.id)) { log.skipped.push(`update #${u.id} "${row.name}": now linked to a registered user — SKIP`); continue; }
    let changed = false;
    for (const op of u.ops) {
      const cur = row[op.field];
      const empty = cur == null || String(cur).trim() === "";
      if (op.mode === "fill" && !empty) { log.fieldFillNoop++; continue; }
      if (op.mode === "fill" || op.mode === "set") {
        if (String(cur || "") === String(op.value)) continue; // no-op
        db.prepare(`UPDATE alumni SET ${op.field}=? WHERE id=?`).run(op.value, u.id);
        row[op.field] = op.value; log.fieldWrites++; changed = true;
      }
    }
    if (changed) log.updated++;
  }

  // ── inserts ──
  const ins = db.prepare("INSERT INTO alumni (name, nickname, class, birthday) VALUES (?,?,?,?)");
  for (const r of actions.inserts) {
    const nn = norm(r.name);
    if (unlinkedNorms.has(nn)) { log.skipped.push(`insert "${r.name}": matches unlinked registered user #${unlinkedNorms.get(nn).id} — SKIP (shadow dup)`); continue; }
    const dup = db.prepare("SELECT id FROM alumni WHERE lower(name)=lower(?) AND ifnull(class,'')=ifnull(?,'')").get(r.name, r.class || "");
    if (dup) { log.skipped.push(`insert "${r.name}" (${r.class}): identical alumni #${dup.id} already exists — SKIP`); continue; }
    ins.run(r.name, r.nickname || null, r.class || null, r.birthday || null);
    log.inserted++;
  }

  if (!GO) { throw { ROLLBACK: true }; }
});

const before = db.prepare("SELECT COUNT(*) c FROM alumni").get().c;
try { run(); } catch (e) { if (!e.ROLLBACK) throw e; }
const after = GO ? db.prepare("SELECT COUNT(*) c FROM alumni").get().c : before;

console.log(GO ? "\n===== COMMITTED =====" : "\n===== DRY RUN (rolled back) =====");
console.log("alumni before:", before, GO ? `-> after: ${after} (net ${after - before})` : "");
console.log("updates applied:", log.updated, "| field writes:", log.fieldWrites, "| fill-skipped(had value):", log.fieldFillNoop);
console.log("inserted:", log.inserted, "| deleted:", log.deleted);
console.log("guard skips:", log.skipped.length);
log.skipped.forEach(s => console.log("   - " + s));
console.log("\nexpected (from actions): updates<=" + actions.updates.length + " inserts<=" + actions.inserts.length + " deletes<=" + actions.deletes.length);
db.close();
})().catch(e => { console.error("FATAL:", e); try { db.close(); } catch (_) {} process.exit(1); });
