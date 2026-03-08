#!/usr/bin/env node
/**
 * AI Content Coach — Data Fetcher
 * ─────────────────────────────────────────────────────────
 * Scrapes the last 25 posts from Instagram for you and your
 * competitors, downloads reels, transcribes them with Whisper,
 * and saves everything to data/ for the dashboard.
 *
 * On every run: merges new posts with existing saved data.
 * Your post history grows over time — the AI gets smarter.
 *
 * First time? Run: /content-coach in Claude Code for guided setup.
 * Manual setup:
 *   1. cp config.example.json config.json  (edit your handles)
 *   2. cp .env.example .env               (add your APIFY_TOKEN)
 *   3. npm install
 *   4. node fetch-data.js
 */

require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { execSync, spawnSync } = require('child_process');

// ─── Load Config ─────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_FILE)) {
  console.error('\n❌  config.json not found.');
  console.error('    Run: cp config.example.json config.json');
  console.error('    Then edit it with your Instagram handle and competitors.');
  console.error('    Or run /content-coach in Claude Code for guided setup.\n');
  process.exit(1);
}

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
const APIFY_TOKEN = process.env.APIFY_TOKEN;

if (!APIFY_TOKEN) {
  console.error('\n❌  APIFY_TOKEN not found in .env');
  console.error('    cp .env.example .env  →  add your token from apify.com\n');
  process.exit(1);
}

const DATA_DIR  = path.join(__dirname, 'data');
const POSTS_DIR = path.join(__dirname, 'data', 'posts');
const VIDEO_DIR = path.join(__dirname, 'data', 'videos');

// Tool paths — detected at setup, or fall back to PATH
const TOOLS = CONFIG.tools || {};
const YTDLP   = TOOLS.ytdlp   || 'yt-dlp';
const WHISPER  = TOOLS.whisper || 'whisper';
const FFMPEG   = TOOLS.ffmpeg  || 'ffmpeg';
const W_MODEL  = TOOLS.whisperModel || 'base';

