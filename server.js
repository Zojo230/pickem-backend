// Force redeploy to update totals.json

const { uploadJsonToDrive } = require('./driveUpload');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const app = express();


app.use(cors());
app.use(express.json());
app.use('/data', express.static(path.join(__dirname, 'data')));

const uploadDir = path.join(__dirname, 'uploads');
const dataDir = path.join(__dirname, 'data');
const backupDir = path.join(dataDir, 'backups');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

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
const calculateTotalWinners = (week) => {
  const scoresPath = path.join(dataDir, `scores_week_${week}.json`);
  const gamesPath = path.join(dataDir, `games_week_${week}.json`);
  const detailPath = path.join(dataDir, `winners_detail_week_${week}.json`);
  const winnersPath = path.join(dataDir, `declaredwinners_week_${week}.json`);

  if (!fs.existsSync(scoresPath) || !fs.existsSync(gamesPath)) {
    console.log(`❌ Missing scores or games file for Week ${week}`);
    return;
  }

  const normalize = str => str
    .replace(/[^a-zA-Z0-9]/g, '')
    .replace(/state$/i, 'st')
    .toLowerCase();

  const scores = JSON.parse(fs.readFileSync(scoresPath));
  const games = JSON.parse(fs.readFileSync(gamesPath));

  const detail = [];
  const declaredWinners = [];

  for (const game of games) {
    const g1 = normalize(game.team1);
    const g2 = normalize(game.team2);

    const match = scores.find(s => {
      const s1 = normalize(s.team1);
      const s2 = normalize(s.team2);
      return (s1 === g1 && s2 === g2) || (s1 === g2 && s2 === g1);
    });

    if (!match) {
      console.log(`❌ Could not match score for game: ${game.team1} vs ${game.team2}`);
      continue;
    }

    const adjusted1 = match.score1 + game.spread1;
    const raw2 = match.score2;

    let winner = '';
    if (adjusted1 > raw2) {
      winner = game.team1;
    } else if (adjusted1 < raw2) {
      winner = game.team2;
    } else {
      winner = 'PUSH';
    }

    console.log(`🧮 ${game.team1} (${match.score1} + ${game.spread1} = ${adjusted1}) vs ${game.team2} (${raw2}) → 🏆 Winner: ${winner}`);

    detail.push({
      team1: game.team1,
      spread1: game.spread1,
      score1: match.score1,
      team2: game.team2,
      spread2: game.spread2,
      score2: match.score2,
      winner
    });

    if (winner !== 'PUSH') {
      declaredWinners.push(winner);
    }
  }

  fs.writeFileSync(detailPath, JSON.stringify(detail, null, 2));
  fs.writeFileSync(winnersPath, JSON.stringify(declaredWinners, null, 2));

  console.log(`✅ Week ${week} winners calculated: ${declaredWinners.length} games with valid winner`);
  console.log(`📄 Output: winners_detail_week_${week}.json + declaredwinners_week_${week}.json`);
};

// ===== Upload Spread =====
app.post('/api/upload/spread', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send('No file uploaded.');

  const weekMatch = file.originalname.match(/week[_-]?(\d+)/i);
  if (!weekMatch) return res.status(400).send('Filename must contain week number.');
  const week = parseInt(weekMatch[1]);

  const filePath = path.join(dataDir, `games_week_${week}.json`);
  const backupPath = path.join(backupDir, `${Date.now()}_games_week_${week}.json`);
  const force = req.body.force === 'true';

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
      try {
        return parseFloat(val.replace(/[()]/g, '').split(' ')[0]);
      } catch {
        return '';
      }
    };

    const spread1 = cleanSpread(spread1Raw);
    const spread2 = cleanSpread(spread2Raw);

    if (cleanTeam1 && cleanTeam2 && !isNaN(spread1) && !isNaN(spread2)) {
      games.push({ date: fullDate, team1: cleanTeam1, spread1, team2: cleanTeam2, spread2 });
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(games, null, 2));
  fs.writeFileSync(path.join(dataDir, 'current_week.json'), JSON.stringify({ currentWeek: week }, null, 2));

  // ✅ Upload to Google Drive
  uploadJsonToDrive(filePath, `games_week_${week}.json`)
    .then(id => console.log(`✅ Spread also uploaded to Drive. File ID: ${id}`))
    .catch(err => console.error('❌ Drive upload failed:', err.message));

  res.send(`✅ Spread uploaded and converted for Week ${week}`);
});

