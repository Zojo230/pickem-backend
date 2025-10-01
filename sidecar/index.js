#!/usr/bin/env node
/**
 * Sidecar: JsonOdds -> weekly score files (NFL + NCAAF)
 * - Fetches RESULTS (scores) + MATCHES (teams), joins by ID
 * - Saves raw vendor payloads for debugging
 * - Writes per-sport snapshots + combined app-format file
 *
 * Results contain scores + ID; Matches contain HomeTeam/AwayTeam + MatchTime.
 * Result.Id links to a match-up (Match.Id). We fetch both and join.
 */

const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');

const CONFIG_PATH = path.resolve(__dirname, 'sidecar.config.json');
const ALIAS_PATH  = path.resolve(__dirname, 'alias-map.json');

// ---------------- core utils ----------------
function loadJson(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing file: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}
function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  console.log(`✅ Wrote ${p}`);
}
function die(msg){ console.error('❌ ' + msg); process.exit(1); }
function fmtLocal(d) {
  try {
    const cfg = loadJson(CONFIG_PATH);
    return new Date(d).toLocaleString('en-US', {
      timeZone: (cfg.timezone || 'America/Chicago'),
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', minute: '2-digit', hour12: true
    }).replace(',', '');
  } catch {
    return new Date(d).toISOString();
  }
}
function isFiniteNumber(x){ return Number.isFinite(x) && !Number.isNaN(x); }

// ---------------- CLI ----------------
function parseArgs() {
  const args = process.argv.slice(2);
  const out = { week: null, season: null, outDir: null, mock: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--week') out.week = Number(args[++i]);
    else if (a === '--season') out.season = Number(args[++i]); // unused, kept for symmetry
    else if (a === '--out') out.outDir = args[++i];
    else if (a === '--mock') out.mock = true;
  }
  if (!out.week || Number.isNaN(out.week)) {
    console.error('❌ Please provide --week <number>');
    process.exit(1);
  }
  return out;
}

