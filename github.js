'use strict';

// GitHub configuration is intentionally read from environment variables.
// Never commit a personal access token into this file.
const https = require('https');
const fs = require('fs');
const path = require('path');

const GITHUB_CONFIG = {
  TOKEN: process.env.GITHUB_TOKEN || '',
  OWNER: process.env.GITHUB_OWNER || 'BalzyOfficial',
  REPO: process.env.GITHUB_REPO || 'Scbuild-v6',
  API_BASE: 'https://api.github.com',
  WORKFLOW_ID: process.env.GITHUB_WORKFLOW_ID || 'build-apk.yml',
  WORKFLOW_WEB2APK_ID: process.env.GITHUB_WEB2APK_WORKFLOW_ID || 'web2apk.yml',
  WORKFLOW_REF: process.env.GITHUB_WORKFLOW_REF || 'main',
  API_TIMEOUT: 30000,
  UPLOAD_TIMEOUT: 300000,
  DOWNLOAD_TIMEOUT: 300000,
};

function request(method, url, body = null, extraHeaders = {}) {
  if (!GITHUB_CONFIG.TOKEN) {
    return Promise.reject(new Error('GITHUB_TOKEN belum diatur pada environment server.'));
  }
  const target = new URL(url.startsWith('http') ? url : `${GITHUB_CONFIG.API_BASE}${url}`);
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  const headers = {
    Authorization: `Bearer ${GITHUB_CONFIG.TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Scbuild-v6',
    ...extraHeaders,
  };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: target.hostname, path: target.pathname + target.search, method, headers, timeout: GITHUB_CONFIG.API_TIMEOUT }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw || 'Respons tidak valid dari GitHub' }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = data.message || `HTTP ${res.statusCode}`;
          const hint = res.statusCode === 401 ? ' Token GitHub tidak valid.' : res.statusCode === 403 ? ' Periksa izin token, status akun, dan batas API.' : res.statusCode === 404 ? ' Repository/workflow tidak ditemukan atau tidak dapat diakses.' : '';
          const err = new Error(`${msg}${hint} (HTTP ${res.statusCode})`);
          err.statusCode = res.statusCode; err.data = data; return reject(err);
        }
        resolve({ data, statusCode: res.statusCode, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub API request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function githubRequest(method, url, body = null, headers = {}) { return request(method, url, body, headers); }
async function createRelease(tagName, name = `Build - ${tagName}`, body = 'Automated build release') {
  const { data } = await request('POST', `/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/releases`, {
    tag_name: tagName, name, body, draft: true, prerelease: false,
  });
  return { releaseId: data.id, uploadUrl: data.upload_url, browserUrl: data.html_url, tagName: data.tag_name };
}
async function publishRelease(releaseId) {
  const { data } = await request('PATCH', `/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/releases/${releaseId}`, { draft: false });
  return data.html_url || false;
}
async function deleteRelease(releaseId) {
  await request('DELETE', `/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/releases/${releaseId}`);
  return true;
}
function uploadAsset(uploadUrl, filePath, fileName, contentType = 'application/zip') {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error(`File tidak ditemukan: ${filePath}`));
    const url = new URL(uploadUrl.replace('{?name,label}', '') + `?name=${encodeURIComponent(fileName)}`);
    const stat = fs.statSync(filePath);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', timeout: GITHUB_CONFIG.UPLOAD_TIMEOUT,
      headers: { Authorization: `Bearer ${GITHUB_CONFIG.TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': contentType, 'Content-Length': stat.size, 'User-Agent': 'Scbuild-v6' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        let data = {}; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${data.message || 'Upload asset gagal'} (HTTP ${res.statusCode})`));
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Upload ke GitHub timeout')));
    req.on('error', reject);
    fs.createReadStream(filePath).on('error', reject).pipe(req);
  });
}
async function uploadZipToRelease(filePath, fileName, tagName) {
  const release = await createRelease(tagName, `Build - ${fileName}`, `Project ZIP untuk Scbuild v6: ${fileName}`);
  try {
    await uploadAsset(release.uploadUrl, filePath, path.basename(fileName), 'application/zip');
    const publishedUrl = await publishRelease(release.releaseId);
    return { releaseId: release.releaseId, browserUrl: publishedUrl || release.browserUrl, tagName };
  } catch (error) {
    try { await deleteRelease(release.releaseId); } catch {}
    throw error;
  }
}
async function triggerWorkflow(tagName, buildType = 'apk') {
  const workflow = buildType === 'web2apk' ? GITHUB_CONFIG.WORKFLOW_WEB2APK_ID : GITHUB_CONFIG.WORKFLOW_ID;
  await request('POST', `/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    ref: GITHUB_CONFIG.WORKFLOW_REF,
    inputs: { tag: String(tagName), build_type: String(buildType || 'apk') },
  });
  await new Promise(r => setTimeout(r, 1200));
  return await getLatestRunId(workflow);
}
async function triggerWeb2ApkWorkflow(tagName) {
  await request('POST', `/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/actions/workflows/${encodeURIComponent(GITHUB_CONFIG.WORKFLOW_WEB2APK_ID)}/dispatches`, {
    ref: GITHUB_CONFIG.WORKFLOW_REF, inputs: { tag: String(tagName), build_type: 'web2apk' },
  });
  await new Promise(r => setTimeout(r, 1200));
  return await getLatestRunId(GITHUB_CONFIG.WORKFLOW_WEB2APK_ID);
}
async function getLatestRunId(workflow = GITHUB_CONFIG.WORKFLOW_ID) {
  const { data } = await request('GET', `/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=1`);
  if (!data.workflow_runs?.length) throw new Error(`Belum ada workflow run untuk ${workflow}. Pastikan file workflow ada di branch ${GITHUB_CONFIG.WORKFLOW_REF}.`);
  return data.workflow_runs[0].id;
}
async function getRunStatus(runId) {
  const { data } = await request('GET', `/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/actions/runs/${runId}`);
  return { status: data.status, conclusion: data.conclusion, html_url: data.html_url, runId: data.id };
}
async function getFailedStepLog(runId) {
  try {
    const { data: jobsData } = await request('GET', `/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/actions/runs/${runId}/jobs`);
    const failed = (jobsData.jobs || []).filter(j => j.conclusion === 'failure');
    return { stepName: failed.map(j => j.name).join(', ') || 'Build Step', errorLines: failed.map(j => `❌ Job gagal: ${j.name}`), fullLog: '' };
  } catch (e) { return { stepName: 'GitHub Actions', errorLines: [e.message], fullLog: '' }; }
}
async function getArtifacts(runId) {
  const { data } = await request('GET', `/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/actions/runs/${runId}/artifacts`);
  return (data.artifacts || []).map(a => ({ id: a.id, name: a.name, size: a.size_in_bytes, url: a.archive_download_url, createdAt: a.created_at }));
}
function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.get(target, { headers: { Authorization: `Bearer ${GITHUB_CONFIG.TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Scbuild-v6' }, timeout: GITHUB_CONFIG.DOWNLOAD_TIMEOUT }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return downloadFile(res.headers.location, destination).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error(`Download artifact gagal (HTTP ${res.statusCode})`)); }
      const out = fs.createWriteStream(destination); res.pipe(out); out.on('finish', () => out.close(resolve)); out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Download timeout'))); req.on('error', reject);
  });
}
async function downloadArtifactZip(artifactId, destination) {
  await downloadFile(`${GITHUB_CONFIG.API_BASE}/repos/${GITHUB_CONFIG.OWNER}/${GITHUB_CONFIG.REPO}/actions/artifacts/${artifactId}/zip`, destination);
  return destination;
}
async function createReleaseOnly(tagName) { return createRelease(tagName, `Build - ${tagName}`, `Automated release for ${tagName}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getGitHubConfig() {
  return { owner: GITHUB_CONFIG.OWNER, repo: GITHUB_CONFIG.REPO, workflowId: GITHUB_CONFIG.WORKFLOW_ID,
    web2apkWorkflowId: GITHUB_CONFIG.WORKFLOW_WEB2APK_ID, workflowRef: GITHUB_CONFIG.WORKFLOW_REF,
    apiBase: GITHUB_CONFIG.API_BASE, tokenPrefix: GITHUB_CONFIG.TOKEN ? `${GITHUB_CONFIG.TOKEN.slice(0, 4)}…` : 'NOT SET' };
}
async function validateToken() {
  try {
    const { data, headers } = await request('GET', '/user');
    return { valid: true, user: data.login, scopes: headers['x-oauth-scopes'] || 'fine-grained token' };
  } catch (error) { return { valid: false, error: error.message }; }
}
module.exports = { createRelease, deleteRelease, publishRelease, createReleaseOnly, uploadAsset, uploadAssetFile: uploadAsset,
  uploadZipToRelease, triggerWorkflow, triggerWeb2ApkWorkflow, getRunStatus, getLatestRunId, getFailedStepLog,
  getArtifacts, downloadArtifactZip, sleep, getGitHubConfig, validateToken, githubRequest };
