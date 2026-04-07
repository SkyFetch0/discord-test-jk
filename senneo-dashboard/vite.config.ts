import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../senneo/packages/api/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/auth':     'http://localhost:4000',
      '/live':     'http://localhost:4000',
      '/health':   'http://localhost:4000',
      '/messages': 'http://localhost:4000',
      '/accounts': 'http://localhost:4000',
      '/db':       'http://localhost:4000',
      '/alerts':   'http://localhost:4000',
      '/metrics':  'http://localhost:4000',
      '/errors':   'http://localhost:4000',
      '/guilds':   'http://localhost:4000',
      '/archive':  'http://localhost:4000',
      '/proxies':  'http://localhost:4000',
      '/system-stats': 'http://localhost:4000',
    },
  },
})
