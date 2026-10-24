import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

// Read the downloaded Google OAuth JSON without printing or copying its secret.
// Usage: node scripts/configure-google-staging.mjs <absolute-downloaded-json-path>
const source = process.argv[2]
if (!source || !isAbsolute(source)) {
  console.error('Provide the absolute path to the Google OAuth client JSON download.')
  process.exit(1)
}

let client
try {
  if ((await stat(source)).size > 64 * 1024) throw new Error('File too large')
  const downloaded = JSON.parse(await readFile(source, 'utf8'))
  client = downloaded.web
  if (!client || client.project_id !== 'smartcart-512615'
    || typeof client.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com')
    || typeof client.client_secret !== 'string' || !client.client_secret
    || !Array.isArray(client.redirect_uris)
    || !client.redirect_uris.includes('https://smartcart-api-staging.jib-inventory.workers.dev/auth/google/callback')) {
    throw new Error('OAuth client does not match SmartCart staging')
  }
} catch {
  console.error('The download is not a valid SmartCart staging Web application OAuth client JSON.')
  process.exit(1)
}

const workerDirectory = fileURLToPath(new URL('../apps/api/', import.meta.url))
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const child = spawn(process.execPath, [wrangler, 'secret', 'bulk', '--env', 'staging'], {
  cwd: workerDirectory,
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
})
child.on('error', () => {
  console.error('Could not start Wrangler. Credentials were not printed or written to the source tree.')
  process.exitCode = 1
})
child.stdin.on('error', () => { /* Child exit handles failed uploads. Never echo the input. */ })
child.stdin.end(JSON.stringify({ GOOGLE_CLIENT_ID: client.client_id, GOOGLE_CLIENT_SECRET: client.client_secret }))
child.on('close', (code) => { process.exitCode = code ?? 1 })

