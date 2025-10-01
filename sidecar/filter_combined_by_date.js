#!/usr/bin/env node

// Filter the COMBINED app-format file (scores_week_<W>.json) to a date range.
// Usage:
//   node sidecar/filter_combined_by_date.js --week 1 --from 2025-08-28 --to 2025-08-31
//   node sidecar/filter_combined_by_date.js --week 1 --from 2025-08-28 --to 2025-08-31 --overwrite

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, 'sidecar.config.json');

function die(msg){ console.error('❌ ' + msg); process.exit(1); }
function loadJson(p){
  if (!fs.existsSync(p)) die(`Missing file: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8') || '[]');
}
function saveJson(p, obj){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  console.log(`✅ Wrote ${p}`);
}
function parseArgs(){
  const args = process.argv.slice(2);
  const out = { week: null, from: null, to: null, overwrite: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--week') out.week = Number(args[++i]);
    else if (a === '--from') out.from = String(args[++i]);
    else if (a === '--to') out.to = String(args[++i]);
    else if (a === '--overwrite') out.overwrite = true;
  }
  if (!out.week || Number.isNaN(out.week)) die('Please provide --week <number>');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.from || '')) die('Please provide --from YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.to || '')) die('Please provide --to YYYY-MM-DD');
  if (out.from > out.to) die('--from must be <= --to');
  return out;
}
function withinRange(appDateStr, ymdFrom, ymdTo) {
  // appDateStr looks like "YYYY-MM-DD hh:mm AM/PM"
  const ymd = (appDateStr || '').slice(0, 10);
  return ymd && ymd >= ymdFrom && ymd <= ymdTo;
}

(function main(){
  const { week, from, to, overwrite } = parseArgs();
  const config = loadJson(CONFIG_PATH);
  const outputDir = path.resolve(config.outputDir || '../data');

  const inPath = path.join(outputDir, `scores_week_${week}.json`);
  const data = loadJson(inPath);
  if (!Array.isArray(data)) die(`Unexpected format in ${inPath} (not an array).`);

  const filtered = data.filter(rec => withinRange(rec.date, from, to));

  const outPath = overwrite
    ? inPath
    : path.join(outputDir, `scores_week_${week}_${from}_to_${to}.json`);

  saveJson(outPath, filtered);
})();

