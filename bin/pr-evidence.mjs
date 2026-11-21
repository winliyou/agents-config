#!/usr/bin/env node
// pr-evidence — PR 证据图工具（dsh）
//   check  : UI 类改动是否带了可用证据图（建 PR 前查本地文件，建 PR 后查远程可达）
//   shrink : 截图压缩到本地临时目录，配合 gh 的 --attach 上传（证据图不进仓库）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const EXIT_USAGE = 64;
const EXIT_MISSING = 1;
const EXIT_DEADLINK = 2;

const UI_RE = /(^|\/)(ui|res\/layout|res\/values|res\/drawable|components|pages|views|screens|theme|styles)\//;
const UI_EXT_RE = /\.(svelte|vue|tsx|jsx|css|scss|less|html|storyboard|xib|qml)$/;
const SKIP_RE = /(^|\/)(node_modules|build|dist|\.workwork|\.agents|test|tests|androidTest|\.github\/pr-evidence)\//;
const SKIP_EXT_RE = /\.(md|lock|txt|json|ya?ml)$/;

const USAGE = [
  '用法:',
  '  pr-evidence check   --body <pr-body.md> [--post] [--base <ref>] [--dir <repo>]',
  '  pr-evidence shrink  <image...> [--out <dir>]',
  '',
  '大小上限（GitHub 附件）：图片 10MB / 视频 100MB / 单次 50 个',
  '证据图用 gh 的 --attach 上传，不提交进仓库：',
  '  gh pr create --body-file body.md --attach "before.png#改前" --attach "after.png#改后"',
  '正文照常写 ![](./before.png)，gh 会把本地路径替换成上传后的附件地址。',
  '',
  'check 退出码: 0=通过  1=缺证据图  2=图片不可用  64=用法错误',
  '  --post : 建 PR 之后校验，正文必须已是远程地址（残留本地路径按未上传处理）',
  '免图声明: 正文写「pr-evidence: n/a <具体原因>」',
].join('\n');

function die(msg, code) {
  console.error('错误: ' + msg);
  process.exit(code || EXIT_USAGE);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}

function takeValue(argv, i, flag) {
  if (i + 1 >= argv.length) die(flag + ' 缺少参数值');
  return argv[i + 1];
}

