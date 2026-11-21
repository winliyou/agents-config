#!/usr/bin/env node
// pr-evidence — PR 证据图工具（dsh）
//   check   : UI 类改动是否带了可访问的 Before/After 图
//   capture : 截图 -> 压缩 -> 入库 -> 打印 SHA 直链
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const EXIT_USAGE = 64;
const EXIT_MISSING = 1;
const EXIT_DEADLINK = 2;

const UI_RE = /(^|\/)(ui|res\/layout|res\/values|res\/drawable|components|pages|views|screens|theme|styles)\/|\.(svelte|vue|tsx|jsx|css|scss|less|html|storyboard|xib|qml)$/;
const SKIP_RE = /(^|\/)(node_modules|build|dist|\.workwork|\.agents|test|tests|androidTest|\.github\/pr-evidence)\/|\.(md|lock|txt|json|ya?ml)$/;

const USAGE = [
  '用法:',
  '  pr-evidence check   --body <pr-body.md> [--base <ref>] [--dir <repo>]',
  '  pr-evidence capture <slug> <image...> [--dir <repo>] [--message <msg>]',
  '',
  'check 退出码: 0=通过  1=缺证据图  2=图片不可访问  64=用法错误',
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

function imageUrls(body) {
  const md = [...body.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)].map((m) => m[1]);
  const html = [...body.matchAll(/<img[^>]+src=["']([^"']+)/gi)].map((m) => m[1]);
  return [...new Set(md.concat(html))].filter((u) => !/shields\.io|dependabot-badges|badges\//.test(u));
}

async function urlStatus(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(25000) });
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--body') { body = takeValue(argv, i, a); i++; }
    else if (a === '--base') { base = takeValue(argv, i, a); i++; }
    else if (a === '--dir') { dir = takeValue(argv, i, a); i++; }
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
  const ui = changed.filter((f) => !SKIP_RE.test(f) && UI_RE.test(f));

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
    console.error('  归档: pr-evidence capture <slug> <截图...>');
    console.error('  免图: 正文写「pr-evidence: n/a <具体原因>」');
    process.exit(EXIT_MISSING);
  }

  const bad = [];
  let ok = 0;
  const results = await Promise.all(urls.map(async (u) => ({ u, code: /^https?:\/\//.test(u) ? await urlStatus(u) : -1 })));
  for (const r of results) {
    if (/user-attachments|private-user-images/.test(r.u)) {
      console.log('• 跳过鉴权图床: ' + r.u.slice(0, 72));
      continue;
    }
    if (r.code === 200) ok++;
    else bad.push((r.code === -1 ? '相对路径' : String(r.code)) + ' ' + r.u);
  }

  console.log('证据图: ' + ok + ' 张可访问，' + bad.length + ' 张异常');
  if (bad.length > 0) {
    console.error('✗ 以下图片不可访问（GitHub 上会显示成破图）:');
    bad.forEach((b) => console.error('  ' + b));
    console.error('  常见原因: ref 用了分支名（删分支即 404；带斜杠的分支名直接解析失败）→ 改用 commit SHA');
    process.exit(EXIT_DEADLINK);
  }
  process.exit(0);
}

function repoSlug(dir) {
  let url = '';
  try { url = git(['remote', 'get-url', 'origin'], dir); } catch { return ''; }
  return url.replace(/.*github\.com[:/]/, '').replace(/\.git$/, '');
}

function cmdCapture(argv) {
  const slug = argv.shift();
  if (!slug || slug.startsWith('--')) die('缺少 <slug>');
  let dir = '.';
  let message = '';
  const srcs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') { dir = takeValue(argv, i, a); i++; }
    else if (a === '--message') { message = takeValue(argv, i, a); i++; }
    else if (a.startsWith('--')) die('未知参数: ' + a);
    else srcs.push(a);
  }
  if (srcs.length === 0) die('缺少截图文件');

  const destRel = '.github/pr-evidence/' + slug;
  const destAbs = path.resolve(dir, destRel);
  fs.mkdirSync(destAbs, { recursive: true });

  for (const src of srcs) {
    const abs = path.resolve(src);
    if (!fs.existsSync(abs)) die('文件不存在: ' + src);
    const target = path.join(destAbs, path.basename(abs));
    fs.copyFileSync(abs, target);
    if (/\.(png|jpe?g)$/i.test(target)) {
      try {
        const info = execFileSync('sips', ['-g', 'pixelWidth', target], { encoding: 'utf8' });
        const w = Number((info.match(/pixelWidth:\s*(\d+)/) || [])[1] || 0);
        if (w > 540) execFileSync('sips', ['--resampleWidth', '540', target, '--out', target], { stdio: 'ignore' });
      } catch {}
    }
  }

  git(['add', destRel], dir);
  const hasStaged = !gitOk(['diff', '--cached', '--quiet'], dir);
  if (hasStaged) {
    const msg = message || ('文档(证据): 采集 ' + slug + ' UI 改动截图');
    git(['commit', '-q', '-m', msg], dir);
    console.log('✓ 已提交证据图: ' + destRel);
  } else {
    console.log('• 证据图无变化，跳过提交');
  }

  const slugRepo = repoSlug(dir);
  const sha = git(['rev-parse', 'HEAD'], dir);
  if (!slugRepo) {
    console.warn('• 未配置 origin，无法生成直链；文件已提交在 ' + destRel);
    return;
  }
  console.log('SHA 直链（复制进 PR 正文）:');
  for (const f of fs.readdirSync(destAbs).sort()) {
    if (f.startsWith('.')) continue;
    console.log('https://raw.githubusercontent.com/' + slugRepo + '/' + sha + '/' + destRel + '/' + f);
  }
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
  console.log(USAGE);
  process.exit(argv.length === 0 ? EXIT_USAGE : 0);
}
const sub = argv.shift();
if (sub === 'check') cmdCheck(argv).catch((e) => die(String(e && e.message ? e.message : e)));
else if (sub === 'capture') cmdCapture(argv);
else die('未知子命令: ' + sub);
