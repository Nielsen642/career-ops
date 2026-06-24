#!/usr/bin/env node

// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { extractUrls, isCleanUrl, isAuthenticEmail, parseRoleAtCompany } from './gmail-helpers.mjs';

// Load .env
import dotenv from 'dotenv';
try { dotenv.config(); } catch { /* optional */ }

const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || 'config/profile.yml';
const CREDENTIALS_PATH = 'config/gmail-credentials.json';
const TOKEN_PATH = 'config/gmail-token.json';
const STATE_PATH = 'data/gmail-state.json';
const PIPELINE_PATH = 'data/pipeline.md';

function loadConfig() {
  if (!existsSync(PROFILE_PATH)) return null;
  try {
    const raw = yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
    return raw.gmail_ingest || null;
  } catch {
    return null;
  }
}

function loadAllPipelineUrls() {
  const urls = new Set();
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (\S+)/g)) {
      urls.add(match[1]);
    }
  }
  return urls;
}

function getMessageBody(payload) {
  if (!payload) return '';
  let body = '';
  
  if (payload.body && payload.body.data) {
    const rawData = payload.body.data;
    const base64 = rawData.replace(/-/g, '+').replace(/_/g, '/');
    body += Buffer.from(base64, 'base64').toString('utf-8');
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      body += getMessageBody(part);
    }
  }

  return body;
}

async function getAccessToken(client, token) {
  if (token.expiry_date && token.expiry_date > Date.now() + 60000) {
    return token.access_token;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to refresh access token: ${response.status} ${text}`);
  }

  const data = await response.json();
  token.access_token = data.access_token;
  if (data.expires_in) {
    token.expiry_date = Date.now() + data.expires_in * 1000;
  }
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), 'utf-8');
  return token.access_token;
}

function appendToPipeline(lines) {
  if (lines.length === 0) return;

  const skeleton = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, skeleton, 'utf-8');
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const marker = text.includes('## Pending') ? '## Pending' : '## Pendientes';
  const idx = text.indexOf(marker);

  if (idx === -1) {
    const procIdx = text.indexOf('## Processed') !== -1 ? text.indexOf('## Processed') : text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + lines.join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block = '\n' + lines.join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

async function main() {
  const config = loadConfig();
  if (!config || !config.enabled) {
    console.log("Gmail ingestion is disabled. Enable it in config/profile.yml under gmail_ingest.");
    process.exit(0);
  }

  if (!existsSync(CREDENTIALS_PATH) || !existsSync(TOKEN_PATH)) {
    console.error("Error: Gmail credentials or token configuration missing.");
    console.error(`Please ensure ${CREDENTIALS_PATH} and ${TOKEN_PATH} exist.`);
    process.exit(1);
  }

  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const tokenData = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));

  const client = creds.installed || creds.web;
  if (!client) {
    console.error("Error: invalid client credentials format in config/gmail-credentials.json.");
    process.exit(1);
  }

  mkdirSync('data', { recursive: true });
  let state = { processed_message_ids: [] };
  if (existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) || { processed_message_ids: [] };
    } catch {}
  }
  const processedIds = new Set(state.processed_message_ids || []);

  const token = await getAccessToken(client, tokenData);
  const label = config.label || 'Job Leads';
  const rawDaysBack = config.days_back ?? 7;
  const daysBack = Number(rawDaysBack);
  if (!Number.isInteger(daysBack) || daysBack <= 0) {
    throw new Error(`Invalid days_back configuration: "${rawDaysBack}". Must be a positive integer.`);
  }

  const query = `label:"${label}" newer_than:${daysBack}d`;
  console.log(`Querying Gmail: ${query}`);

  const messages = [];
  let nextPageToken = null;
  do {
    let listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`;
    if (nextPageToken) {
      listUrl += `&pageToken=${nextPageToken}`;
    }
    
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!listRes.ok) {
      const text = await listRes.text();
      throw new Error(`Gmail API List failed: ${listRes.status} ${text}`);
    }

    const listData = await listRes.json();
    if (listData.messages) {
      messages.push(...listData.messages);
    }
    nextPageToken = listData.nextPageToken;
  } while (nextPageToken);

  console.log(`Found ${messages.length} messages in label "${label}".`);

  const pipelineLines = [];
  const allPipelineUrls = loadAllPipelineUrls();

  for (const m of messages) {
    if (processedIds.has(m.id)) continue;

    const detailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`;
    const detailRes = await fetch(detailUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!detailRes.ok) {
      console.warn(`⚠️ Failed to fetch details for message ${m.id}`);
      continue;
    }

    const msg = await detailRes.json();
    const headers = msg.payload?.headers || [];
    const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';

    if (!isAuthenticEmail(headers)) {
      console.warn(`⚠️ Skipping spoofed/invalid email (DMARC fail): "${subject}" (id: ${m.id})`);
      processedIds.add(m.id);
      continue;
    }

    const body = getMessageBody(msg.payload);
    const urls = extractUrls(body);
    const cleanUrls = urls.filter(isCleanUrl);

    let addedAny = false;
    if (cleanUrls.length > 0) {
      for (const url of cleanUrls) {
        if (!allPipelineUrls.has(url)) {
          let company = 'Email-Ingest';
          let title = 'Clean Link';
          
          let hostname = '';
          let pathname = '';
          try {
            const parsedUrl = new URL(url);
            hostname = parsedUrl.hostname;
            pathname = parsedUrl.pathname;
          } catch {}

          if (hostname === 'boards.greenhouse.io' || hostname.endsWith('.greenhouse.io')) {
            const parts = pathname.split('/').filter(Boolean);
            if (parts.length > 0) company = parts[0];
          } else if (hostname === 'jobs.lever.co' || hostname.endsWith('.lever.co')) {
            const parts = pathname.split('/').filter(Boolean);
            if (parts.length > 0) company = parts[0];
          }

          pipelineLines.push(`- [ ] ${url} | ${company} | ${title}`);
          allPipelineUrls.add(url);
          addedAny = true;
        }
      }
    }

    if (!addedAny) {
      const seed = parseRoleAtCompany(subject);
      if (seed) {
        const seedUrl = `search://${encodeURIComponent(`${seed.role} at ${seed.company}`)}`;
        if (!allPipelineUrls.has(seedUrl)) {
          pipelineLines.push(`- [ ] ${seedUrl}`);
          allPipelineUrls.add(seedUrl);
        }
      }
    }

    processedIds.add(m.id);
  }

  if (pipelineLines.length > 0) {
    appendToPipeline(pipelineLines);
    console.log(`Successfully ingested ${pipelineLines.length} new entries into pipeline.`);
  } else {
    console.log("No new job leads to ingest.");
  }

  state.processed_message_ids = [...processedIds];
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
