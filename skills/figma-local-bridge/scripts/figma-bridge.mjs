#!/usr/bin/env node
/**
 * Figma Bridge CLI — 通用 Figma 本地桥自动化控制台
 * 支持在任何项目中一键管理 Bridge 守护进程、执行 Plugin API 脚本、打版本历史。
 *
 * 用法：
 *   figma-bridge status               # 查看服务与桌面插件连接态
 *   figma-bridge start                # 后台启动 Bridge 服务
 *   figma-bridge stop                 # 停止 Bridge 服务
 *   figma-bridge restart              # 重启 Bridge 服务
 *   figma-bridge eval "<code>"        # 在 Figma 中执行代码（服务未起自动拉起）
 *   figma-bridge eval -f <file.js>    # 执行指定 JS 脚本文件
 *   figma-bridge save-version -t "标题" -d "描述"
 *   figma-bridge verify               # 运行协议闭环自检
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(SCRIPTS_DIR, '..');
const PLUGIN_DIR = join(SKILL_DIR, 'plugin');
const PID_FILE = join(SCRIPTS_DIR, 'server.pid');
const PORT = Number(process.env.BRIDGE_PORT) || 8787;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function getStatus() {
  try {
    const res = await fetch(`${BASE_URL}/status`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return await res.json();
  } catch (e) {}
  return null;
}

async function isServerRunning() {
  const status = await getStatus();
  return status !== null;
}

async function startServer() {
  if (await isServerRunning()) {
    console.log(`✓ Bridge 服务已在运行中 (${BASE_URL})`);
    return true;
  }

  const child = spawn('bun', [join(SCRIPTS_DIR, 'server.mjs')], {
    env: { ...process.env, BRIDGE_PORT: String(PORT) },
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  // 等待启动就绪
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isServerRunning()) {
      console.log(`✓ Bridge 服务已后台启动 (${BASE_URL}) [PID: ${child.pid}]`);
      return true;
    }
  }
  console.error(`✗ Bridge 服务启动超时，请确认本机已安装 bun 并检查端口 ${PORT}`);
  return false;
}

async function stopServer() {
  const pids = [];
  if (existsSync(PID_FILE)) {
    try {
      const p = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (p) pids.push(p);
    } catch (e) {}
  }

  // 通过 lsof 自动发现可能残留的端口占用进程
  try {
    const portPids = execSync(`lsof -ti :${PORT}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n').map((x) => parseInt(x.trim(), 10)).filter(Boolean);
    for (const p of portPids) if (!pids.includes(p)) pids.push(p);
  } catch (e) {}

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`✓ 已停止 Bridge 服务进程 (PID: ${pid})`);
    } catch (e) {
      if (e.code !== 'ESRCH') console.warn(`kill ${pid} error:`, e.message);
    }
  }

  try { unlinkSync(PID_FILE); } catch (e) {}
  await new Promise((r) => setTimeout(r, 300));

  if (await isServerRunning()) {
    console.warn('⚠️ 端口仍有响应，可能存在其它外部进程占用。');
  } else {
    console.log('✓ Bridge 服务已完全停止');
  }
}

async function ensureReady() {
  if (!(await isServerRunning())) {
    console.log('ℹ️ 检测到 Bridge 服务未启动，正在自动启动服务...');
    const ok = await startServer();
    if (!ok) process.exit(1);
  }
  const st = await getStatus();
  if (!st || !st.pluginConnected) {
    console.warn('\n⚠️  Bridge 服务已就绪，但 Figma 桌面插件尚未连接！');
    console.warn('   请在 Figma 桌面端菜单中：Plugins → Development → 运行「Figma Local Bridge」');
    console.warn(`   插件路径：${join(PLUGIN_DIR, 'manifest.json')}\n`);
  }
  return st;
}

async function runEval(code) {
  await ensureReady();
  try {
    const res = await fetch(`${BASE_URL}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const result = await res.json();
    if (result.ok) {
      console.log(typeof result.result === 'object' ? JSON.stringify(result.result, null, 2) : result.result);
    } else {
      console.error('✗ 执行失败:', result.error);
      process.exit(1);
    }
  } catch (e) {
    console.error('✗ 请求异常:', e.message);
    process.exit(1);
  }
}

async function runSaveVersion(title, description) {
  await ensureReady();
  try {
    const res = await fetch(`${BASE_URL}/save-version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description: description || '' })
    });
    const result = await res.json();
    if (result.ok) {
      console.log(`✓ 版本里程碑已保存: ${title}`);
    } else {
      console.error('✗ 保存失败:', result.error);
      process.exit(1);
    }
  } catch (e) {
    console.error('✗ 请求异常:', e.message);
    process.exit(1);
  }
}

async function runExport(nodeId, outPath, format, scale) {
  await ensureReady();
  try {
    const res = await fetch(`${BASE_URL}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId, format: format || 'PNG', scale: Number(scale) || 2 })
    });
    const result = await res.json();
    if (result.ok && result.result && result.result.base64) {
      const buf = Buffer.from(result.result.base64, 'base64');
      const targetPath = outPath || `${result.result.name.replace(/[\/\\:*?"<>|]/g, '_')}_${result.result.nodeId.replace(':', '_')}.${(format || 'png').toLowerCase()}`;
      writeFileSync(targetPath, buf);
      console.log(`✓ 节点已导出: ${targetPath} (${buf.length} bytes, 节点: ${result.result.name} [${result.result.nodeId}])`);
    } else {
      console.error('✗ 导出失败:', result.error || '未返回图像数据');
      process.exit(1);
    }
  } catch (e) {
    console.error('✗ 请求异常:', e.message);
    process.exit(1);
  }
}

async function runAudit(targetScreen) {
  await ensureReady();
  const auditCode = `
    const screens = figma.currentPage.children.filter(n => n.type === 'FRAME' && n.width >= 320 && n.height >= 480);
    const violations = [];
    const targetFilter = ${JSON.stringify(targetScreen || '')};
    for (const screen of screens) {
      if (targetFilter && !screen.name.includes(targetFilter) && screen.id !== targetFilter) continue;
      const children = screen.children || [];
      
      let maxCardIdx = -1;
      let minNavIdx = 9999;
      let navNode = null;
      let cardNode = null;
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c.width >= screen.width * 0.9 && c.height >= screen.height * 0.25) {
          maxCardIdx = Math.max(maxCardIdx, i);
          cardNode = c;
        }
        if (/导航|Top|Back|返回|Header|操作/i.test(c.name) && c.y <= 120) {
          if (i < minNavIdx) {
            minNavIdx = i;
            navNode = c;
          }
        }
      }
      if (navNode && cardNode && minNavIdx < maxCardIdx) {
        violations.push({
          type: 'z-order-occlusion',
          screen: screen.name,
          hint: '浮动导航栏 [' + navNode.name + '] 索引(' + minNavIdx + ')小于大图卡片 [' + cardNode.name + '] (' + maxCardIdx + ')，会被大图遮挡'
        });
      }

      const looseBrand = children.filter(c => /logo|brand|商标/i.test(c.name) && c.type !== 'FRAME');
      if (looseBrand.length >= 2) {
        violations.push({
          type: 'loose-brand-elements',
          screen: screen.name,
          hint: '屏幕顶层存在散落品牌元素，必须封装在语义 Frame (如 BrandLogo) 内部'
        });
      }

      const stickyBottom = children.find(c => /TabBar|底部导航|Dock|评论条|InputBar/i.test(c.name) && (c.y + c.height) >= screen.height - 10);
      if (stickyBottom) {
        const scrollableCards = children.filter(c => c !== stickyBottom && (c.y + c.height) > stickyBottom.y);
        for (const card of scrollableCards) {
          if (card.y < stickyBottom.y && (card.y + card.height) > stickyBottom.y + 10) {
            violations.push({
              type: 'sticky-bottom-truncation',
              screen: screen.name,
              item: card.name,
              hint: '元素 [' + card.name + '] 延伸穿透进吸底栏 [' + stickyBottom.name + ']，未预留安全避让留白'
            });
          }
        }
      }
    }
    return {
      pass: violations.length === 0,
      totalScreens: screens.length,
      violations: violations
    };
  `;
  try {
    const res = await fetch(`${BASE_URL}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: auditCode })
    });
    const result = await res.json();
    if (result.ok && result.result) {
      console.log('=== Figma 设计工程基准巡检结果 ===');
      console.log(`检查画板总数: ${result.result.totalScreens}`);
      console.log(`巡检结论:     ${result.result.pass ? '🟢 全部通过 (0 违规)' : '🔴 发现违规项'}`);
      if (!result.result.pass) {
        console.log('\n违规明细与修复指引:');
        for (const v of result.result.violations) {
          console.log(`- [${v.type}] 画板: ${v.screen}`);
          console.log(`  指引: ${v.hint}`);
        }
      }
      console.log('=================================');
    } else {
      console.error('✗ 巡检执行失败:', result.error);
    }
  } catch (e) {
    console.error('✗ 请求异常:', e.message);
  }
}

// 主命令分发
const args = process.argv.slice(2);
const cmd = args[0] || 'status';

switch (cmd) {
  case 'status': {
    const st = await getStatus();
    console.log('=== Figma Local Bridge 运行状态 ===');
    console.log(`服务地址:     ${BASE_URL}`);
    console.log(`服务状态:     ${st ? '🟢 运行中' : '🔴 未运行'}`);
    if (st) {
      console.log(`运行时长:     ${st.uptimeSec}s`);
      console.log(`桌面插件:     ${st.pluginConnected ? '🟢 已连接' : '🔴 未连接 (请在 Figma 运行插件)'}`);
      if (st.pluginFile) console.log(`当前打开文件: ${st.pluginFile}`);
      console.log(`队列请求:     ${st.pending}`);
    }
    console.log('===================================');
    break;
  }

  case 'start':
  case 'daemon':
    await startServer();
    break;

  case 'stop':
    await stopServer();
    break;

  case 'restart':
    await stopServer();
    await startServer();
    break;

  case 'eval': {
    let code = '';
    if (args[1] === '-f' || args[1] === '--file') {
      const filePath = args[2];
      if (!filePath || !existsSync(filePath)) {
        console.error('✗ 脚本文件不存在:', filePath);
        process.exit(1);
      }
      code = readFileSync(filePath, 'utf8');
    } else {
      code = args.slice(1).join(' ');
    }
    if (!code.trim()) {
      console.error('用法: figma-bridge eval "figma.root.name" 或 figma-bridge eval -f script.js');
      process.exit(1);
    }
    await runEval(code);
    break;
  }

  case 'save-version': {
    let title = '';
    let desc = '';
    for (let i = 1; i < args.length; i++) {
      if ((args[i] === '-t' || args[i] === '--title') && args[i + 1]) title = args[++i];
      else if ((args[i] === '-d' || args[i] === '--desc' || args[i] === '--description') && args[i + 1]) desc = args[++i];
    }
    if (!title) {
      console.error('用法: figma-bridge save-version -t "版本标题" [-d "更新描述"]');
      process.exit(1);
    }
    await runSaveVersion(title, desc);
    break;
  }

  case 'export': {
    const nodeId = args[1];
    let outPath = '';
    let format = 'PNG';
    let scale = 2;
    for (let i = 2; i < args.length; i++) {
      if ((args[i] === '-o' || args[i] === '--out') && args[i + 1]) outPath = args[++i];
      else if ((args[i] === '--format') && args[i + 1]) format = args[++i];
      else if ((args[i] === '--scale') && args[i + 1]) scale = Number(args[++i]) || 2;
    }
    await runExport(nodeId, outPath, format, scale);
    break;
  }

  case 'audit': {
    const target = args[1] || '';
    await runAudit(target);
    break;
  }

  case 'verify': {
    const verifyScript = join(SCRIPTS_DIR, 'verify-figma-bridge.mjs');
    const child = spawn('node', [verifyScript], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
    break;
  }

  default:
    console.log(`未知命令: ${cmd}
支持命令:
  status                   查看 Bridge 状态
  start                    后台启动服务
  stop                     停止服务
  restart                  重启服务
  eval <code>              在 Figma 执行代码（未起服务自动拉起）
  save-version             打版本历史 (-t "标题" -d "描述")
  export <nodeId> [-o ...] 导出指定节点为高清图片
  audit [screen]           运行排版/Z轴/吸底基准巡检
  verify                   运行自动化冒烟自检`);
    process.exit(1);
}
