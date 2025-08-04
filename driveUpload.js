// driveUpload.js — OAuth2 version (safe for Render)

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Detect if we're running on Render
const isRender = process.env.RENDER === "true";

if (isRender) {
  console.log("🔒 Running on Render — Google Drive upload disabled.");
  module.exports = {
    uploadJsonToDrive: async () => {
      return "Drive upload skipped in Render.";
    }
  };
  return;
}

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'oauth-credentials.json');

// Load credentials
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
const { client_secret, client_id, redirect_uris } = credentials.installed;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

// Authorize user or load saved token
async function authorize() {
  try {
    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
  } catch {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log('\n🔐 Visit this URL to authorize access:\n\n' + authUrl);

    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await new Promise((resolve, reject) => {
      readline.question('\n📥 Paste the code here: ', (code) => {
        readline.close();
        oAuth2Client.getToken(code, (err, token) => {
          if (err) return reject(err);
          oAuth2Client.setCredentials(token);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
          console.log('\n✅ Access token saved to', TOKEN_PATH);
          resolve();
        });
      });
    });
  }

  return oAuth2Client;
}

async function uploadJsonToDrive(localPath, filename) {
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });

  const fileMetadata = { name: filename };
  const media = {
    mimeType: 'application/json',
    body: fs.createReadStream(localPath),
  };

  const response = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id, name',
  });

  console.log(`✅ Uploaded to Drive: ${response.data.name} (ID: ${response.data.id})`);
  return response.data.id;
}

module.exports = { uploadJsonToDrive };
