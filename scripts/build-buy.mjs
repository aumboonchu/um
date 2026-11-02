import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { readFileSync } from 'node:fs'

const root = fileURLToPath(new URL('../', import.meta.url))
const web = resolve(root, 'apps/web')
const require = createRequire(resolve(web, 'package.json'))
const vite = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js')
const result = spawnSync(process.execPath, [vite, 'build', '--base', '/buy/', '--outDir', 'dist-buy'], {
  cwd: web, stdio: 'inherit', env: { ...process.env,
    VITE_API_ORIGIN: 'https://smartcart-api-staging.jib-inventory.workers.dev' },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const html = readFileSync(resolve(web, 'dist-buy/index.html'), 'utf8')
if (!html.includes('/buy/assets/') || html.includes('/um/assets/')) throw new Error('Incorrect /buy/ asset base')
const manifest = JSON.parse(readFileSync(resolve(web, 'dist-buy/manifest.webmanifest'), 'utf8'))
if (manifest.start_url !== './' || manifest.scope !== './' || manifest.display !== 'standalone') throw new Error('Incorrect PWA scope')
console.log('SmartCart /buy/ build ready; existing GitHub Pages artifact unchanged.')
