import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

const devProxyTarget = process.env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:8000'
const devServerPort = Number(process.env.VITE_DEV_SERVER_PORT || '3000')

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }

          if (id.includes('element-plus')) {
            return 'element-plus'
          }

          if (id.includes('echarts')) {
            return 'echarts'
          }

          if (
            id.includes(`${resolve(__dirname, 'node_modules/vue')}`) ||
            id.includes('vue-router') ||
            id.includes('pinia')
          ) {
            return 'vue-core'
          }

          return 'vendor'
        }
      }
    }
  },
  server: {
    host: '0.0.0.0',
    port: devServerPort,
    proxy: {
      '/api': {
        target: devProxyTarget,
        changeOrigin: true
      }
    }
  }
})