// GET JSON with redirect following (301/302/307/308)
function fetchJsonFollow(url, headers = {}, hop = 0) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers['location'];
      if ([301,302,307,308].includes(status) && location && hop < 5) {
        const nextUrl = new URL(location, url).toString();
        console.log('↪️  Following redirect to:', nextUrl);
        res.resume();
        return resolve(fetchJsonFollow(nextUrl, headers, hop + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (status >= 200 && status < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
        } else {
          reject(new Error('HTTP ' + status + ' — ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------- alias helpers ----------------
function pickAliasMapForSport(aliasJson, sport) {
  if (aliasJson && typeof aliasJson === 'object' && aliasJson[sport] && typeof aliasJson[sport] === 'object') {
    return aliasJson[sport];
  }
  return aliasJson || {};
}
function normalizeTeam(name, aliasMap) {
  if (!name) return name;
  if (aliasMap[name]) return aliasMap[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(aliasMap)) if (k.toLowerCase() === lower) return v;
  const trimmed = name.replace(/\./g,'').replace(/\s+/g,' ').trim().toLowerCase();
  for (const [k, v] of Object.entries(aliasMap)) {
    const kt = k.replace(/\./g,'').replace(/\s+/g,' ').trim().toLowerCase();
    if (kt === trimmed) return v;
  }
  return name;
}

// ---------------- app-format helper ----------------
function toAppRecord(startIso, away, home, awayScore, homeScore, aliasMap){
  return {
    date: fmtLocal(startIso),
    team1: normalizeTeam(away, aliasMap),
    score1: isFiniteNumber(awayScore) ? Number(awayScore) : 0,
    team2: normalizeTeam(home, aliasMap),
    score2: isFiniteNumber(homeScore) ? Number(homeScore) : 0
  };
}

// ---------------- JsonOdds fetchers ----------------
async function fetchResultsAndMatchesForSport(baseUrl, sport, cfg){
  const headers = { 'x-api-key': cfg.apiKey };
  // Results (scores)
  const scoresUrl = `${baseUrl}${cfg.scoresEndpointBase}/${sport}?${new URLSearchParams(cfg.scoresParams)}`;
  // Matches (home/away + time)
  const matchesUrl = `${baseUrl}${cfg.oddsEndpointBase}/${sport}?${new URLSearchParams(cfg.oddsParams)}`;

  console.log('GET', scoresUrl);
  const resultsPayload = await fetchJsonFollow(scoresUrl, headers);
  console.log('GET', matchesUrl);
  const matchesPayload = await fetchJsonFollow(matchesUrl, headers);
  return { resultsPayload, matchesPayload };
}

function indexById(arr){
  const out = new Map();
  for (const x of arr || []) out.set(String(x.Id || x.ID || x.id || x.matchId || x.MatchId || x.MatchID || ''), x);
  return out;
}

function pickHomeAwayFromMatch(m){
  // JsonOdds odds/matches payload uses HomeTeam/AwayTeam and MatchTime
  const home = m?.HomeTeam ?? m?.Home ?? m?.homeTeam ?? m?.home ?? m?.Team2 ?? m?.team2 ?? '';
  const away = m?.AwayTeam ?? m?.Away ?? m?.awayTeam ?? m?.away ?? m?.Team1 ?? m?.team1 ?? '';
  const startTime = m?.MatchTime ?? m?.StartTime ?? m?.kickoff ?? m?.DateTime ?? '';
  return { home, away, startTime };
}

function pickScoresFromResult(r){
  // JsonOdds results payload uses AwayScore/HomeScore and Status
  const awayScore = r.AwayScore ?? r.awayScore ?? r.Score1 ?? r.score1 ?? null;
  const homeScore = r.HomeScore ?? r.homeScore ?? r.Score2 ?? r.score2 ?? null;
  const status = r.Status || r.status || '';
  return { awayScore, homeScore, status };
}

(async function main(){
  const { week, outDir, mock } = parseArgs();
  const config   = loadJson(CONFIG_PATH);
  const baseUrl  = config.baseUrl || die('Missing baseUrl in sidecar.config.json');
  const sports   = Array.isArray(config.sports) && config.sports.length ? config.sports : ['ncaaf','nfl'];
  const aliasJson= loadJson(ALIAS_PATH);
  const outputDir= path.resolve(outDir || config.outputDir || '../data');

  const perSportSnapshots = {}; // joined snapshot
  const perSportApps      = {}; // app-format records
  const combinedWithTs    = []; // [{ app, ts }]

  for (const sport of sports){
    console.log(`\n===== SPORT: ${sport.toUpperCase()} (week ${week}) =====`);

    const aliasMap = pickAliasMapForSport(aliasJson, sport);
    const snapshot = [];
    const appWithTs = [];

    let resultsPayload, matchesPayload;
    if (mock) {
      const mockPath = path.resolve(__dirname, 'mock_jsonodds.json');
      console.log(`ℹ️ Using mock payload for ${sport}:`, mockPath);
      // For mock we’ll use same file for both
      resultsPayload = loadJson(mockPath);
      matchesPayload = loadJson(mockPath);
    } else {
      if (!config.apiKey || /PASTE-YOUR-JSONODDS-KEY-HERE/i.test(config.apiKey)) {
        throw new Error('No JsonOdds API key in sidecar.config.json');
      }
      ({ resultsPayload, matchesPayload } = await fetchResultsAndMatchesForSport(baseUrl, sport, config));
    }

    // Index matches by ID to recover Home/Away and kickoff time
    const byId = indexById(matchesPayload);

    for (const r of resultsPayload || []){
      const id = String(r.Id || r.ID || r.id || r.matchId || r.MatchId || r.MatchID || '');
      const m  = byId.get(id) || {};
      const { home, away, startTime } = pickHomeAwayFromMatch(m);
      const rr = pickScoresFromResult(r);

      snapshot.push({
        id,
        startTime,
        home,
        away,
        status: rr.status,
        awayScore: isFiniteNumber(rr.awayScore) ? Number(rr.awayScore) : null,
        homeScore: isFiniteNumber(rr.homeScore) ? Number(rr.homeScore) : null
      });

      const appRec = toAppRecord(startTime, away, home, rr.awayScore, rr.homeScore, aliasMap);
      const ts = Date.parse(startTime || '') || 0;
      appWithTs.push({ app: appRec, ts });
    }

    perSportSnapshots[sport] = snapshot;
    perSportApps[sport] = appWithTs.map(x => x.app);
    combinedWithTs.push(...appWithTs);
  }

  // Write per-sport snapshots
  for (const sport of sports) {
    const snapPath = path.join(outputDir, `${sport.toLowerCase()}_scores_week_${week}.json`);
    saveJson(snapPath, perSportSnapshots[sport] || []);
  }

  // Write combined app-format file (sorted by time)
  combinedWithTs.sort((a,b) => a.ts - b.ts);
  const combinedApp = combinedWithTs.map(x => x.app);
  const combinedPath = path.join(outputDir, `scores_week_${week}.json`);
  saveJson(combinedPath, combinedApp);

  console.log('✅ Done.');
})();