app.post('/api/upload/scores', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send('No file uploaded.');

  const weekMatch = file.originalname.match(/week[_-]?(\d+)/i);
  if (!weekMatch) return res.status(400).send('Filename must contain week number.');
  const week = parseInt(weekMatch[1]);

  const filePath = path.join(dataDir, `scores_week_${week}.json`);
  const backupPath = path.join(backupDir, `${Date.now()}_scores_week_${week}.json`);
  const force = req.body.force === 'true';

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

  const normalize = str => str?.replace(/[^a-zA-Z0-9]/g, '').replace(/state$/i, 'st').toLowerCase();

  const gamesPath = path.join(dataDir, `games_week_${week}.json`);
  if (!fs.existsSync(gamesPath)) {
    return res.status(400).send(`Missing games_week_${week}.json`);
  }
  const spreadGames = JSON.parse(fs.readFileSync(gamesPath));

  const orderedScores = spreadGames.map(game => {
    const g1 = normalize(game.team1);
    const g2 = normalize(game.team2);
    const match = rawScores.find(s => {
      const s1 = normalize(s.team1);
      const s2 = normalize(s.team2);
      return (s1 === g1 && s2 === g2) || (s1 === g2 && s2 === g1);
    });

    if (!match) {
      console.warn(`⚠️ Score not found for: ${game.team1} vs ${game.team2}`);
      return null;
    }

    // Reorder if needed
    const s1 = normalize(match.team1);
    const needsSwap = s1 !== g1;
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

  // === Calculate winners (spread logic + player points) ===
  calculateTotalWinners(week);
  calculateWinnersFromList(week); // ✅ This triggers player score generation

  // === Upload to Google Drive ===
  uploadJsonToDrive(filePath, `scores_week_${week}.json`)
    .then(id => console.log(`✅ Scores also uploaded to Drive. File ID: ${id}`))
    .catch(err => console.error('❌ Drive upload failed:', err.message));

  res.send(`✅ Scores uploaded and winners calculated for Week ${week}`);
});

// ===== Upload Player Roster =====
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
    fs.copyFileSync(filePath, backupPath); // ✅ Backup old roster
  }

  try {
    const workbook = xlsx.readFile(file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const raw = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    // Expecting first row: [ 'name', 'pin' ]
    const header = raw[0].map(h => h?.toString().trim().toLowerCase());
    const nameIdx = header.indexOf('name');
    const pinIdx = header.indexOf('pin');

    if (nameIdx === -1 || pinIdx === -1) {
      return res.status(400).send('Missing "name" or "pin" columns in roster file.');
    }

    const roster = raw.slice(1)
      .map(row => ({
        name: row[nameIdx]?.toString().trim(),
        pin: row[pinIdx]?.toString().trim()
      }))
      .filter(player => player.name && player.pin);

    fs.writeFileSync(filePath, JSON.stringify(roster, null, 2));
    res.send(`✅ Roster uploaded successfully. ${roster.length} players added.`);
  } catch (err) {
    console.error('❌ Failed to parse roster:', err);
    res.status(500).send('Failed to process roster file.');
  }
});

// ===== Submit Picks =====
app.post('/submit-picks/:week', (req, res) => {
  const week = parseInt(req.params.week);
  const { player, pin, picks } = req.body;
  if (!player || !pin || !Array.isArray(picks)) {
    return res.status(400).json({ success: false, error: 'Missing data.' });
  }

  const filename = path.join(dataDir, `picks_week_${week}.json`);
  let data = [];
  if (fs.existsSync(filename)) {
    const backupPath = path.join(backupDir, `${Date.now()}_picks_week_${week}.json`);
    fs.copyFileSync(filename, backupPath); // ✅ Auto-backup
    try {
      data = JSON.parse(fs.readFileSync(filename));
    } catch {
      return res.status(500).json({ success: false, error: 'Error reading picks file.' });
    }
  }

  const newData = data.filter(entry => entry.player?.toLowerCase() !== player.toLowerCase());
  newData.push({ player, pin, picks, week });
  try {
    fs.writeFileSync(filename, JSON.stringify(newData, null, 2));
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to save picks.' });
  }
});