// ─── File Helpers ─────────────────────────────────────────────
function ensureDirs() {
  [DATA_DIR, POSTS_DIR, VIDEO_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function loadExisting(handle) {
  const file = path.join(POSTS_DIR, `${handle}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) {}
  }
  return { handle, posts: [], lastFetched: null };
}

function saveAccount(handle, data) {
  fs.writeFileSync(path.join(POSTS_DIR, `${handle}.json`), JSON.stringify(data, null, 2));
}

function mergePosts(existing, fresh) {
  const byId = new Map(existing.map(p => [p.id, p]));
  fresh.forEach(p => {
    if (p.id) byId.set(p.id, { ...(byId.get(p.id) || {}), ...p });
  });
  return Array.from(byId.values()).sort((a, b) => (b.views || 0) - (a.views || 0));
}

// ─── Post Normalizer ──────────────────────────────────────────
function normalizePost(raw) {
  const views    = raw.videoPlayCount || raw.videoViewCount || raw.playsCount || 0;
  const likes    = raw.likesCount    || raw.likes    || 0;
  const comments = raw.commentsCount || raw.comments || 0;
  const er       = views > 0 ? Number(((likes + comments) / views * 100).toFixed(1)) : 0;
  const isVideo  = !!(views > 0 || raw.type === 'Video' || raw.type === 'Reel');
  return {
    id:            raw.id || raw.shortCode || String(Math.random()),
    caption:       (raw.caption || raw.alt || '').slice(0, 300).trim(),
    views, likes, comments,
    shares:        raw.sharesCount || 0,
    saves:         raw.savesCount  || 0,
    er,
    date:          raw.timestamp ? raw.timestamp.split('T')[0] : null,
    url:           raw.url || (raw.shortCode ? `https://www.instagram.com/p/${raw.shortCode}/` : null),
    type:          isVideo ? 'reel' : 'image',
    ownerUsername: raw.ownerUsername || raw.username || null,
    transcript:    null, // filled in by transcription step
  };
}

// ─── Apify Helpers ────────────────────────────────────────────
function apifyGet(endpoint) {
  return new Promise((resolve, reject) => {
    const sep = endpoint.includes('?') ? '&' : '?';
    https.get(`https://api.apify.com/v2${endpoint}${sep}token=${APIFY_TOKEN}`, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Parse error: ${data.slice(0, 100)}`)); }
      });
    }).on('error', reject);
  });
}

function apifyPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.apify.com',
      path:     `/v2${endpoint}?token=${APIFY_TOKEN}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Parse error: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Instagram Scraper (Apify) ────────────────────────────────
async function scrapeInstagram(handles) {
  console.log(`\n📡  Scraping ${handles.length} accounts via Apify...`);
  const runRes = await apifyPost('/acts/apify~instagram-scraper/runs', {
    directUrls:    handles.map(h => `https://www.instagram.com/${h}/`),
    resultsType:   'posts',
    resultsLimit:  CONFIG.postsPerAccount || 25,
    addParentData: false,
    expandOwners:  false,
  });

  if (!runRes.data) throw new Error('Apify run failed to start: ' + JSON.stringify(runRes));
  const { id: runId, defaultDatasetId: datasetId } = runRes.data;
  console.log(`    Run: ${runId}`);

  let status = 'RUNNING';
  while (['RUNNING','READY','ABORTING'].includes(status)) {
    await sleep(6000);
    const s = await apifyGet(`/acts/apify~instagram-scraper/runs/${runId}`);
    status = s.data.status;
    process.stdout.write(`\r    Status: ${status}   `);
  }
  console.log('');
  if (status !== 'SUCCEEDED') throw new Error(`Apify run ended: ${status}`);

  // Paginated fetch
  const items = [];
  let offset = 0;
  while (true) {
    const page = await apifyGet(`/datasets/${datasetId}/items?limit=100&offset=${offset}`);
    const batch = Array.isArray(page) ? page : (page.items || []);
    if (!batch.length) break;
    items.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
  }
  console.log(`    ✓ ${items.length} posts retrieved`);
  return items;
}

// ─── Video Download (yt-dlp) ──────────────────────────────────
function downloadVideo(url, outputPath) {
  try {
    const result = spawnSync(YTDLP, [
      url,
      '-o', outputPath,
      '--merge-output-format', 'mp4',
      '-q',
      '--no-warnings',
    ], { timeout: 60000, env: process.env });

    if (result.status === 0 && fs.existsSync(outputPath)) return true;
    return false;
  } catch(e) {
    return false;
  }
}

// ─── Transcription (Whisper) ──────────────────────────────────
function transcribeVideo(videoPath) {
  try {
    const result = spawnSync(WHISPER, [
      videoPath,
      '--model', W_MODEL,
      '--output_format', 'txt',
      '--output_dir', VIDEO_DIR,
      '--fp16', 'False',
      '--verbose', 'False',
    ], { timeout: 120000, env: process.env });

    // Whisper saves to same dir as video with .txt extension
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const txtPath  = path.join(VIDEO_DIR, `${baseName}.txt`);
    if (fs.existsSync(txtPath)) {
      const transcript = fs.readFileSync(txtPath, 'utf-8').trim();
      return transcript || null;
    }
    return null;
  } catch(e) {
    return null;
  }
}

// ─── Transcribe Posts ─────────────────────────────────────────
async function transcribePosts(posts, handle) {
  const reels = posts.filter(p => p.type === 'reel' && p.url && !p.transcript);
  if (!reels.length) return posts;

  console.log(`    🎬  Transcribing ${reels.length} reels for @${handle}...`);
  let done = 0;

  for (const post of reels) {
    const safeId   = (post.id || post.url).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    const videoPath = path.join(VIDEO_DIR, `${handle}_${safeId}.mp4`);

    process.stdout.write(`\r    [${++done}/${reels.length}] Downloading...   `);
    const downloaded = downloadVideo(post.url, videoPath);

    if (!downloaded) {
      process.stdout.write(`\r    [${done}/${reels.length}] Skipped (private/unavailable)\n`);
      continue;
    }

    process.stdout.write(`\r    [${done}/${reels.length}] Transcribing...  `);
    const transcript = transcribeVideo(videoPath);

    if (transcript) {
      // Update the post in the array
      const idx = posts.findIndex(p => p.id === post.id);
      if (idx !== -1) posts[idx].transcript = transcript;
      process.stdout.write(`\r    [${done}/${reels.length}] ✓ Transcribed (${transcript.length} chars)\n`);
    } else {
      process.stdout.write(`\r    [${done}/${reels.length}] Transcription failed\n`);
    }

    // Clean up video to save disk space (transcript is saved in JSON)
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  }

  console.log('');
  return posts;
}

// ─── Generate data/data.js ────────────────────────────────────
function generateDataJs() {
  const yourData = loadExisting(CONFIG.yourHandle);
  const compData = CONFIG.competitors.map(c => {
    const saved = loadExisting(c.handle);
    const best  = saved.posts[0] || {};
    return {
      handle:   `@${c.handle}`,
      name:     c.name || c.handle,
      posts:    saved.posts,
      bestPost: { views: best.views || 0, likes: best.likes || 0, comments: best.comments || 0, caption: best.caption || '' },
      pattern:  c.pattern || '',
    };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    yourHandle:  `@${CONFIG.yourHandle}`,
    yourName:    CONFIG.yourName || CONFIG.yourHandle,
    yourPosts:   yourData.posts,
    competitors: compData,
  };

  const js = `// Auto-generated by fetch-data.js — DO NOT EDIT
// Run "node fetch-data.js" to refresh
// Generated: ${output.generatedAt}
window.CONTENT_DATA = ${JSON.stringify(output, null, 2)};
`;

  fs.writeFileSync(path.join(DATA_DIR, 'data.js'), js);
  console.log('✓  Generated data/data.js');
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀  AI Content Coach — Fetching Data');
  console.log('─────────────────────────────────────');
  console.log(`    Your account:  @${CONFIG.yourHandle}`);
  console.log(`    Competitors:   ${CONFIG.competitors.map(c => '@' + c.handle).join(', ')}`);
  console.log(`    Posts/account: ${CONFIG.postsPerAccount || 25}`);
  ensureDirs();

  const allHandles = [CONFIG.yourHandle, ...CONFIG.competitors.map(c => c.handle)];

  let rawItems;
  try {
    rawItems = await scrapeInstagram(allHandles);
  } catch(e) {
    console.error('\n❌  Scrape failed:', e.message);
    process.exit(1);
  }

  // Group by owner
  const byHandle = {};
  allHandles.forEach(h => byHandle[h.toLowerCase()] = []);
  (Array.isArray(rawItems) ? rawItems : rawItems.items || []).forEach(raw => {
    const h = (raw.ownerUsername || raw.username || '').toLowerCase();
    if (byHandle[h] !== undefined) byHandle[h].push(normalizePost(raw));
  });

  // Save, transcribe, merge
  console.log('\n💾  Processing accounts:');
  for (const handle of allHandles) {
    const existing = loadExisting(handle);
    const fresh    = byHandle[handle.toLowerCase()] || [];
    let   merged   = mergePosts(existing.posts, fresh);

    // Transcribe new reels (skip if yt-dlp/whisper not available)
    try {
      execSync(`${YTDLP} --version`, { stdio: 'ignore' });
      execSync(`${WHISPER} --help`, { stdio: 'ignore', timeout: 5000 });
      merged = await transcribePosts(merged, handle);
    } catch(e) {
      // Tools not installed — skip transcription silently
    }

    saveAccount(handle, {
      handle,
      posts:       merged,
      lastFetched: new Date().toISOString(),
      postCount:   merged.length,
    });

    const transcribed = merged.filter(p => p.transcript).length;
    console.log(`    @${handle}: ${merged.length} posts (${fresh.length} new · ${transcribed} transcribed)`);
  }

  generateDataJs();
  console.log('\n✅  Done! Reload your dashboard to see updated data.');
  console.log('    Run: node server.js\n');
}

main().catch(e => { console.error('\n❌ Fatal:', e.message); process.exit(1); });
