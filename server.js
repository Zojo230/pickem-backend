// FS SHIM — block mkdir on the Render mount root so deploys don’t fail
const __fs_mkdir = require('fs').mkdirSync;
require('fs').mkdirSync = function (target, options) {
  try {
    if (typeof target === 'string') {
      const p = target.trim().replace(/\/+$/, ''); // handle stray newline/trailing slash
      if (p === '/mnt/data') {
        console.log('[FS SHIM] skip mkdir /mnt/data');
        return; // never create the mount root
      }
    }
    return __fs_mkdir.call(require('fs'), target, options);
  } catch (err) {
    if (err && (err.code === 'EEXIST' || err.code === 'EISDIR')) return;
    throw err;
  }
};
console.log('[FS SHIM] active');

// PATH NORMALIZER — trim whitespace & trailing slashes on env paths
(() => {
  try {
    const clean = v => String(v || '').trim().replace(/[\/\\]+$/, '');
    const d = clean(process.env.DATA_DIR || '/mnt/data');
    const b = clean(process.env.BACKUP_DIR || (d + '/backups'));
    process.env.DATA_DIR = d;
    process.env.BACKUP_DIR = b;
    console.log('[PATH NORMALIZER]', { DATA_DIR: d, BACKUP_DIR: b });
  } catch (e) {
    console.log('[PATH NORMALIZER] skipped:', e?.message);
  }
})();

// Load .env and core libs
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

// ---------- Normalize env paths ASAP ----------
const sanitizeEnvPath = (v, dflt) =>
  (v ?? dflt).toString().replace(/\r?\n/g, '').trim();

// Ensure any later code sees clean values
process.env.DATA_DIR   = sanitizeEnvPath(process.env.DATA_DIR,   '/mnt/data');
process.env.BACKUP_DIR = sanitizeEnvPath(process.env.BACKUP_DIR, '/mnt/data/backups');

// (Optional) quick log to verify at boot
console.log('[ENV NORMALIZED]', {
  DATA_DIR: process.env.DATA_DIR,
  BACKUP_DIR: process.env.BACKUP_DIR
});

// (next line in your file)
const app = express();

// ---------- CORS ----------
const originsEnv = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
if (originsEnv.length) {
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (originsEnv.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
} else {
  app.use(cors());
}

// Global JSON parser, except /api/authenticate (we parse that route manually)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/authenticate')) return next();
  return express.json()(req, res, next);
});

// ---------- Directories ----------
const dataDirRaw   = (process.env.DATA_DIR   || './data').replace(/\r?\n/g, '').trim();
const backupDirRaw = (process.env.BACKUP_DIR || 'backups').replace(/\r?\n/g, '').trim();

const dataDir   = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(__dirname, dataDirRaw);
const backupDir = path.isAbsolute(backupDirRaw) ? backupDirRaw : path.join(dataDir, backupDirRaw);
const uploadDir = path.join(__dirname, 'uploads');

// Ensure needed folders exist
for (const d of [uploadDir, dataDir, backupDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Serve /data (handy for sanity checks)
// ---------- Picks Cutoff (Thu 1:00 PM CT) + Reveal Picks After Cutoff ----------

// Parse "YYYY-MM-DD hh:mm AM/PM" in local time (Render has TZ=America/Chicago)
function parseGameDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?$/i);
  if (!m) return null;
  const [, y, mm, dd, hh, min, ampm] = m;
  let H = hh ? parseInt(hh, 10) : 0;
  const M = min ? parseInt(min, 10) : 0;
  if (ampm) {
    const up = ampm.toUpperCase();
    if (up === 'PM' && H < 12) H += 12;
    if (up === 'AM' && H === 12) H = 0;
  }
  return new Date(parseInt(y,10), parseInt(mm,10)-1, parseInt(dd,10), H, M, 0);
}

// Read current week
function getCurrentWeekNumber() {
  try {
    const p = path.join(dataDir, 'current_week.json');
    if (!fs.existsSync(p)) return 1;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Number(j.currentWeek ?? j.week ?? 1);
  } catch { return 1; }
}

// Compute that week’s Thursday @ 1:00 PM CT using earliest game date
function computeCutoffForWeek(weekNum) {
  try {
    const gpath = path.join(dataDir, `games_week_${weekNum}.json`);
    if (!fs.existsSync(gpath)) return null;
    const games = JSON.parse(fs.readFileSync(gpath, 'utf8'));
    if (!Array.isArray(games) || !games.length) return null;
    let earliest = null;
    for (const g of games) {
      const dt = parseGameDate(g?.date);
      if (dt && (!earliest || dt < earliest)) earliest = dt;
    }
    if (!earliest) return null;
    // JS: 0=Sun..4=Thu
    const th = new Date(earliest);
    th.setHours(0,0,0,0);
    th.setDate(earliest.getDate() + (4 - earliest.getDay()));
    th.setHours(13,0,0,0); // 1:00 PM
    return th;
  } catch { return null; }
}

function isLockedNow(weekNum) {
  const cutoff = computeCutoffForWeek(weekNum);
  if (!cutoff) return true;              // be conservative: hide until we can compute
  return new Date() >= cutoff;
}

