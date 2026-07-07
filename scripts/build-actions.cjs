#!/usr/bin/env node
/*
 * build-actions.cjs — resolves merge-plan.json + the human review decisions
 * into a concrete, auditable operation list: scripts/merge-actions.json.
 * Read-only; produces JSON only. No DB access.
 *
 * Op field modes:  fill = write only if current DB value is empty (re-checked at apply)
 *                  set  = overwrite unconditionally (deliberate correction)
 */
const fs = require("fs");
const path = require("path");
const plan = require("./merge-plan.json");

const byName = {};
plan.review.forEach(r => { byName[r.csvName] = r; });

const DELETES = [186, 209]; // pre-existing dupes; keep registered twins #266/#275
const DELETE_ROSTER_SKIP = new Set(["Annisa Meirita", "Ishom Rofiah M."]); // their roster rows: do nothing

// class-conflict overwrites (6-class-conflicts.csv -> "Use Roster")
const CLASS_OVERRIDE = { 229: "IPA 3", 131: "IPA 3", 189: "IPA 3", 150: "IPA 4", 220: "IPA 5", 143: "IPA 6", 101: "IPS 2" };

// review decisions keyed by roster name. nameSrc/classSrc: 'db' keep | 'roster' overwrite | custom string
const D = {
  // SKIP — same as a registered user
  "Bayu Kontoro Ajie": { a: "SKIP" }, "Dimas Fahriza": { a: "SKIP" }, "Pramono Aji": { a: "SKIP" },
  "Wicaksono Nur A.": { a: "SKIP" }, "Yolani Rizki": { a: "SKIP" },
  // MERGE (CONFIRM group — keep DB name+class)
  "Kemas Abdul DH": { a: "MERGE", t: 136 }, "Priska A. Sabrina L.": { a: "MERGE", t: 156 },
  "Restriani": { a: "MERGE", t: 152 }, "Unien Retno": { a: "MERGE", t: 235 }, "Yakubus Ari W.": { a: "MERGE", t: 114 },
  // MERGE with field choices
  "Anggi Yuanita": { a: "MERGE", t: 193, classSrc: "roster" },
  "Anggraeni P.": { a: "MERGE", t: 179 },
  "Arno Disaputra": { a: "MERGE", t: 211, nameSrc: "roster" },
  "Christine Priscylla M.": { a: "MERGE", t: 55, nameSrc: "roster" },
  "Dodhy Prasetyo W": { a: "MERGE", t: 118 },
  "Ella Syaputri": { a: "MERGE", t: 257, nameSrc: "Ella Syaputri Prihatini" },
  "Flourensia Pramesti": { a: "MERGE", t: 254 },
  "Hendro Priyo P.": { a: "MERGE", t: 112, classSrc: "roster" },
  "Marsha Sri Rejeki": { a: "MERGE", t: 234, nameSrc: "roster" },
  "Martha Mozarta": { a: "MERGE", t: 104 },
  "Ninna Fardilla K.": { a: "MERGE", t: 200, nameSrc: "roster" },
  "Olivia D. Santoso": { a: "MERGE", t: 199, classSrc: "roster" }, // keep DB name (per decision)
  "Permaswari Wardani": { a: "MERGE", t: 117, nameSrc: "roster" },
  "Poppy Nirmala D.N.": { a: "MERGE", t: 160, nameSrc: "roster" },
  "Theresia Sitinjak": { a: "MERGE", t: 145, nameSrc: "roster" },
  "Wenny Retno Sari L": { a: "MERGE", t: 217 },
  "William Amelio": { a: "MERGE", t: 91 },
  "Yuslyawati": { a: "MERGE", t: 249 },
  // NEW — different people
  "Adi Nugroho": { a: "NEW" }, "Dian Andriyani": { a: "NEW" }, "Dian Varuna Dewi": { a: "NEW" },
  "Irfan Eka Putra": { a: "NEW" }, "Jojor Sri Rezeki T.": { a: "NEW" }, "Listiana Wulandari": { a: "NEW" },
  "Putri Andini": { a: "NEW" }, "Rainny Dian Fitriani": { a: "NEW" }, "Ratna Sari Dinaryanti": { a: "NEW" },
  "Resti Dwisetyo Utami": { a: "NEW" }, "Restu Pratiwi": { a: "NEW" }, "Retno Mayang Sari": { a: "NEW" },
  "Seruni Purnama Sari": { a: "NEW" }, "Sinta Dewi": { a: "NEW" }, "Wida Sari": { a: "NEW" },
};

const actions = { deletes: DELETES.slice(), updates: [], inserts: [], skips: [] };
const updById = {}; // id -> update entry
function upd(id, note) { return updById[id] || (updById[id] = { id, note, ops: [] }); }

// ── 1) auto-merge backfills (skip the two deleted-target roster rows) ──
plan.backfill.forEach(e => {
  if (DELETES.includes(e.dbId)) { actions.skips.push({ what: "backfill of deleted dup", roster: e.csvName, id: e.dbId }); return; }
  const u = upd(e.dbId, `auto-merge <= "${e.csvName}"`);
  Object.entries(e.set).forEach(([f, v]) => u.ops.push({ field: f, value: v, mode: "fill" }));
});

// ── 2) class-conflict overwrites ──
Object.entries(CLASS_OVERRIDE).forEach(([id, cls]) => {
  const u = upd(+id, (updById[+id] ? updById[+id].note : "class conflict") + " | class->roster");
  // replace any existing class op, force set
  u.ops = u.ops.filter(o => o.field !== "class");
  u.ops.push({ field: "class", value: cls, mode: "set" });
});

// ── 3) review decisions ──
Object.entries(D).forEach(([name, d]) => {
  const row = byName[name];
  if (!row) { console.error("WARN: review row not found:", name); return; }
  if (d.a === "SKIP") { actions.skips.push({ what: "same as registered user", roster: name, id: d.t }); return; }
  if (d.a === "NEW") { actions.inserts.push({ name: row.csvName, class: row.class, nickname: row.nickname, birthday: row.birthday, src: "review-NEW" }); return; }
  if (d.a === "MERGE") {
    const u = upd(d.t, `review merge <= "${name}"`);
    if (d.nameSrc === "roster") u.ops.push({ field: "name", value: row.csvName, mode: "set" });
    else if (d.nameSrc && d.nameSrc !== "db") u.ops.push({ field: "name", value: d.nameSrc, mode: "set" });
    if (d.classSrc === "roster") { u.ops = u.ops.filter(o => o.field !== "class"); u.ops.push({ field: "class", value: row.class, mode: "set" }); }
    if (row.nickname) u.ops.push({ field: "nickname", value: row.nickname, mode: "fill" });
    if (row.birthday) u.ops.push({ field: "birthday", value: row.birthday, mode: "fill" });
  }
});

// ── 4) genuinely-new roster rows ──
plan.new.forEach(n => actions.inserts.push({ name: n.name, class: n.class, nickname: n.nickname, birthday: n.birthday, src: "roster-new" }));

actions.updates = Object.values(updById).filter(u => u.ops.length);

fs.writeFileSync(path.join(__dirname, "merge-actions.json"), JSON.stringify(actions, null, 2));
console.log("deletes:", actions.deletes.length, "| updates:", actions.updates.length, "| inserts:", actions.inserts.length, "(review-NEW:", actions.inserts.filter(i => i.src === "review-NEW").length + ")", "| skips:", actions.skips.length);
console.log("ops with mode=set (overwrites):", actions.updates.flatMap(u => u.ops).filter(o => o.mode === "set").length);
console.log("wrote scripts/merge-actions.json");
