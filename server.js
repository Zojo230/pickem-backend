const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const app = express();
const PORT = 4000;

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
  res.send(`✅ Spread uploaded and converted for Week ${week}`);
});

// ===== Upload Scores =====
app.post('/api/upload/scores', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send('No file uploaded.');

  const weekMatch = file.originalname.match(/week[_-]?(\d+)/i);
  if (!weekMatch) return res.status(400).send('Filename must contain week number.');
  const week = parseInt(weekMatch[1]);

  const filePath = path.join(dataDir, `scores_week_${week}.json`);
  const backupPath = path.join(backupDir, `${Date.now()}_scores_week_${week}.json`);
  const force = req.body.force === 'true'; // ✅ enable override logic

  // Block upload if file exists and force not set
  if (fs.existsSync(filePath) && !force) {
    return res.status(409).json({ message: `Week ${week} scores already exist. Overwrite?` });
  }

  // Backup file if overwriting
  if (fs.existsSync(filePath) && force) {
    fs.copyFileSync(filePath, backupPath);
  }

  const workbook = xlsx.readFile(file.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const jsonData = xlsx.utils.sheet_to_json(sheet);

  fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2));
  calculateWinners(week);
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

// ===== Calculate Winners =====
function calculateWinners(week) {
  try {
    const picksFile = path.join(dataDir, `picks_week_${week}.json`);
    const gamesFile = path.join(dataDir, `games_week_${week}.json`);
    const scoresFile = path.join(dataDir, `scores_week_${week}.json`);
    const winnersFile = path.join(dataDir, `winners_week_${week}.json`);
    const totalsFile = path.join(dataDir, 'totals.json');
    const cumulativeFile = path.join(dataDir, 'cumulative_scores.json');

    if (!fs.existsSync(picksFile) || !fs.existsSync(gamesFile) || !fs.existsSync(scoresFile)) {
      console.log('❌ Missing file(s) for week', week);
      return;
    }

    const picksData = JSON.parse(fs.readFileSync(picksFile));
    const gamesData = JSON.parse(fs.readFileSync(gamesFile));
    const scoresData = JSON.parse(fs.readFileSync(scoresFile));
    const totalsData = fs.existsSync(totalsFile) ? JSON.parse(fs.readFileSync(totalsFile)) : {};
    const cumulativeData = fs.existsSync(cumulativeFile) ? JSON.parse(fs.readFileSync(cumulativeFile)) : {};
    const winners = [];

    picksData.forEach(entry => {
      const player = entry.player?.trim();
      if (!player) return;

      const correct = [];
      const { picks } = entry;

      picks.forEach(pick => {
        const pickedTeam = pick.pick?.trim();
        const gameIndex = pick.gameIndex;
        const game = gamesData[gameIndex];
        const score = scoresData[gameIndex];
        if (!game || !score) return;

        const score1 = parseInt(score["Score 1"]);
        const score2 = parseInt(score["Score 2"]);
        const team1Name = score["Team 1"]?.trim();
        const team2Name = score["Team 2"]?.trim();
        const spread1 = parseFloat(game.spread1) || 0;
        const spread2 = parseFloat(game.spread2) || 0;

        const team1Final = score1 + spread1;
        const team2Final = score2 + spread2;

        const winner = team1Final > team2Final ? team1Name : team2Final > team1Final ? team2Name : null;
        if (pickedTeam === winner) correct.push(pickedTeam);
      });

      const total = correct.length;
      winners.push({ player, correct, total });
      totalsData[player] = (totalsData[player] ?? 0) + total;
      cumulativeData[player] = (cumulativeData[player] ?? 0) + total;
    });

    fs.writeFileSync(winnersFile, JSON.stringify(winners, null, 2));
    fs.writeFileSync(totalsFile, JSON.stringify(totalsData, null, 2));
    fs.writeFileSync(cumulativeFile, JSON.stringify(cumulativeData, null, 2));
    console.log(`✅ Winners for Week ${week} calculated.`);
  } catch (err) {
    console.error('❌ Error calculating winners:', err);
  }
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
  if (!fs.existsSync(filePath)) return res.json({});
  try {
    const data = JSON.parse(fs.readFileSync(filePath));
    res.json(data);
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

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});

