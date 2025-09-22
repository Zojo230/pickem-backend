/**
 * export_spreads.js
 * Writes /mnt/data/games_week_<WEEK>.json in the app's expected shape:
 * [
 *   { "date":"YYYY-MM-DD hh:mm AM/PM", "team1":"", "spread1":-3.5, "team2":"", "spread2":3.5 },
 *   ...
 * ]
 * MOCK mode (MOCK=1) reads ./mock_jsonodds.json.
 * (We’ll add live fetch next.)
 */
const fs = require("fs");
const path = require("path");

const cfg = require("./sidecar.config.json");
let alias = {};
try { alias = require("./alias-map.json"); } catch (_) {}

/** Which week to write */
const WEEK = process.env.WEEK || "4";
const OUT = path.join(cfg.outputDir, `games_week_${WEEK}.json`);
const MOCK = process.env.MOCK === "1";

/** Canonicalize team names to ESPN style via alias map */
function canon(name) {
  return (alias[name] || name).trim();
}

/** Format an ISO date/time into Central time in app’s “YYYY-MM-DD hh:mm AM/PM” */
function formatCentral(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: cfg.timezone || "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true
  }).formatToParts(d).reduce((o,p)=> (o[p.type]=p.value, o), {});
  const ampm = String(parts.dayPeriod || "").toUpperCase();
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${ampm}`;
}

/** Write pretty JSON */
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log("Wrote", file, `(${data.length} games)`);
}

let rows;
if (MOCK) {
  // mock row shape: { startTime, homeTeam, awayTeam, spreadHome, spreadAway }
  rows = require("./mock_jsonodds.json");
} else {
  console.log("Live fetch not enabled yet in this step. Re-run with MOCK=1 for now.");
  process.exit(0);
}

/** Transform to app schema */
const games = rows.map(r => ({
  date:   formatCentral(r.startTime),
  team1:  canon(r.awayTeam),
  spread1: (typeof r.spreadAway === "number") ? r.spreadAway : null,
  team2:  canon(r.homeTeam),
  spread2: (typeof r.spreadHome === "number") ? r.spreadHome : null
})).sort((a,b) => a.date.localeCompare(b.date));

writeJson(OUT, games);
