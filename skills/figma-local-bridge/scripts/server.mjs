// Figma Local Bridge —— 通用本地服务（bun）
// ws://127.0.0.1:8787 给桌面插件连；HTTP 端点：
//   POST /eval {code}                      → 插件沙盒执行任意 Plugin API 代码
//   POST /save-version {title,description}  → 打版本历史（插件内置命令）
//   GET  /status                            → 查连接态
import { writeFileSync, unlinkSync } from 'node:fs';

const PENDING = new Map();
let pluginWs = null;
let pluginInfo = null;
let seq = 0;
const startedAt = Date.now();

function forward(payload, timeoutMs) {
  if (!pluginWs || pluginWs.readyState !== 1) {
    return Promise.resolve({ ok: false, error: 'plugin not connected' });
  }
  const id = 'e' + (++seq);
  const p = new Promise((resolve) => {
    PENDING.set(id, resolve);
    setTimeout(() => {
      if (PENDING.has(id)) {
        PENDING.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }
    }, timeoutMs || 60000);
  });
  pluginWs.send(JSON.stringify({ ...payload, id }));
  return p;
}

const pidUrl = new URL('./server.pid', import.meta.url);
function cleanPid() {
  try { unlinkSync(pidUrl); } catch {}
}
process.on('exit', cleanPid);
process.on('SIGINT', () => { cleanPid(); process.exit(0); });
process.on('SIGTERM', () => { cleanPid(); process.exit(0); });

Bun.serve({
  port: Number(process.env.BRIDGE_PORT) || 8787,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.method === 'POST' && (url.pathname === '/eval' || url.pathname === '/save-version' || url.pathname === '/export')) {
      const body = await req.json().catch(() => ({}));
      let payload;
      if (url.pathname === '/eval') {
        payload = { type: 'eval', code: body.code };
      } else if (url.pathname === '/save-version') {
        payload = { type: 'save-version', title: body.title, description: body.description };
      } else if (url.pathname === '/export') {
        payload = { type: 'export', nodeId: body.nodeId, format: body.format, scale: body.scale };
      }
      const result = await forward(payload, body.timeoutMs);
      const status = result.ok ? 200 : (result.error === 'plugin not connected' ? 503 : 500);
      return Response.json(result, { status });
    }
    if (url.pathname === '/status') {
      return Response.json({
        pluginConnected: !!(pluginWs && pluginWs.readyState === 1),
        pluginFile: pluginInfo ? pluginInfo.file : null,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        pending: PENDING.size
      });
    }
    if (server.upgrade(req)) return;
    return new Response('figma local bridge server');
  },
  websocket: {
    open(ws) { pluginWs = ws; },
    message(ws, message) {
      let data;
      try { data = JSON.parse(message.toString()); } catch { return; }
      if (data.type === 'hello') {
        pluginInfo = data;
        return;
      }
      if (data.type === 'result' && PENDING.has(data.id)) {
        const r = PENDING.get(data.id);
        PENDING.delete(data.id);
        r(data);
      }
    },
    close(ws) {
      if (pluginWs === ws) {
        pluginWs = null;
        pluginInfo = null;
      }
    }
  }
});
writeFileSync(pidUrl, String(process.pid));
console.log('bridge listening on http://127.0.0.1:' + (Number(process.env.BRIDGE_PORT) || 8787));