// Pre-guard: block pick submissions after cutoff (matches any POST path containing "picks")
app.use((req, res, next) => {
  if (req.method === 'POST' && /picks/i.test(req.path)) {
    const week = Number(req.query.week || req.body?.week) || getCurrentWeekNumber();
    if (isLockedNow(week)) {
      return res.status(403).json({
        error: 'Pick submissions are closed.',
        week,
        cutoffISO: computeCutoffForWeek(week)?.toISOString() || null,
        timezone: 'America/Chicago'
      });
    }
  }
  next();
});

// Lock/reveal status (optional for frontend checks)
app.get('/api/lock-status', (req, res) => {
  const week = Number(req.query.week) || getCurrentWeekNumber();
  const cutoff = computeCutoffForWeek(week);
  res.json({
    week,
    cutoffISO: cutoff ? cutoff.toISOString() : null,
    timezone: 'America/Chicago',
    isLocked: isLockedNow(week),
    revealPicks: isLockedNow(week)
  });
});
// --- Has this player already submitted for week? (GET) ---
app.get('/api/player-has-submitted', (req, res) => {
  try {
    const name = String(req.query.name || '').trim().toLowerCase();
    const week = Number(req.query.week || 0);
    if (!name || !week) return res.status(400).json({ ok: false, error: 'Missing name or week' });

    const filename = path.join(dataDir, `picks_week_${week}.json`);
    if (!fs.existsSync(filename)) return res.json({ ok: true, submitted: false });

    const raw = fs.readFileSync(filename, 'utf8') || '[]';
    let arr = [];
    try { arr = JSON.parse(raw); } catch {}

    const submitted = Array.isArray(arr) && arr.some(
      e => String(e.player || '').trim().toLowerCase() === name
    );

    return res.json({ ok: true, submitted });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Check failed' });
  }
});

// Serve /data but hide the picks file until cutoff
app.use('/data', (req, res, next) => {
  const m = req.path.match(/^\/picks_week_(\d+)\.json$/i);
  if (m) {
    const week = Number(m[1]) || getCurrentWeekNumber();
    if (!isLockedNow(week)) {
      return res.status(403).json({
        error: 'All Players’ picks are hidden until Thursday at 1:00 PM CT.',
        week,
        cutoffISO: computeCutoffForWeek(week)?.toISOString() || null
      });
    }
  }
  next();
}, express.static(dataDir));

// ---------- Auth & Data Compatibility Routes for Player Picks ----------

// Route-level parsers to handle both JSON and URL-encoded bodies
const urlencodedParser = express.urlencoded({ extended: false });
const jsonParser = express.json();

// Helper: first present key from a set (case-insensitive)
function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
    const lower = Object.keys(obj).find(kk => kk.toLowerCase() === k.toLowerCase());
    if (lower) return obj[lower];
  }
  return '';
}