// user-attachments 这类附件在未被引用前匿名访问是 404，必须带 token 才能判断真实状态。
function ghToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function imageUrls(body) {
  const md = [...body.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)].map((m) => m[1]);
  const html = [...body.matchAll(/<img[^>]+src=["']([^"']+)/gi)].map((m) => m[1]);
  return [...new Set(md.concat(html))].filter((u) => !/shields\.io|dependabot-badges|badges\//.test(u));
}

async function urlStatus(url, token) {
  const headers = {};
  if (token && /(^|\/\/)(github\.com|uploads\.github\.com)\//.test(url)) {
    headers.Authorization = 'Bearer ' + token;
  }
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', headers, signal: AbortSignal.timeout(25000) });
    try { await res.body?.cancel(); } catch {}
    return res.status;
  } catch {
    return 0;
  }
}

async function cmdCheck(argv) {
  let body = '';
  let base = '';
  let dir = '.';
  let post = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--body') { body = takeValue(argv, i, a); i++; }
    else if (a === '--base') { base = takeValue(argv, i, a); i++; }
    else if (a === '--dir') { dir = takeValue(argv, i, a); i++; }
    else if (a === '--post') { post = true; }
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else die('未知参数: ' + a);
  }
  if (!body) die('缺少 --body <PR 正文文件>');
  const bodyPath = path.resolve(dir, body);
  if (!fs.existsSync(bodyPath)) die('正文文件不存在: ' + body);
  if (!gitOk(['rev-parse', '--git-dir'], dir)) die('不是 git 仓库: ' + dir);
  const text = fs.readFileSync(bodyPath, 'utf8');

  if (!base) {
    if (gitOk(['rev-parse', '--verify', '-q', 'origin/main'], dir)) base = git(['merge-base', 'origin/main', 'HEAD'], dir);
    else if (gitOk(['rev-parse', '--verify', '-q', 'origin/master'], dir)) base = git(['merge-base', 'origin/master', 'HEAD'], dir);
    else if (gitOk(['rev-parse', '--verify', '-q', 'HEAD~1'], dir)) base = 'HEAD~1';
    else base = git(['rev-list', '--max-parents=0', 'HEAD'], dir).split('\n')[0];
  }

  let changed;
  try {
    changed = git(['diff', '--name-only', base], dir).split('\n').filter(Boolean);
  } catch (e) {
    die('计算改动失败（base=' + base + '）: ' + String(e && e.message ? e.message : e));
  }
  const ui = changed.filter((f) => !SKIP_RE.test(f) && !SKIP_EXT_RE.test(f) && (UI_RE.test(f) || UI_EXT_RE.test(f)));

  if (ui.length === 0) {
    console.log('✓ 未检测到 UI 改动（基线 ' + git(['rev-parse', '--short', base], dir) + '），无需对比图');
    console.log('  若本次确实动了界面/交互，确认路径是否被 SKIP_RE 排除，或手动补图');
    process.exit(0);
  }

  console.log('检测到 ' + ui.length + ' 个 UI 相关文件（基线 ' + git(['rev-parse', '--short', base], dir) + '）:');
  ui.slice(0, 8).forEach((f) => console.log('  - ' + f));
  if (ui.length > 8) console.log('  ... 其余 ' + (ui.length - 8) + ' 个');

  const waiver = text.match(/pr-evidence:\s*n\/?a\s*\S{6,}/i);
  if (waiver) {
    console.log('✓ 已声明免图: ' + waiver[0].replace(/pr-evidence:\s*/i, ''));
    process.exit(0);
  }

  const urls = imageUrls(text);
  if (urls.length === 0) {
    console.error('✗ 正文没有任何证据图（UI 类改动必须给 Before / After）');
    console.error('  压缩: pr-evidence shrink <截图...>');
    console.error('  上传: gh pr create --body-file <正文> --attach "图#替代文本"');
    console.error('  免图: 正文写「pr-evidence: n/a <具体原因>」');
    process.exit(EXIT_MISSING);
  }

  const bodyDir = path.dirname(bodyPath);
  const token = post ? ghToken() : '';
  const bad = [];
  let ok = 0;
  let local = 0;

  for (const u of urls) {
    if (/^https?:\/\//.test(u)) {
      const code = await urlStatus(u, token);
      if (code === 200) ok++;
      else bad.push((code === 0 ? '不可达' : String(code)) + ' ' + u);
    } else if (post) {
      bad.push('仍是本地路径（gh --attach 未生效或正文没更新）+ ' + u);
    } else {
      // 与 gh --attach 一致：相对路径先按 --body-file 所在目录解析，再回退到工作目录
      const candidates = [path.resolve(bodyDir, u), path.resolve(dir, u)];
      if (candidates.some((p) => fs.existsSync(p))) local++;
      else bad.push('本地文件不存在 ' + u);
    }
  }

  const part = [];
  if (ok) part.push(ok + ' 张远程可访问');
  if (local) part.push(local + ' 张本地待上传');
  console.log('证据图: ' + (part.join('，') || '0 张') + '，' + bad.length + ' 张异常');
  if (bad.length > 0) {
    console.error('✗ 以下图片不可用（PR 上会显示成破图）:');
    bad.forEach((b) => console.error('  ' + b));
    console.error('  远程地址 404/403: 确认附件确实被本条 PR 引用过（未引用的 attachment 匿名不可见）');
    console.error('  本地路径: 确认文件存在，且创建/编辑 PR 时用了 --attach');
    process.exit(EXIT_DEADLINK);
  }
  process.exit(0);
}

function cmdShrink(argv) {
  let out = '';
  const srcs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { out = takeValue(argv, i, a); i++; }
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('--')) die('未知参数: ' + a);
    else srcs.push(a);
  }
  if (srcs.length === 0) die('缺少截图文件');
  if (srcs.length > 50) die('一次最多 50 个附件（gh 限制）');

  const dir = path.resolve(out || '.workwork/evidence');
  fs.mkdirSync(dir, { recursive: true });
  const targets = [];
  for (const src of srcs) {
    const abs = path.resolve(src);
    if (!fs.existsSync(abs)) die('文件不存在: ' + src);
    const target = path.join(dir, path.basename(abs));
    fs.copyFileSync(abs, target);
    if (/\.(png|jpe?g)$/i.test(target)) {
      try {
        const info = execFileSync('sips', ['-g', 'pixelWidth', target], { encoding: 'utf8' });
        const w = Number((info.match(/pixelWidth:\s*(\d+)/) || [])[1] || 0);
        if (w > 540) execFileSync('sips', ['--resampleWidth', '540', target, '--out', target], { stdio: 'ignore' });
      } catch {}
    }
    targets.push(target);
  }

  console.log('已压缩到 ' + dir + '（临时目录，勿提交进仓库）:');
  targets.forEach((t) => console.log('  ' + t));
  console.log('');
  console.log('上传：创建 PR 时用 --attach，正文照常引用本地路径即可被替换：');
  console.log('  gh pr create --body-file <正文.md> \\');
  targets.forEach((t) => console.log('    --attach "' + t + '#替代文本" \\'));
  console.log('');
  console.log('已存在的 PR 追加证据：gh pr comment <PR> --body "…" --attach "…"');
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
  console.log(USAGE);
  process.exit(argv.length === 0 ? EXIT_USAGE : 0);
}
const sub = argv.shift();
if (sub === 'check') cmdCheck(argv).catch((e) => die(String(e && e.message ? e.message : e)));
else if (sub === 'shrink') cmdShrink(argv);
else if (sub === 'capture') die('capture 已移除：证据图不再进仓库，改用 pr-evidence shrink + gh --attach');
else die('未知子命令: ' + sub);