//    calculates winners from list
function calculateWinnersFromList(week) {
  const picksFile = path.join(dataDir, `picks_week_${week}.json`);
  const winnersFile = path.join(dataDir, `declaredwinners_week_${week}.json`);
  const outputFile = path.join(dataDir, `winners_week_${week}.json`);
  const totalsFile = path.join(dataDir, 'totals.json');

  if (!fs.existsSync(picksFile) || !fs.existsSync(winnersFile)) {
    console.error(`❌ Missing picks or declared winners for week ${week}`);
    return;
  }

  const picksData = JSON.parse(fs.readFileSync(picksFile));
  const winnersList = JSON.parse(fs.readFileSync(winnersFile));

  const results = picksData.map(player => {
    const correct = player.picks
      .map(p => p.pick.trim())
      .filter(pick => winnersList.includes(pick));

    return {
      player: player.player,
      correct,
      total: correct.length
    };
  });

  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`✅ winners_week_${week}.json written (player-specific format)`);

  // === Update totals.json ===
  let existingTotals = {};
  if (fs.existsSync(totalsFile)) {
    try {
      existingTotals = JSON.parse(fs.readFileSync(totalsFile));
    } catch {
      console.warn('⚠️ Failed to read existing totals.json, starting fresh');
    }
  }

  for (const result of results) {
    const name = result.player.trim();
    const current = existingTotals[name] || 0;
    existingTotals[name] = current + result.total;
  }

  fs.writeFileSync(totalsFile, JSON.stringify(existingTotals, null, 2));
  console.log('📊 totals.json updated');
}

// ===== All Other Routes =====
app.get('/api/currentWeek', (req, res) => {
  const filePath = path.join(dataDir, 'current_week.json');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Current week not set' });
  try {
    const data = JSON.parse(fs.readFileSync(filePath));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read current week file' });
  }
});

app.get('/api/totals', (req, res) => {
  const filePath = path.join(dataDir, 'totals.json');
  if (!fs.existsSync(filePath)) return res.json([]);
  try {
    const data = JSON.parse(fs.readFileSync(filePath));
    const asArray = Object.entries(data).map(([player, total]) => ({
      player,
      total
    }));
    res.json(asArray);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read totals file' });
  }
});

app.get('/api/games', (req, res) => {
  const currentWeekPath = path.join(dataDir, 'current_week.json');
  if (!fs.existsSync(currentWeekPath)) return res.status(404).json({ error: 'Current week not set' });
  try {
    const current = JSON.parse(fs.readFileSync(currentWeekPath));
    const week = current.currentWeek;
    const gamesPath = path.join(dataDir, `games_week_${week}.json`);
    if (!fs.existsSync(gamesPath)) return res.status(404).json({ error: 'Games not found for current week' });

    const games = JSON.parse(fs.readFileSync(gamesPath));
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load games data' });
  }
});

app.post('/api/check-player-picks', (req, res) => {
  const { week, playerName } = req.body;
  const filePath = path.join(dataDir, `picks_week_${week}.json`);
  if (!fs.existsSync(filePath)) return res.json({ alreadyPicked: false });

  const picksData = JSON.parse(fs.readFileSync(filePath));
  const found = picksData.some(entry => entry.player.toLowerCase() === playerName.toLowerCase());
  res.json({ alreadyPicked: found });
});

app.post('/api/authenticate', (req, res) => {
  const { gameName, pin } = req.body;
  const filePath = path.join(dataDir, 'roster.json');
  if (!fs.existsSync(filePath)) return res.json({ success: false });

  const data = JSON.parse(fs.readFileSync(filePath));
  const player = data.find(p => p.name.toLowerCase() === gameName.toLowerCase() && p.pin === pin);
  res.json({ success: !!player });
});

app.get('/api/rules', (req, res) => {
  const filePath = path.join(dataDir, 'rules.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Failed to load rules' });
    try {
      res.json(JSON.parse(data));
    } catch {
      res.status(500).json({ error: 'Invalid rules format' });
    }
  });
});

app.get('/api/chat', (req, res) => {
  const filePath = path.join(dataDir, 'chat.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.json([]);
    try {
      res.json(JSON.parse(data));
    } catch {
      res.json([]);
    }
  });
});