// Unified auth handler (GET or POST; query, json, or urlencoded)
function handleAuthenticate(req, res) {
  try {
    // Merge query and body (body may be json or urlencoded)
    const src = {
      ...(req.query || {}),
      ...(typeof req.body === 'object' ? (req.body || {}) : {})
    };

    const name = String(
      pickFirst(src, ['name','gameName','gamename','player','playerName','username','user'])
    ).trim();
    const pin  = String(
      pickFirst(src, ['pin','PIN','Pin','passcode','password','pwd'])
    ).trim();

    if (!name || !pin) return res.status(400).json({ error: 'Missing name or pin' });

    const rosterPath = path.join(dataDir, 'roster.json');
    if (!fs.existsSync(rosterPath)) return res.status(404).json({ error: 'Roster not found' });

    const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    const norm = s => s.toString().trim().toLowerCase();

    const match = Array.isArray(roster) && roster.find(r => {
      const rname = typeof r === 'string' ? r : (r && (r.name || r.gameName || r.playerName));
      const rpin  = typeof r === 'string' ? '' : (r && (r.pin || r.PIN || r.passcode || r.password));
      return rname && norm(rname) === norm(name) && String(rpin ?? '') === String(pin);
    });

    if (!match) return res.status(401).json({ error: 'Invalid name or PIN' });

    return res.json({
      ok: true,
      name: (typeof match === 'string' ? match : (match.name || match.gameName || match.playerName))
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Auth failed' });
  }
}

// Accept GET and POST (json or urlencoded)
app.get('/api/authenticate', handleAuthenticate);
app.post('/api/authenticate', urlencodedParser, jsonParser, handleAuthenticate);

// File helpers (serve JSON if it exists)
function sendJsonFile(res, filePath) {
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  return res.sendFile(filePath);
}

// Alias: /api/games_week_X.json  -> /data/games_week_X.json
app.get('/api/games_week_:week.json', (req, res) => {
  const filePath = path.join(dataDir, `games_week_${req.params.week}.json`);
  return sendJsonFile(res, filePath);
});

// Alias: /api/scores_week_X.json -> /data/scores_week_X.json
app.get('/api/scores_week_:week.json', (req, res) => {
  const filePath = path.join(dataDir, `scores_week_${req.params.week}.json`);
  return sendJsonFile(res, filePath);
});

// Alias: /api/winners_week_X.json -> /data/winners_week_X.json
app.get('/api/winners_week_:week.json', (req, res) => {
  const filePath = path.join(dataDir, `winners_week_${req.params.week}.json`);
  return sendJsonFile(res, filePath);
});

// Alias: /api/picks_week_X.json -> /data/picks_week_X.json (hidden until cutoff)
app.get('/api/picks_week_:week.json', (req, res) => {
  const week = Number(req.params.week) || getCurrentWeekNumber();
  if (!isLockedNow(week)) {
    return res.status(403).json({
      error: 'All Players’ picks are hidden until Thursday at 1:00 PM CT.',
      week,
      cutoffISO: computeCutoffForWeek(week)?.toISOString() || null
    });
  }
  const filePath = path.join(dataDir, `picks_week_${week}.json`);
  return sendJsonFile(res, filePath);
});

// ---------- Multer ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

// ---------- Admin: Clear Chat ----------
function authOk(req) {
  // Read token on demand; no global const => avoids duplicate declarations
  const ADMIN_TKN = (process.env.ADMIN_TOKEN || '').trim();
  if (!ADMIN_TKN) return true;                 // if no token configured, allow
  return (req.query.key || '') === ADMIN_TKN;  // else require ?key=YOURTOKEN
}

function clearChatHandler(req, res) {
  if (!authOk(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const chatPath = path.join(dataDir, 'chat.json');

    // Backup current chat.json (if any)
    if (fs.existsSync(chatPath)) {
      try {
        const backupPath = path.join(backupDir, `${Date.now()}_chat.json`);
        fs.copyFileSync(chatPath, backupPath);
      } catch { /* ignore backup errors */ }
    }

    // Clear chat
    fs.writeFileSync(chatPath, '[]', 'utf8');
    return res.json({ ok: true, cleared: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Allow both POST and GET for convenience
app.post('/api/admin/clear-chat', clearChatHandler);
app.get('/api/admin/clear-chat', clearChatHandler);

// ---------- Chat (roster-restricted) ----------
app.get('/api/check-roster', (req, res) => {
  try {
    const q = (req.query.name || '').toString().trim();
    if (!q) return res.json({ allowed: false });

    const rosterPath = path.join(dataDir, 'roster.json');
    if (!fs.existsSync(rosterPath)) return res.json({ allowed: false });

    const raw = fs.readFileSync(rosterPath, 'utf8');
    let roster = [];
    try { roster = JSON.parse(raw); } catch { return res.json({ allowed: false }); }

    const norm = s => s.toString().trim().toLowerCase();
    const allowed = Array.isArray(roster) && roster.some(r => {
      if (typeof r === 'string') return norm(r) === norm(q);
      if (r && typeof r.name === 'string') return norm(r.name) === norm(q);
      return false;
    });

    return res.json({ allowed: !!allowed });
  } catch {
    return res.json({ allowed: false });
  }
});

app.get('/api/chat', (req, res) => {
  const filePath = path.join(dataDir, 'chat.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.json([]);
    try { res.json(JSON.parse(data)); }
    catch { res.json([]); }
  });
});

app.post('/api/chat', (req, res) => {
  const chatPath   = path.join(dataDir, 'chat.json');
  const rosterPath = path.join(dataDir, 'roster.json');

  const nameRaw = (req.body?.name || '').toString().trim();
  const messageRaw = (req.body?.message || '').toString().trim();

  // Basic input checks
  if (!nameRaw || !messageRaw) {
    return res.status(400).json({ error: 'Missing name or message.' });
  }
  if (messageRaw.length > 1000) {
    return res.status(400).json({ error: 'Message too long.' });
  }

  // Roster enforcement
  try {
    if (!fs.existsSync(rosterPath)) {
      return res.status(403).json({ error: 'Only registered game names may post in chat.' });
    }
    const raw = fs.readFileSync(rosterPath, 'utf8');
    const roster = JSON.parse(raw);
    const norm = s => s.toString().trim().toLowerCase();

    const isOnRoster = Array.isArray(roster) && roster.some(r => {
      if (typeof r === 'string') return norm(r) === norm(nameRaw);
      if (r && typeof r.name === 'string') return norm(r.name) === norm(nameRaw);
      return false;
    });

    if (!isOnRoster) {
      return res.status(403).json({ error: 'Only registered game names may post in chat.' });
    }
  } catch {
    return res.status(500).json({ error: 'Roster validation failed.' });
  }

  const newMessage = {
    name: nameRaw,
    message: messageRaw,
    timestamp: new Date().toISOString(),
  };

  // Save + keep last 50; back up existing file
  fs.readFile(chatPath, 'utf8', (err, data) => {
    let messages = [];
    if (!err) {
      try {
        messages = JSON.parse(data);
        if (fs.existsSync(chatPath)) {
          const backupPath = path.join(backupDir, `${Date.now()}_chat.json`);
          try { fs.copyFileSync(chatPath, backupPath); } catch {}
        }
      } catch {}
    }
    messages.push(newMessage);
    fs.writeFile(chatPath, JSON.stringify(messages.slice(-50), null, 2), e => {
      if (e) return res.status(500).json({ error: 'Failed to save message' });
      res.json({ success: true });
    });
  });
});


// ---------- Helpers ----------
function formatExcelTime(excelTime) {
  try {
    const date = new Date(Math.round((excelTime - 0.00001) * 24 * 60 * 60 * 1000));
    const h = date.getUTCHours();
    const m = date.getUTCMinutes();
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hours = h % 12 || 12;
    return `${hours}:${m.toString().padStart(2, '0')} ${suffix}`;
  } catch {
    return '';
  }
}

function normalizeName(str) {
  return (str || '')
    .toString()
    .replace(/[^a-zA-Z0-9]/g, '')
    .replace(/state$/i, 'st')
    .toLowerCase();
}

// ---------- Winners calculation ----------
function calculateTotalWinners(week) {
  const scoresPath  = path.join(dataDir, `scores_week_${week}.json`);
  const gamesPath   = path.join(dataDir, `games_week_${week}.json`);
  const detailPath  = path.join(dataDir, `winners_detail_week_${week}.json`);
  const winnersPath = path.join(dataDir, `declaredwinners_week_${week}.json`);

  if (!fs.existsSync(scoresPath) || !fs.existsSync(gamesPath)) {
    console.log(`❌ Missing scores or games file for Week ${week}`);
    return;
  }

  const scores = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
  const games  = JSON.parse(fs.readFileSync(gamesPath, 'utf8'));

  const detail = [];
  const declaredWinners = [];

  for (const game of games) {
    const g1 = normalizeName(game.team1);
    const g2 = normalizeName(game.team2);

    const match = scores.find(s => {
      const s1 = normalizeName(s.team1);
      const s2 = normalizeName(s.team2);
      return (s1 === g1 && s2 === g2) || (s1 === g2 && s2 === g1);
    });

    if (!match) {
      console.log(`❌ Could not match score for game: ${game.team1} vs ${game.team2}`);
      continue;
    }

    const adjusted1 = Number(match.score1) + Number(game.spread1);
    const raw2 = Number(match.score2);

    let winner = '';
    if (adjusted1 > raw2) winner = game.team1;
    else if (adjusted1 < raw2) winner = game.team2;
    else winner = 'PUSH';

    detail.push({
      team1: game.team1, spread1: game.spread1, score1: match.score1,
      team2: game.team2, spread2: game.spread2, score2: match.score2,
      winner
    });

    if (winner !== 'PUSH') declaredWinners.push(winner);
  }

  fs.writeFileSync(detailPath, JSON.stringify(detail, null, 2));
  fs.writeFileSync(winnersPath, JSON.stringify(declaredWinners, null, 2));
  console.log(`✅ Week ${week} winners written → winners_detail_week_${week}.json & declaredwinners_week_${week}.json`);
}

function calculateWinnersFromList(week) {
  const picksFile   = path.join(dataDir, `picks_week_${week}.json`);
  const winnersFile = path.join(dataDir, `declaredwinners_week_${week}.json`);
  const outputFile  = path.join(dataDir, `winners_week_${week}.json`);
  const totalsFile  = path.join(dataDir, 'totals.json');

  if (!fs.existsSync(picksFile) || !fs.existsSync(winnersFile)) {
    console.error(`❌ Missing picks or declared winners for week ${week}`);
    return;
  }

  const picksData   = JSON.parse(fs.readFileSync(picksFile, 'utf8'));
  const winnersList = JSON.parse(fs.readFileSync(winnersFile, 'utf8'));

  const results = picksData.map(player => {
    const correct = (player.picks || [])
      .map(p => (p.pick || '').trim())
      .filter(pick => winnersList.includes(pick));
    return { player: player.player, correct, total: correct.length };
  });

  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`✅ winners_week_${week}.json written (player-specific results)`);

  // Update totals
  let existingTotals = {};
  if (fs.existsSync(totalsFile)) {
    try { existingTotals = JSON.parse(fs.readFileSync(totalsFile, 'utf8')); }
    catch { console.warn('⚠️ Failed to read existing totals.json; starting fresh'); }
  }
  for (const r of results) {
    const name = (r.player || '').trim();
    existingTotals[name] = (existingTotals[name] || 0) + r.total;
  }
  fs.writeFileSync(totalsFile, JSON.stringify(existingTotals, null, 2));
  console.log('📊 totals.json updated');
}

// ---------- JSON upload (games|scores) ----------
app.post('/api/upload/json-direct', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded.' });

    const original = (file.originalname || '').trim().toLowerCase();
    const m = original.match(/^(games|scores)[-_ ]?week[-_ ]?(\d+)(?:\.json)?$/i);
    if (!m) return res.status(400).json({ error: 'Filename must be games_week_X.json or scores_week_X.json' });

    const kind = m[1].toLowerCase();
    const week = parseInt(m[2], 10);

    const targetName = `${kind}_week_${week}.json`;
    const targetPath = path.join(dataDir, targetName);

    // Read and validate JSON
    const text = fs.readFileSync(file.path, 'utf8').replace(/^\uFEFF/, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return res.status(400).json({ error: 'Uploaded file is not valid JSON.' }); }

    const force = ['true','1','yes','on'].includes(String(req.body.force || req.body.overwrite || '').toLowerCase());
    if (fs.existsSync(targetPath) && !force) {
      return res.status(409).json({ message: `${targetName} already exists. Overwrite?`, exists: true });
    }
    if (fs.existsSync(targetPath) && force) {
      const backupName = `${Date.now()}_${targetName}`;
      fs.copyFileSync(targetPath, path.join(backupDir, backupName));
    }

    fs.writeFileSync(targetPath, JSON.stringify(parsed, null, 2));
    console.log(`[json-direct] Saved ${targetName}`);

    // Side-effects
    if (kind === 'games') {
      fs.writeFileSync(path.join(dataDir, 'current_week.json'), JSON.stringify({ currentWeek: week }, null, 2));
    } else {
      try {
        calculateTotalWinners(week);
        calculateWinnersFromList(week);
      } catch (e) { console.warn('Auto-calc failed:', e?.message); }
    }

    return res.json({ ok: true, kind, week, savedAs: targetName });
  } catch (err) {
    console.error('/api/upload/json-direct error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ---------- Excel upload: spread ----------
app.post('/api/upload/spread', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send('No file uploaded.');

  const weekMatch = file.originalname.match(/week[_-]?(\d+)/i);
  if (!weekMatch) return res.status(400).send('Filename must contain week number.');
  const week = parseInt(weekMatch[1], 10);

  const filePath = path.join(dataDir, `games_week_${week}.json`);
  const backupPath = path.join(backupDir, `${Date.now()}_games_week_${week}.json`);
  const force = String(req.body.force || '').toLowerCase() === 'true';

  if (fs.existsSync(filePath) && !force) {
    return res.status(409).json({ message: `Week ${week} spread already exists. Overwrite?` });
  }
  if (fs.existsSync(filePath) && force) {
    fs.copyFileSync(filePath, backupPath);
  }

  const workbook = xlsx.readFile(file.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

  const games = [];
  for (let i = 1; i < rows.length - 2; i += 3) {
    const dayRow = rows[i];
    const dateRow = rows[i + 1];
    const timeRow = rows[i + 2];

    const day = dayRow?.[0];
    const matchup = dayRow?.[1];
    const spread2Raw = dayRow?.[2];
    const date = dateRow?.[0];
    const time = timeRow?.[0];
    const team1 = timeRow?.[1];
    const spread1Raw = timeRow?.[2];

    if (!day || !date || !time || !team1 || !matchup) continue;

    const fullDate = `${day} ${date} ${formatExcelTime(time)}`;
    const cleanTeam2 = typeof matchup === 'string' && matchup.includes(' at') ? matchup.replace(' at', '').trim() : matchup?.trim();
    const cleanTeam1 = team1?.trim();

    const cleanSpread = (val) => {
      try { return parseFloat(String(val).replace(/[()]/g, '').split(' ')[0]); }
      catch { return NaN; }
    };

    const spread1 = cleanSpread(spread1Raw);
    const spread2 = cleanSpread(spread2Raw);

    if (cleanTeam1 && cleanTeam2 && !isNaN(spread1) && !isNaN(spread2)) {
      games.push({ date: fullDate, team1: cleanTeam1, spread1, team2: cleanTeam2, spread2 });
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(games, null, 2));
  fs.writeFileSync(path.join(dataDir, 'current_week.json'), JSON.stringify({ currentWeek: week }, null, 2));

  try {
    uploadJsonToDrive && uploadJsonToDrive(filePath, `games_week_${week}.json`)
      .then(id => console.log(`✅ Spread also uploaded to Drive. File ID: ${id}`))
      .catch(err => console.error('❌ Drive upload failed:', err.message));
  } catch {
    /* optional */
  }

  res.send(`✅ Spread uploaded and converted for Week ${week}`);
});

// ---------- Excel upload: scores (auto-calc) ----------
app.post('/api/upload/scores', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send('No file uploaded.');

  const weekMatch = file.originalname.match(/week[_-]?(\d+)/i);
  if (!weekMatch) return res.status(400).send('Filename must contain week number.');
  const week = parseInt(weekMatch[1], 10);

  const filePath = path.join(dataDir, `scores_week_${week}.json`);
  const backupPath = path.join(backupDir, `${Date.now()}_scores_week_${week}.json`);
  const force = String(req.body.force || '').toLowerCase() === 'true';

  if (fs.existsSync(filePath) && !force) {
    return res.status(409).json({ message: `Week ${week} scores already exist. Overwrite?` });
  }
  if (fs.existsSync(filePath) && force) {
    fs.copyFileSync(filePath, backupPath);
  }

  const workbook = xlsx.readFile(file.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

  const rawScores = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 5) continue;
    rawScores.push({
      date: row[0],
      team1: row[1]?.toString().trim(),
      score1: Number(row[2]),
      team2: row[3]?.toString().trim(),
      score2: Number(row[4])
    });
  }

  const gamesPath = path.join(dataDir, `games_week_${week}.json`);
  if (!fs.existsSync(gamesPath)) return res.status(400).send(`Missing games_week_${week}.json`);
  const spreadGames = JSON.parse(fs.readFileSync(gamesPath, 'utf8'));

  const orderedScores = spreadGames.map(game => {
    const g1 = normalizeName(game.team1);
    const g2 = normalizeName(game.team2);
    const match = rawScores.find(s => {
      const s1 = normalizeName(s.team1);
      const s2 = normalizeName(s.team2);
      return (s1 === g1 && s2 === g2) || (s1 === g2 && s2 === g1);
    });
    if (!match) {
      console.warn(`⚠️ Score not found for: ${game.team1} vs ${game.team2}`);
      return null;
    }
    const needsSwap = normalizeName(match.team1) !== g1;
    return {
      date: match.date,
      team1: needsSwap ? match.team2 : match.team1,
      score1: needsSwap ? match.score2 : match.score1,
      team2: needsSwap ? match.team1 : match.team2,
      score2: needsSwap ? match.score1 : match.score2
    };
  }).filter(Boolean);

  fs.writeFileSync(filePath, JSON.stringify(orderedScores, null, 2));
  console.log(`✅ scores_week_${week}.json saved with corrected order.`);

  // Auto-calc winners + points
  calculateTotalWinners(week);
  calculateWinnersFromList(week);

  try {
    uploadJsonToDrive && uploadJsonToDrive(filePath, `scores_week_${week}.json`)
      .then(id => console.log(`✅ Scores also uploaded to Drive. File ID: ${id}`))
      .catch(err => console.error('❌ Drive upload failed:', err.message));
  } catch {
    /* optional */
  }

  res.send(`✅ Scores uploaded and winners calculated for Week ${week}`);
});

// ---------- Roster upload (Excel) — with Balance ----------
app.post('/api/upload/roster', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send('No file uploaded.');

  const filePath  = path.join(dataDir, 'roster.json');
  const backupPath = path.join(backupDir, `${Date.now()}_roster.json`);
  const ext = path.extname(file.originalname).toLowerCase();

  if (!['.xlsx', '.xls'].includes(ext)) {
    return res.status(400).send('Unsupported file type. Please upload an Excel (.xlsx/.xls) file.');
  }

  // Backup existing roster.json (if any)
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath);
    }
  } catch { /* ignore backup errors */ }

  try {
    const workbook = xlsx.readFile(file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const raw = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    if (!raw || raw.length < 2) {
      return res.status(400).send('Roster sheet is empty or missing headers.');
    }

    // Case-insensitive header lookup
    const header = (raw[0] || []).map(h => h?.toString().trim().toLowerCase());
    const idxName = header.findIndex(h => h === 'name' || h === 'player' || h === 'gamename');
    const idxPin  = header.findIndex(h => h === 'pin' || h === 'passcode' || h === 'password');
    // Accept common variants for balance
    const idxBal  = header.findIndex(h => ['balance','paid','payment','amount'].includes(h));

    if (idxName === -1 || idxPin === -1) {
      return res.status(400).send('Missing "Name" and/or "PIN" columns in roster file.');
    }

    const toNumber = (v) => {
      if (v == null || v === '') return 0;
      // strip $ and commas
      const n = Number(String(v).replace(/[$,]/g, '').trim());
      return Number.isFinite(n) ? n : 0;
    };

    const roster = raw.slice(1).map((row, i) => {
      const name = row[idxName]?.toString().trim();
      const pin  = row[idxPin]?.toString().trim();
      const bal  = idxBal === -1 ? 0 : toNumber(row[idxBal]);

      if (!name || !pin) return null;
      return { name, pin, Balance: bal };
    }).filter(Boolean);

    fs.writeFileSync(filePath, JSON.stringify(roster, null, 2));
    return res.send(`✅ Roster uploaded. ${roster.length} players saved with Balance.`);
  } catch (err) {
    console.error('❌ Failed to parse roster:', err);
    return res.status(500).send('Failed to process roster file.');
  }
});

// ---------- Picks submission (FINAL — deny duplicate submissions) ----------
app.post('/submit-picks/:week', (req, res) => {
  try {
    const weekParam = parseInt(req.params.week, 10);
    const week = Number.isFinite(weekParam) && weekParam > 0 ? weekParam : 1;

    // Respect your existing Thursday cutoff guard (it already runs earlier in the file)

    // Accept common field names from the frontend
    const name = String(
      (req.body?.name ?? req.body?.gameName ?? req.body?.player ?? req.body?.playerName ?? '')
    ).trim();
    const pin  = String((req.body?.pin ?? req.body?.PIN ?? req.body?.password ?? '')).trim();
    const picksIn = Array.isArray(req.body?.picks) ? req.body.picks : null;

    if (!name || !pin || !picksIn) {
      return res.status(400).json({ success: false, error: 'Missing data.' });
    }

    // Normalize picks -> [{gameIndex:Number, pick:String}]
    const picks = picksIn
      .map(p => ({
        gameIndex: Number(p?.gameIndex),
        pick: String(p?.pick || '').trim(),
      }))
      .filter(p => Number.isFinite(p.gameIndex) && p.pick);

    if (picks.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid picks.' });
    }
    if (picks.length > 10) {
      return res.status(400).json({ success: false, error: 'Max 10 picks allowed.' });
    }

    const filename = path.join(dataDir, `picks_week_${week}.json`);
    let data = [];
    if (fs.existsSync(filename)) {
      try {
        data = JSON.parse(fs.readFileSync(filename, 'utf8') || '[]');
      } catch {
        return res.status(500).json({ success: false, error: 'Error reading picks file.' });
      }
    }

    // 🔒 If this player already submitted for this week, reject (no overwrite)
    const already = data.some(e => (e.player || '').trim().toLowerCase() === name.toLowerCase());
    if (already) {
      return res.status(409).json({
        success: false,
        alreadySubmitted: true,
        error: 'Your picks for this week have already been submitted.'
      });
    }

    // Best-effort backup before writing
    try {
      if (fs.existsSync(filename)) {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(filename, path.join(backupDir, `${Date.now()}_picks_week_${week}.json`));
      }
    } catch { /* ignore backup errors */ }

    // Append as a new entry (never overwrite)
    data.push({ player: name, pin, picks, week, submittedAt: new Date().toISOString() });

    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to save picks.' });
  }
});
// --- Compatibility alias so the frontend can POST /api/submit-picks with { week, player, pin, picks }
app.post('/api/submit-picks', async (req, res) => {
  try {
    // Week: body.week if provided; else read current_week.json; else 1
    let week = Number(req.body?.week);
    if (!Number.isFinite(week) || week <= 0) {
      try {
        const cw = JSON.parse(
          fs.readFileSync(path.join(dataDir, 'current_week.json'), 'utf8')
        );
        week = cw?.currentWeek ?? cw?.week ?? 1;
      } catch {
        week = 1;
      }
    }

    const name = String(
      req.body?.player ?? req.body?.playerName ?? req.body?.gameName ?? ''
    ).trim();
    const pin = String(
      req.body?.pin ?? req.body?.PIN ?? req.body?.password ?? ''
    ).trim();
    const picksIn = Array.isArray(req.body?.picks) ? req.body.picks : [];

    if (!name || !pin || picksIn.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing data.' });
    }
    if (picksIn.length > 10) {
      return res.status(400).json({ success: false, error: 'Max 10 picks allowed.' });
    }

    // Normalize picks -> [{gameIndex:Number, pick:String}]
    const picks = picksIn
      .map(p => ({
        gameIndex: Number(p?.gameIndex),
        pick: String(p?.pick || '').trim(),
      }))
      .filter(p => Number.isFinite(p.gameIndex) && p.pick);

    const filename = path.join(dataDir, `picks_week_${week}.json`);
    let data = [];
    if (fs.existsSync(filename)) {
      try {
        data = JSON.parse(fs.readFileSync(filename, 'utf8') || '[]');
      } catch {
        return res.status(500).json({ success: false, error: 'Error reading picks file.' });
      }
    }

    // Deny duplicate submissions by player (case-insensitive)
    const already = data.some(
      e => (e.player || '').trim().toLowerCase() === name.toLowerCase()
    );
    if (already) {
      return res.status(409).json({
        success: false,
        alreadySubmitted: true,
        error: 'Your picks for this week have already been submitted.',
      });
    }

    // Optional: backup existing file
    try {
      if (fs.existsSync(filename)) {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(
          filename,
          path.join(backupDir, `${Date.now()}_picks_week_${week}.json`)
        );
      }
    } catch { /* ignore backup errors */ }

    data.push({
      player: name,
      pin,
      picks,
      week,
      submittedAt: new Date().toISOString(),
    });

    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    return res.json({ success: true });
  } catch (err) {
    console.error('submit-picks alias error:', err);
    return res.status(500).json({ success: false, error: 'Failed to save picks.' });
  }
});

// ---------- Utility / Info ----------
app.get('/api/currentWeek', (req, res) => {
  const filePath = path.join(dataDir, 'current_week.json');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Current week not set' });
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to read current week file' });
  }
});

app.get('/api/totals', (req, res) => {
  const filePath = path.join(dataDir, 'totals.json');
  if (!fs.existsSync(filePath)) return res.json([]);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const asArray = Object.entries(data).map(([player, total]) => ({ player, total }));
    res.json(asArray);
  } catch {
    res.status(500).json({ error: 'Failed to read totals file' });
  }
});

app.get('/api/games', (req, res) => {
  const currentWeekPath = path.join(dataDir, 'current_week.json');
  if (!fs.existsSync(currentWeekPath)) return res.status(404).json({ error: 'Current week not set' });
  try {
    const current = JSON.parse(fs.readFileSync(currentWeekPath, 'utf8'));
    const week = current.currentWeek;
    const gamesPath = path.join(dataDir, `games_week_${week}.json`);
    if (!fs.existsSync(gamesPath)) return res.status(404).json({ error: 'Games not found for current week' });
    const games = JSON.parse(fs.readFileSync(gamesPath, 'utf8'));
    res.json(games);
  } catch {
    res.status(500).json({ error: 'Failed to load games data' });
  }
});

app.post('/api/check-player-picks', (req, res) => {
  const { week, playerName } = req.body || {};
  const filePath = path.join(dataDir, `picks_week_${week}.json`);
  if (!fs.existsSync(filePath)) return res.json({ alreadyPicked: false });
  try {
    const picksData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const found = picksData.some(entry => (entry.player || '').toLowerCase() === (playerName || '').toLowerCase());
    res.json({ alreadyPicked: found });
  } catch {
    res.json({ alreadyPicked: false });
  }
});

// ---------- NEW: Robust /api/rules ----------
app.get('/api/rules', (req, res) => {
  try {
    const p = path.join(dataDir, 'rules.json');
    if (!fs.existsSync(p)) return res.json({ rulesText: '' });

    const raw = fs.readFileSync(p, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      // If it's not valid JSON, return raw text
      return res.json({ rulesText: raw || '' });
    }

    if (typeof parsed === 'string') return res.json({ rulesText: parsed });
    if (parsed && typeof parsed.content === 'string') return res.json({ rulesText: parsed.content });
    if (parsed && typeof parsed.rulesText === 'string') return res.json({ rulesText: parsed.rulesText });

    // Fallback: stringify unknown objects
    return res.json({ rulesText: JSON.stringify(parsed) });
  } catch (e) {
    console.error('GET /api/rules error', e);
    res.status(500).json({ rulesText: '' });
  }
});

// ---------- Chat (roster-restricted) ----------
app.get('/api/check-roster', (req, res) => {
  try {
    const q = (req.query.name || '').toString().trim();
    if (!q) return res.json({ allowed: false });

    const rosterPath = path.join(dataDir, 'roster.json');
    if (!fs.existsSync(rosterPath)) return res.json({ allowed: false });

    const raw = fs.readFileSync(rosterPath, 'utf8');
    let roster = [];
    try { roster = JSON.parse(raw); } catch { return res.json({ allowed: false }); }

    const norm = s => s.toString().trim().toLowerCase();
    const allowed = Array.isArray(roster) && roster.some(r => {
      if (typeof r === 'string') return norm(r) === norm(q);
      if (r && typeof r.name === 'string') return norm(r.name) === norm(q);
      return false;
    });

    return res.json({ allowed: !!allowed });
  } catch {
    return res.json({ allowed: false });
  }
});

app.get('/api/chat', (req, res) => {
  const filePath = path.join(dataDir, 'chat.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.json([]);
    try { res.json(JSON.parse(data)); }
    catch { res.json([]); }
  });
});

