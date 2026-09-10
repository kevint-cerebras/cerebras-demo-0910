import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const provider = process.argv[2];
if (!['cerebras', 'fireworks'].includes(provider)) {
  console.error('Usage: node scripts/run-marketplace.mjs cerebras|fireworks');
  process.exit(2);
}

const environment = {
  ...process.env,
  INFERENCE_PROVIDER: provider,
  // Dash renders this browser interactively in its 75%-width preview.
  BROWSER_HEADLESS: process.env.BROWSER_HEADLESS || 'true',
};

if (provider === 'fireworks' && process.platform === 'darwin') {
  const certificates = spawnSync(
    'security',
    ['find-certificate', '-a', '-p', '/Library/Keychains/System.keychain'],
    { encoding: 'utf8' },
  );
  if (certificates.status !== 0 || !certificates.stdout.includes('BEGIN CERTIFICATE')) {
    console.error('Could not export trusted macOS certificates for Fireworks TLS.');
    process.exit(1);
  }
  const profileDirectory = path.resolve('.browser-profile');
  const certificatePath = path.join(profileDirectory, 'macos-system-ca.pem');
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(certificatePath, certificates.stdout, { mode: 0o600 });
  environment.NODE_EXTRA_CA_CERTS = certificatePath;
}

const executable = path.resolve('node_modules/.bin/tsx');
const child = spawn(executable, ['server/index.ts'], {
  env: environment,
  stdio: 'inherit',
});

// The Playwright window is the agent's target browser. Open the separate Dash
// controller automatically so the presenter has an obvious place to submit.
const dashURL = `http://localhost:${environment.PORT || '3100'}`;
if (process.platform === 'darwin' && process.env.OPEN_DASH_UI !== 'false') {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${dashURL}/api/health`);
      if (response.ok) {
        const opener = spawn('open', [dashURL], {
          detached: true,
          stdio: 'ignore',
        });
        opener.unref();
        console.log(`Dash controller opened at ${dashURL}`);
        break;
      }
    } catch {
      // The server may still be compiling or warming the browser.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (code && code !== 0)
    console.error(`Dash server exited with status ${code}. Review the error above.`);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
