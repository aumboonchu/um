import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function offlineShell(): Plugin {
  let publicDirectory = ''
  return {
    name: 'smartcart-offline-shell',
    configResolved(config) { publicDirectory = config.publicDir },
    async writeBundle(options, bundle) {
      const template = await readFile(resolve(publicDirectory, 'sw.js'), 'utf8')
      const files = Object.keys(bundle).filter(file => file !== 'sw.js' && !file.endsWith('.map')).sort()
      const revision = createHash('sha256').update(template).update(files.join('\n')).digest('hex').slice(0, 12)
      const precache = ['./', ...files.map(file => `./${file}`), './manifest.webmanifest', './licenses/IBM-Plex-Sans-Thai-OFL.txt']
      const source = template.replace('smartcart-shell-v4', `smartcart-shell-v4-${revision}`).replace("const APP_SHELL = ['./']", `const APP_SHELL = ${JSON.stringify(precache)}`)
      await writeFile(resolve(options.dir ?? 'dist', 'sw.js'), source)
    },
  }
}

export default defineConfig(({ mode }) => {
  const repositoryBase = loadEnv(mode, '.', '').VITE_BASE_PATH ?? '/'

  return {
    base: repositoryBase.endsWith('/') ? repositoryBase : `${repositoryBase}/`,
    plugins: [react(), offlineShell()],
    build: { assetsInlineLimit: 0 },
  }
})
