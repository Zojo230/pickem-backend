#!/usr/bin/env node

// Filter NCAAF snapshot to a date range and output APP-FORMAT records
// Usage:
//   node sidecar/filter_ncaaf_by_date.js --week 1 --from 2025-08-28 --to 2025-08-31

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, 'sidecar.config.json');
const ALIAS_PATH  = path.resolve(__dirname, 'alias-map.json');

function die(msg){ console.error('❌ ' + msg); process.exit(1); }
function loadJson(p){ if (!fs.existsSync(p)) die(`Missing file: ${p}`); return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function saveJson(p, obj){ fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); console.log(`✅ Wrote ${p}`); }

function parseArgs(){
  const args = process.argv.slice(2);
  const out = { week: null, from: null, to: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--week') out.week = Number(args[++i]);
    else if (a === '--from') out.from = String(args[++i]);
    else if (a === '--to') out.to = String(args[++i]);
  }
  if (!out.week || Number.isNaN(out.week)) die('Please provide --week <number>');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.from || '')) die('Please provide --from YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.to || '')) die('Please provide --to YYYY-MM-DD');
  if (out.from > out.to) die('--from must be <= --to');
  return out;
}

// If alias-map.json has { ncaaf: {...} }, use that slice; else treat as flat map.
function pickAliasMapForSport(aliasJson, sport) {
  if (aliasJson && typeof aliasJson === 'object' && aliasJson[sport] && typeof aliasJson[sport] === 'object') {
    return aliasJson[sport];
  }
  return aliasJson || {};
}

function normalizeTeam(name, aliasMap){
  if (!name) return name;
  if (aliasMap[name]) return aliasMap[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(aliasMap)) if (k.toLowerCase() === lower) return v;
  const norm = name.replace(/\./g,'').replace(/\s+/g,' ').trim().toLowerCase();
  for (const [k, v] of Object.entries(aliasMap)) {
    const kn = k.replace(/\./g,'').replace(/\s+/g,' ').trim().toLowerCase();
    if (kn === norm) return v;
  }
  return name;
}

// "YYYY-MM-DD hh:mm AM/PM" local time
function fmtLocal(d){
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  let h = d.getHours(); const m = String(d.getMinutes()).padStart(2,'0'); const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${yyyy}-${mm}-${dd} ${String(h).padStart(2,'0')}:${m} ${ampm}`;
}
function toAppDate(isoLike){
  if (!isoLike) return '';
  const d = new Date(isoLike);
  if (isNaN(d.getTime())) { const t = Date.parse(isoLike); return isNaN(t) ? String(isoLike) : fmtLocal(new Date(t)); }
  return fmtLocal(d);
}

function toAppRecordFromSnapshot(row, aliasMap){
  return {
    date:  toAppDate(row.startTime),
    team1: normalizeTeam(row.away, aliasMap),
    score1: Number.isFinite(row.awayScore) ? Number(row.awayScore) : 0,
    team2: normalizeTeam(row.home, aliasMap),
    score2: Number.isFinite(row.homeScore) ? Number(row.homeScore) : 0
  };
}

function withinRange(appDateStr, ymdFrom, ymdTo){
  const ymd = (appDateStr || '').slice(0, 10);
  return ymd && ymd >= ymdFrom && ymd <= ymdTo;
}

(function main(){
  const { week, from, to } = parseArgs();
  const config    = loadJson(CONFIG_PATH);
  const aliasJson = fs.existsSync(ALIAS_PATH) ? loadJson(ALIAS_PATH) : {};
  const aliasMap  = pickAliasMapForSport(aliasJson, 'ncaaf');

  const outputDir = path.resolve(config.outputDir || '../data');
  const inPath    = path.join(outputDir, `ncaaf_scores_week_${week}.json`);
  if (!fs.existsSync(inPath)) die(`Input snapshot not found: ${inPath} (run sidecar first)`);

  const snapshot   = loadJson(inPath); // array of { startTime, away, home, awayScore, homeScore, ... }
  if (!Array.isArray(snapshot)) die(`Unexpected format in ${inPath} (not an array).`);

  const appRecords = snapshot.map(row => toAppRecordFromSnapshot(row, aliasMap));
  const filtered   = appRecords.filter(rec => withinRange(rec.date, from, to));

  const outFile = path.join(outputDir, `scores_week_${week}_ncaaf_${from}_to_${to}.json`);
  saveJson(outFile, filtered);
})();
