const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  }
});

async function sendPicksConfirmation({ email, playerName, week, picks }) {
  if (!email) {
    console.log(`⚠️ No email address found for ${playerName}. Confirmation not sent.`);
    return;
  }

  const picksList = picks
    .map((pick, index) => `${index + 1}. ${pick}`)
    .join('\n');

  const mailOptions = {
    from: `"Shama-Lama Football Challenge" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: `Shama-Lama Football Challenge - Week ${week} Picks`,
    text:
`You made your picks successfully.

Below are your selections for Week ${week}:

${picksList}

Good luck!

Shama-Lama Football Challenge`
  };

  try {
    const info = await transporter.sendMail(mailOptions);

    console.log(
      `✅ Picks confirmation email sent to ${playerName} at ${email}: ${info.messageId}`
    );
  } catch (err) {
    console.error(
      `❌ Picks were saved, but confirmation email failed for ${playerName}:`,
      err.message
    );
  }
}
async function sendWeeklyResults({
  email,
  playerName,
  week,
  picks,
  weeklyScore,
  overallScore
}) {
  if (!email) {
    console.log(`⚠️ No email address found for ${playerName}. Weekly results not sent.`);
    return;
  }

    const picksList = (picks || [])
    .map((pick, index) =>
    `${index + 1}. ${pick.team} — ${pick.result}`
  )
  .join('\n');   

  const mailOptions = {
    from: `"Shama-Lama Football Challenge" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: `Shama-Lama Week ${week} Results - ${weeklyScore} Points`,
    text:
`Shama-Lama Football Challenge
Week ${week} Results

Player: ${playerName}

Your Picks:
${picksList}


Week ${week} Score: ${weeklyScore}
Overall Score: ${overallScore}

Check out the Chat page at shama-lama.com and join the conversation!

Shama-Lama Football Challenge`
  };

  try {
    const info = await transporter.sendMail(mailOptions);

    console.log(
      `✅ Weekly results email sent to ${playerName} at ${email}: ${info.messageId}`
    );
  } catch (err) {
    console.error(
      `❌ Weekly results email failed for ${playerName}:`,
      err.message
    );
  }
}
module.exports = {
  sendPicksConfirmation,
  sendWeeklyResults
};