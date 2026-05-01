/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */
/**
 * OZON 上货 SaaS 后端服务入口
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const { migrate } = require('./db');
const routes = require('./routes');
const { startWorkerLoop } = require('./worker');

const PORT = process.env.PORT || 3001;

async function main() {
  migrate();

  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
  app.use(express.json({ limit: '10mb' }));

  // 健康检查
  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // 前端静态文件（本地开发时直接从 server 提供 website）
  app.use(express.static(path.join(__dirname, '..', 'website')));

  // API 路由
  app.use('/api/v1', routes);

  // SPA fallback
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(__dirname, '..', 'website', 'index.html'));
    }
  });

  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  OZON 上货 SaaS 后端`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  API: http://localhost:${PORT}/api/v1`);
    console.log(`  前端: http://localhost:${PORT}`);
    console.log(`========================================\n`);
  });

  startWorkerLoop();
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