app.post('/api/chat', (req, res) => {
  const chatPath   = path.join(dataDir, 'chat.json');
  const rosterPath = path.join(dataDir, 'roster.json');

  const nameRaw = (req.body?.name || '').toString().trim();
  const messageRaw = (req.body?.message || '').toString().trim();

  // Basic input checks
  if (!nameRaw || !messageRaw) {
    return res.status(400).json({ error: 'Missing name or message.' });
  }
  if (messageRaw.length > 1000) {
    return res.status(400).json({ error: 'Message too long.' });
  }

  // Roster enforcement
  try {
    if (!fs.existsSync(rosterPath)) {
      return res.status(403).json({ error: 'Only registered game names may post in chat.' });
    }
    const raw = fs.readFileSync(rosterPath, 'utf8');
    const roster = JSON.parse(raw);
    const norm = s => s.toString().trim().toLowerCase();

    const isOnRoster = Array.isArray(roster) && roster.some(r => {
      if (typeof r === 'string') return norm(r) === norm(nameRaw);
      if (r && typeof r.name === 'string') return norm(r.name) === norm(nameRaw);
      return false;
    });

    if (!isOnRoster) {
      return res.status(403).json({ error: 'Only registered game names may post in chat.' });
    }
  } catch {
    return res.status(500).json({ error: 'Roster validation failed.' });
  }

  const newMessage = {
    name: nameRaw,
    message: messageRaw,
    timestamp: new Date().toISOString(),
  };

  // Save + keep last 50; back up existing file
  fs.readFile(chatPath, 'utf8', (err, data) => {
    let messages = [];
    if (!err) {
      try {
        messages = JSON.parse(data);
        if (fs.existsSync(chatPath)) {
          const backupPath = path.join(backupDir, `${Date.now()}_chat.json`);
          try { fs.copyFileSync(chatPath, backupPath); } catch {}
        }
      } catch {}
    }
    messages.push(newMessage);
    fs.writeFile(chatPath, JSON.stringify(messages.slice(-50), null, 2), e => {
      if (e) return res.status(500).json({ error: 'Failed to save message' });
      res.json({ success: true });
    });
  });
});

