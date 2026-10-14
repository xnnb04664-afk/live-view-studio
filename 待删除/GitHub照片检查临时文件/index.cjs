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
async function run() {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
    const current = readCredential('transfer-channel.json');
    const backup = readCredential('transfer-channel-github-backup.json');
    const credentials = current.mode === 'github' ? current : backup;
    if (credentials.mode !== 'github' || !credentials.githubOwner || !credentials.githubRepo || !credentials.githubToken) {
      throw new Error('No valid GitHub credentials found');
    }
    const headers = {
      Authorization: `Bearer ${credentials.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'LiveViewStudio-ReadOnly-Migration-Audit',
    };
    const base = `https://api.github.com/repos/${encodeURIComponent(credentials.githubOwner)}/${encodeURIComponent(credentials.githubRepo)}`;
    const manifestPath = `channels/${credentials.channelId}/manifest.json`;
    const manifestResponse = await fetch(`${base}/contents/${manifestPath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(credentials.githubBranch)}`, { headers });
    if (!manifestResponse.ok) throw new Error(`Manifest HTTP ${manifestResponse.status}`);
    const manifestItem = await manifestResponse.json();
    const manifestBytes = manifestItem.encoding === 'base64' ? Buffer.from(manifestItem.content.replace(/\s/g, ''), 'base64') : Buffer.from(await (await fetch(manifestItem.download_url, { headers })).arrayBuffer());
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const treeResponse = await fetch(`${base}/git/trees/${encodeURIComponent(credentials.githubBranch)}?recursive=1`, { headers });
    if (!treeResponse.ok) throw new Error(`Tree HTTP ${treeResponse.status}`);
    const tree = await treeResponse.json();
    if (tree.truncated) throw new Error('GitHub repository tree is truncated');
    const entries = new Map((tree.tree || []).filter(x => x.type === 'blob').map(x => [x.path, x]));
    const images = Array.isArray(manifest.images) ? manifest.images : [];
    let imagePresent = 0, previewExpected = 0, previewPresent = 0, imageSizeMismatch = 0, previewSizeMismatch = 0;
    for (const image of images) {
      const id = image.id;
      const imagePath = image.storagePath || `channels/${credentials.channelId}/images/${id}.bin`;
      const blob = entries.get(imagePath);
      if (blob) {
        imagePresent++;
        if (Number.isFinite(image.sizeBytes) && blob.size !== image.sizeBytes) imageSizeMismatch++;
      }
      if (image.previewNonce) {
        previewExpected++;
        const previewPath = image.previewStoragePath || `channels/${credentials.channelId}/previews/${id}.jpg.bin`;
        const preview = entries.get(previewPath);
        if (preview) {
          previewPresent++;
          if (Number.isFinite(image.previewSizeBytes) && preview.size !== image.previewSizeBytes) previewSizeMismatch++;
        }
      }
    }
    console.log(JSON.stringify({
      currentMode: current.mode || 'legacy',
      backupMode: backup.mode || 'legacy',
      channelMatches: current.channelId === manifest.channelId,
      manifestImages: images.length,
      originalObjectsPresent: imagePresent,
      missingOriginalObjects: images.length - imagePresent,
      previewsExpected: previewExpected,
      previewsPresent: previewPresent,
      missingPreviews: previewExpected - previewPresent,
      originalSizeMismatches: imageSizeMismatch,
      previewSizeMismatches: previewSizeMismatch,
      fileIndexTruncated: Boolean(tree.truncated),
    }, null, 2));
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    app.exit(1);
    return;
  }
  app.quit();
}
app.whenReady().then(run);
