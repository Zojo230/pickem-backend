#!/usr/bin/env node
/**
 * Sidecar: JsonOdds -> weekly score files (NFL + NCAAF)
 * - Fetches RESULTS (scores) + MATCHES (teams), joins by ID
 * - Saves raw vendor payloads for debugging
 * - Writes per-sport snapshots + combined app-format file
 *
 * Results contain scores + ID; Matches contain HomeTeam/AwayTeam + MatchTime.
 * Per docs: Result.ID links to a match-up (Match.ID). We fetch both and join.  (docs)
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
function parseArgs() {
  const args = process.argv.slice(2);
  const out = { week: null, season: null, outDir: null, mock: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--week') out.week = Number(args[++i]);
    else if (a === '--season') out.season = Number(args[++i]); // unused by results endpoint; kept for CLI symmetry
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
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          if (status >= 400) return reject(new Error(`HTTP ${status} from ${url}: ${String(data).slice(0,200)}`));
          const ct = String(res.headers['content-type'] || '').toLowerCase();
          if (!ct.includes('json')) return reject(new Error(`Non-JSON response (${status}) from ${url}: ${String(data).slice(0,120)}`));
          resolve(JSON.parse(data || '[]'));
        } catch (e) { reject(e); }
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

// ---------------- date helpers ----------------
function fmtLocal(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2,'0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${yyyy}-${mm}-${dd} ${String(h).padStart(2,'0')}:${m} ${ampm}`;
}
function toAppDate(isoLike) {
  if (!isoLike) return '';
  const d = new Date(isoLike);
  if (isNaN(d.getTime())) {
    const t = Date.parse(isoLike);
    return isNaN(t) ? String(isoLike) : fmtLocal(new Date(t));
  }
  return fmtLocal(d);
}
function isFiniteNumber(n) { return typeof n === 'number' && isFinite(n); }

// ---------------- field adapters ----------------
function grab(obj, keys){ for (const k of keys) if (obj && obj[k] != null) return obj[k]; return null; }

// Result row adapter (scores, id, maybe status)
function adaptResult(r) {
  const id = grab(r, ['ID','Id','id','EventID','EventId']);
  const status = (grab(r, ['FinalType','Status','GameStatus','State','status']) || '').toString();
  let homeScore = grab(r, ['HomeScore','home_score','homeScore','HomePoints']);
  let awayScore = grab(r, ['AwayScore','away_score','awayScore','AwayPoints']);
  // Some feeds return scores as strings
  if (typeof homeScore === 'string' && homeScore.trim() !== '') homeScore = Number(homeScore);
  if (typeof awayScore === 'string' && awayScore.trim() !== '') awayScore = Number(awayScore);
  return { id, status, homeScore, awayScore };
}

// Match row adapter (teams, kickoff)
function adaptMatch(m) {
  const id = grab(m, ['ID','Id','id']);
  const home = grab(m, ['HomeTeam','Home','HomeTeamName','TeamHome','homeTeam','home_team','home','HomeName']);
  const away = grab(m, ['AwayTeam','Away','AwayTeamName','TeamAway','awayTeam','away_team','away','AwayName']);
  const startTime = grab(m, [
    'MatchTime','StartTime','CommenceTime','Kickoff','DateTime','DateTimeUTC',
    'EventDate','StartDate','StartDateTime','startTime','start_date','date'
  ]);
  return { id, home, away, startTime };
}

function toAppRecord(startTime, away, home, awayScore, homeScore, aliasMap) {
  return {
    date: toAppDate(startTime),
    team1: normalizeTeam(away, aliasMap),
    score1: isFiniteNumber(awayScore) ? Number(awayScore) : 0,
    team2: normalizeTeam(home, aliasMap),
    score2: isFiniteNumber(homeScore) ? Number(homeScore) : 0
  };
}

// ---------------- fetching per sport ----------------
async function fetchResultsAndMatchesForSport(baseUrl, sport, cfg) {
  const headers = { 'x-api-key': cfg.apiKey }; // per docs
  // results
  const rParams = new URLSearchParams();
  Object.entries(cfg.scoresParams || {}).forEach(([k,v]) => { if (v!=null && String(v).length) rParams.append(k, String(v)); });
  const rQs = rParams.toString();
  const rUrl = rQs ? `${baseUrl}${cfg.scoresEndpointBase}/${sport}?${rQs}` : `${baseUrl}${cfg.scoresEndpointBase}/${sport}`;
  console.log('🌐 Results URL:', rUrl);
  const resultsPayload = await fetchJsonFollow(rUrl, headers);

  // matches/odds (to get HomeTeam/AwayTeam + MatchTime)
  const oParams = new URLSearchParams();
  Object.entries(cfg.oddsParams || {}).forEach(([k,v]) => { if (v!=null && String(v).length) oParams.append(k, String(v)); });
  const oQs = oParams.toString();
  const oUrl = oQs ? `${baseUrl}${cfg.oddsEndpointBase}/${sport}?${oQs}` : `${baseUrl}${cfg.oddsEndpointBase}/${sport}`;
  console.log('🌐 Matches URL:', oUrl);
  const matchesPayload = await fetchJsonFollow(oUrl, headers);

  return { resultsPayload, matchesPayload };
}

function unwrapArray(payload, candidates) {
  if (Array.isArray(payload)) return payload;
  for (const k of candidates) if (Array.isArray(payload?.[k])) return payload[k];
  return [];
}

// ---------------- main ----------------
async function main() {
  const { week, outDir, mock } = parseArgs();
  const config = loadJson(CONFIG_PATH);
  const aliasJson = fs.existsSync(ALIAS_PATH) ? loadJson(ALIAS_PATH) : {};

  const outputDir = path.resolve(outDir || config.outputDir || './data');

  const sports = Array.isArray(config.sports) && config.sports.length
    ? config.sports.slice()
    : (config.sport ? [String(config.sport)] : ['nfl']);

  const baseUrl = (config.baseUrl || 'https://jsonodds.com/api').replace(/\/+$/, '');
  const scoresBase = (config.scoresEndpointBase || '/results').replace(/\/+$/, '');
  const oddsBase   = (config.oddsEndpointBase   || '/odds').replace(/\/+$/, '');
  const fullCfg = { ...config, scoresEndpointBase: scoresBase, oddsEndpointBase: oddsBase };

  const combinedWithTs = [];
  const perSportSnapshots = {};
  const perSportApps = {};

  for (const sport of sports) {
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
      ({ resultsPayload, matchesPayload } = await fetchResultsAndMatchesForSport(baseUrl, sport, fullCfg));
    }

    // Save raw payloads
    saveJson(path.join(outputDir, `jsonodds_raw_results_${sport}_week_${week}.json`), resultsPayload);
    saveJson(path.join(outputDir, `jsonodds_raw_matches_${sport}_week_${week}.json`), matchesPayload);

    // Unwrap containers
    const results = unwrapArray(resultsPayload, ['results','data','items','Events','events']);
    const matches = unwrapArray(matchesPayload, ['matches','data','items','Matches','events','odds']); // docs show { matches: [...] } for odds/matches

    // Build Match.ID -> {home, away, startTime}
    const matchMap = new Map();
    for (const m of matches) {
      const mm = adaptMatch(m);
      if (mm.id) matchMap.set(String(mm.id), mm);
    }

    // Join: for each result, grab names/time from matchMap
    const aliasMap = pickAliasMapForSport(aliasJson, sport);
    const snapshot = [];
    const appWithTs = [];

    for (const r of results) {
      const rr = adaptResult(r);
      if (!rr.id) continue;

      const mm = matchMap.get(String(rr.id)) || {};
      const startTime = mm.startTime || null;
      const home = mm.home || null;
      const away = mm.away || null;

      // Skip rows with neither team name (prevents null-only records)
      if (!home && !away) continue;

      // Rich snapshot row
      snapshot.push({
        id: rr.id,
        startTime,
        status: rr.status,
        away: normalizeTeam(away, aliasMap),
        home: normalizeTeam(home, aliasMap),
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
}

main().catch(e => { console.error('❌ Sidecar error:', e); process.exit(1); });