// ---------- Reset / Debug / Download ----------
app.post('/api/reset-system', (req, res) => {
  try {
    const files = fs.readdirSync(dataDir);
    const weekFilePatterns = [
      /^games_week_\d+\.json$/, /^scores_week_\d+\.json$/, /^picks_week_\d+\.json$/,
      /^winners_week_\d+\.json$/, /^winners_detail_week_\d+\.json$/, /^declaredwinners_week_\d+\.json$/
    ];
    files.forEach(file => { if (weekFilePatterns.some(rx => rx.test(file))) fs.unlinkSync(path.join(dataDir, file)); });

    fs.writeFileSync(path.join(dataDir, 'current_week.json'), JSON.stringify({ currentWeek: 1 }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'totals.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'cumulative_scores.json'), JSON.stringify({}, null, 2));

    res.send('✅ System reset complete. All week files removed and core files reset to Week 1.');
  } catch (err) {
    console.error('❌ Reset failed:', err);
    res.status(500).send('Reset failed. Check server logs for details.');
  }
});

app.all('/api/calculate-totalwinners/:week', (req, res) => {
  const week = parseInt(req.params.week, 10);
  calculateTotalWinners(week);
  calculateWinnersFromList(week);
  res.send(`✅ Calculating total winners for Week ${week}`);
});

app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(dataDir, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('File not found.');
  res.download(filepath);
});

app.get('/api/debug/files', (req, res) => {
  try {
    const files = fs.readdirSync(dataDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const fp = path.join(dataDir, name);
        const st = fs.statSync(fp);
        return { name, size: st.size, modified: st.mtime.toLocaleString() };
      });
  res.json({ count: files.length, files });
  } catch (err) {
    console.error('❌ Failed to list files:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`🌍 Server is running on port ${PORT}`);
  console.log(`📁 DATA_DIR: ${dataDir}`);
  console.log(`📦 BACKUP_DIR: ${backupDir}`);
});