app.post('/api/chat', (req, res) => {
  const filePath = path.join(dataDir, 'chat.json');
  const newMessage = {
    name: req.body.name,
    message: req.body.message,
    timestamp: new Date().toISOString(),
  };

  fs.readFile(filePath, 'utf8', (err, data) => {
    let messages = [];
    if (!err) {
      try {
        messages = JSON.parse(data);
        const backupPath = path.join(backupDir, `${Date.now()}_chat.json`);
        fs.copyFileSync(filePath, backupPath); // ✅ Auto-backup before writing
      } catch {}
    }

    messages.push(newMessage);
    fs.writeFile(filePath, JSON.stringify(messages.slice(-50), null, 2), err => {
      if (err) return res.status(500).json({ error: 'Failed to save message' });
      res.json({ success: true });
    });
  });
});

// ===== Reset System State =====
app.post('/api/reset-system', (req, res) => {
  const files = fs.readdirSync(dataDir);
  const weekFilePatterns = [/^games_week_\d+\.json$/, /^scores_week_\d+\.json$/, /^picks_week_\d+\.json$/, /^winners_week_\d+\.json$/];

  try {
    // Delete week-specific files
    files.forEach(file => {
      if (weekFilePatterns.some(regex => regex.test(file))) {
        fs.unlinkSync(path.join(dataDir, file));
      }
    });

    // Reset current_week.json
    fs.writeFileSync(path.join(dataDir, 'current_week.json'), JSON.stringify({ currentWeek: 1 }, null, 2));

    // Reset totals and cumulative scores
    fs.writeFileSync(path.join(dataDir, 'totals.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'cumulative_scores.json'), JSON.stringify({}, null, 2));

    res.send('✅ System reset complete. All week files removed and core files reset to Week 1.');
  } catch (err) {
    console.error('❌ Reset failed:', err);
    res.status(500).send('Reset failed. Check server logs for details.');
  }
});
app.post('/api/calculate-totalwinners/:week', (req, res) => {
  const week = parseInt(req.params.week);
  calculateTotalWinners(week);
  calculateWinnersFromList(week);
  res.send(`✅ Calculating total winners for Week ${week}`);
});

// ===== File Download Debug Endpoint =====
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(dataDir, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('File not found.');
  }
  res.download(filepath);
});
// ===== Debug: List all JSON files in /data =====
app.get('/api/calculate-totalwinners/:week', (req, res) => {
  const week = parseInt(req.params.week);
  calculateTotalWinners(week);
  calculateWinnersFromList(week); // ✅ This line was missing
  res.send(`✅ Calculating total winners for Week ${week} via GET`);
});

app.get('/api/debug/files', (req, res) => {
  try {
    const files = fs.readdirSync(dataDir)
      .filter(name => name.endsWith('.json'))
      .map(name => ({
        name,
        size: fs.statSync(path.join(dataDir, name)).size + ' bytes'
      }));

    console.log('✅ Debug file list generated');
    res.setHeader('Content-Type', 'application/json');
    res.json({ count: files.length, files });
  } catch (err) {
    console.error('❌ Failed to list files:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});
// ===== Debug: List all JSON files in /data =====
app.get('/api/debug/files', (req, res) => {
  try {
    const files = fs.readdirSync(dataDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const filepath = path.join(dataDir, name);
        const stats = fs.statSync(filepath);
        return {
          name,
          size: stats.size + ' bytes',
          modified: stats.mtime.toLocaleString()
        };
      });

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      timestamp: new Date().toISOString(),
      count: files.length,
      files
    });
  } catch (err) {
    console.error('❌ Failed to list files:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});
//const { uploadJSON } = require('./driveStorage');

// ===== TEST: Upload a file to Google Drive =====
app.get('/api/debug/upload-test', async (req, res) => {
  console.log('📤 Upload test route called');
  try {
    const sampleData = {
      week: 3,
      note: 'This is a test file to confirm Google Drive upload'
    };

    const fileId = await uploadJSON('test_upload.json', sampleData);
    res.send(`✅ File uploaded to Drive! File ID: ${fileId}`);
  } catch (err) {
    console.error('❌ Upload failed:', err.message);
    res.status(500).send('Upload to Drive failed.');
  }
});

app.get('/api/upload-test', async (req, res) => {
  console.log('📤 Upload test route called');
  try {
    const localPath = path.join(__dirname, 'data', 'current_week.json');
    const fileId = await uploadJsonToDrive(localPath, 'current_week.json');
    res.send(`✅ File uploaded to Drive! File ID: ${fileId}`);
  } catch (err) {
    console.error('❌ Upload failed:', err.message);
    res.status(500).send('Upload failed. Check terminal for details.');
  }
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`🌍 Server is running on port ${PORT}`);
});

