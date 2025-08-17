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

// ✅ Merged server.js for MyPicksProgram-copy
// Combines working routes from -copy with JSON-direct + auto-calc from -local
// Render-friendly (DATA_DIR=/data, BACKUP_DIR=/data/backups), supports CORS_ORIGIN
// Default local dev: DATA_DIR=./data, BACKUP_DIR=backups

require('dotenv').config();

const { uploadJsonToDrive } = require('./driveUpload'); // safe to keep; wrapped in try/catch on use
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const app = express();

// ---------- CORS (supports comma-separated CORS_ORIGIN) ----------
const originsEnv = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
if (originsEnv.length) {
  app.use(cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true); // non-browser or same-origin
      if (originsEnv.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
} else {
  app.use(cors());
}

app.use(express.json());

// ---------- Data directories (Render uses /data) ----------
const dataDirRaw   = process.env.DATA_DIR   || './data';        // default local
const backupDirRaw = process.env.BACKUP_DIR || 'backups';       // default local subfolder

const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(__dirname, dataDirRaw);
const backupDir = path.isAbsolute(backupDirRaw) ? backupDirRaw : path.join(dataDir, backupDirRaw);

const uploadDir = path.join(__dirname, 'uploads');

// Ensure needed folders exist
for (const d of [uploadDir, dataDir, backupDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Serve JSON files (useful for sanity checks)
app.use('/data', express.static(dataDir));

// ---------- Multer storage ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });
// ------- HOTFIX: reliable JSON upload (wins by being registered first) -------
app.post('/api/upload/json-direct', upload.single('file'), (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file uploaded.' });

    const original = (f.originalname || '').trim().toLowerCase();
    const m = original.match(/^(games|scores)[-_ ]?week[-_ ]?(\d+)(?:\.json)?$/i);
    if (!m) return res.status(400).json({ error: 'Filename must be games_week_X.json or scores_week_X.json' });

    const kind = m[1].toLowerCase();
    const week = parseInt(m[2], 10);

    const text = fs.readFileSync(f.path, 'utf8').replace(/^\uFEFF/, '').trim();
    let payload; try { payload = JSON.parse(text); } catch { return res.status(400).json({ error: 'Uploaded file is not valid JSON.' }); }
    if (!Array.isArray(payload)) return res.status(400).json({ error: 'JSON must be an array.' });

    const outName = `${kind}_week_${week}.json`;
    const outPath = path.join(dataDir, outName);

    const force = ['true','1','yes','on'].includes(String(req.body.force || req.body.overwrite || '').toLowerCase());
    if (fs.existsSync(outPath) && !force) return res.status(409).json({ message: `${outName} already exists. Overwrite?` });
    if (fs.existsSync(outPath) && force) {
      try { fs.mkdirSync(backupDir, { recursive: true }); fs.copyFileSync(outPath, path.join(backupDir, `${Date.now()}_${outName}`)); } catch {}
    }

    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    if (kind === 'games') {
      fs.writeFileSync(path.join(dataDir, 'current_week.json'), JSON.stringify({ currentWeek: week }, null, 2));
    } else {
      try { calculateTotalWinners(week); calculateWinnersFromList(week); } catch (e) { console.warn('Auto-calc failed:', e?.message); }
    }

    return res.json({ ok: true, kind, week, savedAs: outName });
  } catch (err) {
    console.error('[hotfix json-direct] error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
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

// ---------- Winners calculation (spread-adjusted) ----------
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

    console.log(`🧮 ${game.team1} (${match.score1} + ${game.spread1} = ${adjusted1}) vs ${game.team2} (${raw2}) → 🏆 Winner: ${winner}`);

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

// ---------- JSON-direct upload (games/scores) ----------
// Accepts: games_week_X.json OR scores_week_X.json
app.post('/api/upload/json-direct', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded.' });

    const original = (file.originalname || '').trim().toLowerCase();
    const m = original.match(/^(games|scores)[-_ ]?week[-_ ]?(\d+)(?:\.json)?$/i);
    if (!m) {
      return res.status(400).json({ error: 'Filename must be games_week_X.json or scores_week_X.json' });
    }
    const kind = m[1].toLowerCase();
    const week = parseInt(m[2], 10);

    const targetName = `${kind}_week_${week}.json`;
    const targetPath = path.join(dataDir, targetName);

    // Read and validate JSON
    const buf = fs.readFileSync(file.path);
    let parsed;
    try { parsed = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '').trim()); }
    catch (e) { return res.status(400).json({ error: 'Uploaded file is not valid JSON.' }); }

    const force = String(req.body.force || '').toLowerCase() === 'true';
    if (fs.existsSync(targetPath) && !force) {
      return res.status(409).json({ message: `Week ${week} ${kind} already exists as ${targetName}. Overwrite it?` });
    }
    if (fs.existsSync(targetPath) && force) {
      const backupName = `${Date.now()}_${targetName}`;
      fs.copyFileSync(targetPath, path.join(backupDir, backupName));
    }

    fs.writeFileSync(targetPath, JSON.stringify(parsed, null, 2));
    console.log(`[json-direct] Saved ${targetName}`);

    // Auto-calc winners if uploading scores and requested
    const autoCalc = String(req.body.autoCalculate || '').toLowerCase() === 'true';
    let autoCalculated = false;
    if (autoCalc && kind === 'scores') {
      try {
        await Promise.resolve(calculateTotalWinners(week));
        await Promise.resolve(calculateWinnersFromList(week));
        autoCalculated = true;
        console.log(`[json-direct] Winners auto-calculated for week ${week}`);
      } catch (e) {
        console.error('Auto-calc winners failed:', e);
      }
    }

    return res.json({ ok: true, kind, week, savedAs: targetName, autoCalculated });
  } catch (err) {
    console.error('/api/upload/json-direct error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ---------- Scores JSON (no auto-calc; accepts only scores_week_X.json) ----------
app.post('/api/upload/scores-json', upload.single('file'), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded.' });

    const original = (file.originalname || '').trim();
    const m = original.match(/^scores[-_ ]?week[-_ ]?(\d+)(?:\.json)?$/i);
    if (!m) return res.status(400).json({ error: 'Filename must be scores_week_X.json' });
    const week = parseInt(m[1], 10);

    const targetName = `scores_week_${week}.json`;
    const targetPath = path.join(dataDir, targetName);

    // Read+validate JSON (tolerant of BOM/whitespace)
    let parsed;
    try {
      const buf  = fs.readFileSync(file.path);
      const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
      parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Root must be an array.');
      for (const row of parsed) {
        if (typeof row.team1 !== 'string' || typeof row.team2 !== 'string') throw new Error('Each item needs string team1/team2.');
        if (typeof row.score1 !== 'number' || typeof row.score2 !== 'number') throw new Error('Each item needs numeric score1/score2.');
        if (row.date !== undefined && typeof row.date !== 'string') throw new Error('If provided, date must be a string.');
      }
    } catch (e) {
      return res.status(400).json({ error: `Invalid scores JSON: ${e.message}` });
    }

    const force = String(req.body.force || '').toLowerCase() === 'true';
    if (fs.existsSync(targetPath) && !force) {
      return res.status(409).json({ error: `${targetName} already exists. Overwrite?`, exists: true });
    }
    if (fs.existsSync(targetPath) && force) {
      const backupPath = path.join(backupDir, `${Date.now()}_${targetName}`);
      fs.copyFileSync(targetPath, backupPath);
    }

    fs.writeFileSync(targetPath, JSON.stringify(parsed, null, 2));
    console.log(`[scores-json] saved ${targetName}`);
    return res.json({ ok: true, week, savedAs: targetName });
  } catch (err) {
    console.error('/api/upload/scores-json error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ---------- Excel Uploads: Spread ----------
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

  // Upload to Drive (best-effort)
  try {
    uploadJsonToDrive && uploadJsonToDrive(filePath, `games_week_${week}.json`)
      .then(id => console.log(`✅ Spread also uploaded to Drive. File ID: ${id}`))
      .catch(err => console.error('❌ Drive upload failed:', err.message));
  } catch (e) {
    console.warn('⚠️ Drive upload module not available.');
  }

  res.send(`✅ Spread uploaded and converted for Week ${week}`);
});

// ---------- Excel Uploads: Scores (auto-calc) ----------
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

  // Upload to Drive (best-effort)
  try {
    uploadJsonToDrive && uploadJsonToDrive(filePath, `scores_week_${week}.json`)
      .then(id => console.log(`✅ Scores also uploaded to Drive. File ID: ${id}`))
      .catch(err => console.error('❌ Drive upload failed:', err.message));
  } catch (e) {
    console.warn('⚠️ Drive upload module not available.');
  }

  res.send(`✅ Scores uploaded and winners calculated for Week ${week}`);
});
// === JSON direct upload (games or scores) ===================================
// Accepts a .json file containing an array.
//   games  item example: { date, team1, spread1, team2, spread2 }
//   scores item example: { team1, team2, score1, score2, (optional) date }
// The uploaded filename must contain "week_#" (e.g., games_week_1.json).
app.post('/api/upload/json-direct', upload.single('file'), (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).send('No file uploaded.');

    // Derive week number from filename (fallback to ?week=)
    const m = (f.originalname || '').match(/week[_ -]?(\d+)/i);
    const weekFromName = m ? parseInt(m[1], 10) : null;
    const week = weekFromName ?? (req.query.week ? parseInt(String(req.query.week), 10) : NaN);
    if (!Number.isInteger(week)) {
      return res.status(400).send('Filename must contain week number (e.g., week_1).');
    }

    // Parse JSON
    let payload;
    try {
      payload = JSON.parse(f.buffer.toString('utf8'));
    } catch {
      return res.status(400).send('Invalid JSON.');
    }
    if (!Array.isArray(payload) || payload.length === 0) {
      return res.status(400).send('JSON must be a non-empty array.');
    }

    // Identify kind by keys
    const sample = payload[0] ?? {};
    const looksLikeGames  = ('spread1' in sample) || ('spread2' in sample);
    const looksLikeScores = ('score1'  in sample) || ('score2'  in sample);
    if (!looksLikeGames && !looksLikeScores) {
      return res.status(400).send('Unrecognized JSON shape (expected games or scores fields).');
    }
    const kind   = looksLikeGames ? 'games' : 'scores';
    const outName = `${kind}_week_${week}.json`;
    const outPath = path.join(dataDir, outName);

    // Overwrite/backup handling — accepts ?force= or ?overwrite= or body flags
    const flag = String(
      (req.query.force ?? req.query.overwrite ?? req.body?.force ?? req.body?.overwrite ?? '')
    ).toLowerCase();
    const force = ['true','1','yes','on'].includes(flag);

    fs.mkdirSync(dataDir, { recursive: true });

    if (fs.existsSync(outPath) && !force) {
      return res.status(409).json({ error: `${outName} already exists. Overwrite?`, exists: true });
    }
    if (fs.existsSync(outPath) && force) {
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(outPath, path.join(backupDir, `${Date.now()}_${outName}`));
      } catch (e) {
        console.warn('Backup failed:', e?.message);
      }
    }

    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    // If scores, immediately compute winners/totals
    if (kind === 'scores') {
      try {
        calculateWinnersFromList(week); // updates winners_detail_week_X.json + totals.json
      } catch (e) {
        console.error('Winner calc error:', e);
      }
    }

    return res.json({ ok: true, kind, week, savedAs: outName });
  } catch (err) {
    console.error('/api/upload/json-direct error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});
// ============================================================================ end

// ---------- Roster Upload (Excel) ----------
app.post('/api/upload/roster', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send('No file uploaded.');

  const filePath = path.join(dataDir, 'roster.json');
  const backupPath = path.join(backupDir, `${Date.now()}_roster.json`);
  const ext = path.extname(file.originalname).toLowerCase();

  if (!['.xlsx', '.xls'].includes(ext)) {
    return res.status(400).send('Unsupported file type. Please upload an Excel file.');
  }

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath); // backup existing
  }

  try {
    const workbook = xlsx.readFile(file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const raw = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    const header = (raw[0] || []).map(h => h?.toString().trim().toLowerCase());
    const nameIdx = header.indexOf('name');
    const pinIdx  = header.indexOf('pin');
    if (nameIdx === -1 || pinIdx === -1) {
      return res.status(400).send('Missing "name" or "pin" columns in roster file.');
    }

    const roster = raw.slice(1)
      .map(row => ({ name: row[nameIdx]?.toString().trim(), pin: row[pinIdx]?.toString().trim() }))
      .filter(p => p.name && p.pin);

    fs.writeFileSync(filePath, JSON.stringify(roster, null, 2));
    res.send(`✅ Roster uploaded successfully. ${roster.length} players added.`);
  } catch (err) {
    console.error('❌ Failed to parse roster:', err);
    res.status(500).send('Failed to process roster file.');
  }
});

// ---------- Picks submission ----------
app.post('/submit-picks/:week', (req, res) => {
  const week = parseInt(req.params.week, 10);
  const { player, pin, picks } = req.body || {};
  if (!player || !pin || !Array.isArray(picks)) {
    return res.status(400).json({ success: false, error: 'Missing data.' });
    }

  const filename = path.join(dataDir, `picks_week_${week}.json`);
  let data = [];
  if (fs.existsSync(filename)) {
    try {
      const backupPath = path.join(backupDir, `${Date.now()}_picks_week_${week}.json`);
      fs.copyFileSync(filename, backupPath);
      data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch {
      return res.status(500).json({ success: false, error: 'Error reading picks file.' });
    }
  }

  const newData = data.filter(entry => (entry.player || '').toLowerCase() !== player.toLowerCase());
  newData.push({ player, pin, picks, week });

  try {
    fs.writeFileSync(filename, JSON.stringify(newData, null, 2));
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to save picks.' });
  }
});

// ---------- Utility/Info routes ----------
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

app.post('/api/authenticate', (req, res) => {
  const { gameName, pin } = req.body || {};
  const filePath = path.join(dataDir, 'roster.json');
  if (!fs.existsSync(filePath)) return res.json({ success: false });
  try {
    const roster = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const player = roster.find(p => (p.name || '').toLowerCase() === (gameName || '').toLowerCase() && p.pin === pin);
    res.json({ success: !!player });
  } catch {
    res.json({ success: false });
  }
});

app.get('/api/rules', (req, res) => {
  const filePath = path.join(dataDir, 'rules.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Failed to load rules' });
    try { res.json(JSON.parse(data)); }
    catch { res.status(500).json({ error: 'Invalid rules format' }); }
  });
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
  const filePath = path.join(dataDir, 'chat.json');
  const newMessage = { name: req.body?.name, message: req.body?.message, timestamp: new Date().toISOString() };

  fs.readFile(filePath, 'utf8', (err, data) => {
    let messages = [];
    if (!err) {
      try {
        messages = JSON.parse(data);
        const backupPath = path.join(backupDir, `${Date.now()}_chat.json`);
        if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
      } catch {}
    }
    messages.push(newMessage);
    fs.writeFile(filePath, JSON.stringify(messages.slice(-50), null, 2), e => {
      if (e) return res.status(500).json({ error: 'Failed to save message' });
      res.json({ success: true });
    });
  });
});

// Reset system state (dangerous; keep for admin/debug only)
app.post('/api/reset-system', (req, res) => {
  try {
    const files = fs.readdirSync(dataDir);
    const weekFilePatterns = [/^games_week_\\d+\\.json$/, /^scores_week_\\d+\\.json$/, /^picks_week_\\d+\\.json$/, /^winners_week_\\d+\\.json$/, /^winners_detail_week_\\d+\\.json$/, /^declaredwinners_week_\\d+\\.json$/];
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

// Calculate total winners (GET/POST)
app.all('/api/calculate-totalwinners/:week', (req, res) => {
  const week = parseInt(req.params.week, 10);
  calculateTotalWinners(week);
  calculateWinnersFromList(week);
  res.send(`✅ Calculating total winners for Week ${week}`);
});

// Download a JSON file directly
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(dataDir, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('File not found.');
  res.download(filepath);
});

// List JSON files in /data
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

// Upload a sample file to Drive (best-effort)
app.get('/api/upload-test', async (req, res) => {
  console.log('📤 Upload test route called');
  try {
    const localPath = path.join(dataDir, 'current_week.json');
    if (!fs.existsSync(localPath)) fs.writeFileSync(localPath, JSON.stringify({ currentWeek: 1 }, null, 2));
    if (!uploadJsonToDrive) throw new Error('uploadJsonToDrive not available');
    const fileId = await uploadJsonToDrive(localPath, 'current_week.json');
    res.send(`✅ File uploaded to Drive! File ID: ${fileId}`);
  } catch (err) {
    console.error('❌ Upload failed:', err.message);
    res.status(500).send('Upload failed. Check terminal for details.');
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`🌍 Server is running on port ${PORT}`);
  console.log(`📁 DATA_DIR: ${dataDir}`);
  console.log(`📦 BACKUP_DIR: ${backupDir}`);
});
