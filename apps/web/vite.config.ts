import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const repositoryBase = loadEnv(mode, '.', '').VITE_BASE_PATH ?? '/'

  return {
    base: repositoryBase.endsWith('/') ? repositoryBase : `${repositoryBase}/`,
    plugins: [react()],
  }
})

