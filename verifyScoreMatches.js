const fs = require('fs');
const path = require('path');

const week = 1; // 👈 Change this to test other weeks
const dataDir = path.join(__dirname, 'data');

const normalize = str =>
  str?.replace(/[^a-zA-Z0-9]/g, '')
      .replace(/state$/i, 'st')
      .toLowerCase();

const gamesPath = path.join(dataDir, `games_week_${week}.json`);
const scoresPath = path.join(dataDir, `scores_week_${week}.json`);

if (!fs.existsSync(gamesPath) || !fs.existsSync(scoresPath)) {
  console.error('❌ Missing games or scores file.');
  process.exit(1);
}

const games = JSON.parse(fs.readFileSync(gamesPath));
const scores = JSON.parse(fs.readFileSync(scoresPath));

const unmatched = [];

for (const game of games) {
  const g1 = normalize(game.team1);
  const g2 = normalize(game.team2);

  const match = scores.find(s => {
    const s1 = normalize(s.team1);
    const s2 = normalize(s.team2);
    return (s1 === g1 && s2 === g2) || (s1 === g2 && s2 === g1);
  });

  if (!match) {
    unmatched.push({ team1: game.team1, team2: game.team2 });
  }
}

if (unmatched.length === 0) {
  console.log('✅ All games matched correctly!');
} else {
  console.log(`❌ ${unmatched.length} game(s) could not be matched:\n`);
  unmatched.forEach((game, index) => {
    console.log(`${index + 1}. ${game.team1} vs ${game.team2}`);
  });

  const scoreTeams = scores.flatMap(s => [s.team1, s.team2]);

  console.log(`\n🧠 Suggestions (fuzzy matches):`);
  unmatched.forEach((game, i) => {
    const g1 = normalize(game.team1);
    const g2 = normalize(game.team2);

    const suggestions1 = scoreTeams.filter(t => normalize(t) === g1 || t.toLowerCase().includes(game.team1.toLowerCase()));
    const suggestions2 = scoreTeams.filter(t => normalize(t) === g2 || t.toLowerCase().includes(game.team2.toLowerCase()));

    console.log(`\n${i + 1}. ${game.team1} vs ${game.team2}`);
    console.log(`   ↪ Possible matches in scores file:`);
    console.log(`     - ${game.team1}:`, suggestions1.length ? suggestions1.join(', ') : '❌ none');
    console.log(`     - ${game.team2}:`, suggestions2.length ? suggestions2.join(', ') : '❌ none');
  });
}
