const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const userData = path.join(process.env.APPDATA, 'live-view-studio');
app.setName('live-view-studio');
app.setPath('userData', userData);

function readCredential(file) {
  const envelope = JSON.parse(fs.readFileSync(path.join(userData, file), 'utf8'));
  const raw = envelope.mode === 'encrypted'
    ? safeStorage.decryptString(Buffer.from(envelope.value, 'base64'))
    : envelope.value;
  return JSON.parse(raw);
}

app.whenReady().then(async () => {
  try {
    const token = process.env.GITHUB_TRANSFER_READ_TOKEN;
    if (!token || !safeStorage.isEncryptionAvailable()) {
      console.log(JSON.stringify({ userTokenConfigured: Boolean(token), credentialStoreAvailable: safeStorage.isEncryptionAvailable() }));
      app.exit(2);
      return;
    }

    const current = readCredential('transfer-channel.json');
    const backup = readCredential('transfer-channel-github-backup.json');
    const credentials = current.mode === 'github' ? current : backup;
    if (credentials.mode !== 'github' || !credentials.githubOwner || !credentials.githubRepo || !credentials.channelId) {
      console.log(JSON.stringify({ userTokenConfigured: true, photoRepositoryConfigured: false }));
      app.exit(3);
      return;
    }

    const base = `https://api.github.com/repos/${encodeURIComponent(credentials.githubOwner)}/${encodeURIComponent(credentials.githubRepo)}`;
    const manifestPath = `channels/${credentials.channelId}/manifest.json`;
    const encodedPath = manifestPath.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${base}/contents/${encodedPath}?ref=${encodeURIComponent(credentials.githubBranch || 'main')}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LiveViewStudio-ReadOnly-Token-Check',
      },
    });
    if (!response.ok) {
      console.log(JSON.stringify({ userTokenConfigured: true, manifestHttpStatus: response.status, manifestReadable: false }));
      app.exit(4);
      return;
    }

    const item = await response.json();
    const raw = item.encoding === 'base64'
      ? Buffer.from(item.content.replace(/\s/g, ''), 'base64')
      : Buffer.from(await (await fetch(item.download_url)).arrayBuffer());
    const manifest = JSON.parse(raw.toString('utf8'));
    console.log(JSON.stringify({
      userTokenConfigured: true,
      manifestHttpStatus: response.status,
      manifestReadable: true,
      photoCount: Array.isArray(manifest.images) ? manifest.images.length : 0,
    }));
  } catch (_) {
    console.log(JSON.stringify({ checkCompleted: false, reason: 'local credential or GitHub request failed' }));
    app.exit(5);
    return;
  }
  app.quit();
});
