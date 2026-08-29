import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.static(join(__dirname, 'public')));

function handler(mod) {
  return (req, res) => mod.default(req, res);
}

const routes = [
  ['/api/index',       './api/index.js'],
  ['/api/agent',       './api/agent.js'],
  ['/api/seed',        './api/seed.js'],
  ['/api/reset',       './api/reset.js'],
  ['/api/status',      './api/status.js'],
  ['/api/verify',      './api/verify.js'],
  ['/api/v1/chat',     './api/v1/chat.js'],
  ['/api/v1/tools/list','./api/v1/tools/list.js'],
];

for (const [route, modPath] of routes) {
  let cached = null;
  app.all(route, async (req, res) => {
    try {
      if (!cached) cached = await import(modPath);
      handler(cached)(req, res);
    } catch (err) {
      console.error(`[server] ${route} error:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });
}

app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
