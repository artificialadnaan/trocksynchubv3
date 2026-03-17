/**
 * Google Drive OAuth Setup Script
 * ================================
 *
 * One-time script to obtain a Google Drive refresh token for the archive system.
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com
 *   2. Create a project (or use existing)
 *   3. Enable "Google Drive API" under APIs & Services
 *   4. Create OAuth 2.0 credentials (Desktop app type)
 *   5. Download the credentials and set the env vars below
 *
 * Usage:
 *   GOOGLE_DRIVE_CLIENT_ID=xxx GOOGLE_DRIVE_CLIENT_SECRET=xxx npx tsx scripts/google-drive-oauth-setup.ts
 *
 * Flow:
 *   1. Script generates an authorization URL
 *   2. You open it in a browser, sign in, grant access
 *   3. Google redirects to localhost with an auth code
 *   4. Script exchanges the code for access + refresh tokens
 *   5. Prints the refresh token to save in env vars or SyncHub settings
 */

import http from 'http';
import { URL } from 'url';
import open from 'open';

const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET || '';
const REDIRECT_PORT = 3847;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing environment variables.');
  console.error('   Set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET');
  console.error('   Get these from: https://console.cloud.google.com/apis/credentials');
  process.exit(1);
}

// Scopes needed for archive file operations
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',      // Create/manage files created by this app
  'https://www.googleapis.com/auth/drive.appdata',    // App-specific data
].join(' ');

async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${err}`);
  }

  return res.json();
}

function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',      // Required to get a refresh_token
    prompt: 'consent',           // Force consent to always get refresh_token
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          GOOGLE DRIVE — OAuth Refresh Token Setup           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  const authUrl = buildAuthUrl();

  // Start a local server to catch the redirect
  return new Promise<void>((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        console.error(`\n❌ OAuth error: ${error}`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization Failed</h1><p>Check the terminal for details.</p>');
        server.close();
        resolve();
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        return;
      }

      try {
        console.log('\n🔄 Exchanging authorization code for tokens...');
        const tokens = await exchangeCodeForTokens(code);

        console.log('\n✅ SUCCESS — Tokens obtained!\n');
        console.log('═'.repeat(60));
        console.log('REFRESH TOKEN (save this — it does not expire):');
        console.log('═'.repeat(60));
        console.log(tokens.refresh_token);
        console.log('═'.repeat(60));
        console.log();
        console.log('Add to your environment:');
        console.log(`  GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
        console.log();
        console.log('Or save via SyncHub Settings UI:');
        console.log('  Settings > Storage > Google Drive > Refresh Token');
        console.log();
        console.log(`Access token (expires in ${tokens.expires_in}s):`);
        console.log(`  ${tokens.access_token.substring(0, 30)}...`);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1 style="color: #16a34a;">✅ Authorization Successful</h1>
              <p>Refresh token has been printed to the terminal.</p>
              <p>You can close this tab.</p>
            </body>
          </html>
        `);
      } catch (e: any) {
        console.error(`\n❌ Token exchange failed: ${e.message}`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Token Exchange Failed</h1><p>Check the terminal for details.</p>');
      }

      server.close();
      resolve();
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`📡 Callback server listening on http://localhost:${REDIRECT_PORT}`);
      console.log();
      console.log('Opening browser for Google authorization...');
      console.log('If the browser does not open, visit this URL manually:');
      console.log();
      console.log(`  ${authUrl}`);
      console.log();

      // Try to open the browser
      open(authUrl).catch(() => {
        console.log('(Could not auto-open browser — copy the URL above)');
      });
    });
  });
}

main().catch(console.error);
