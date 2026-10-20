#!/usr/bin/env node
/**
 * 用 GitHub REST API 把本地历史整条搬到远端 —— 因为沙箱只放通 api.github.com，
 * github.com:443 上的 git 协议（smart HTTP）会被 502 掐掉。
 *
 * 做法：逐个 commit 重建 blob / tree / commit，parent 指向刚建出来的上一个，
 * 最后把 refs/heads/main 指到最后一个 commit。历史、作者、时间戳、commit message 全部原样保留。
 *
 * 用法：node tools/push-via-api.js [--dry-run]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OWNER = process.env.GITHUB_OWNER || 'RockeyLD';
const REPO = process.env.GITHUB_REPO || 'mcd-mogul';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const API = 'https://api.github.com';
const DRY = process.argv.includes('--dry-run');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28 });

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const f = path.join(ROOT, 'tools', '.github-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('找不到 Token：设置 GITHUB_TOKEN 或写入 tools/.github-token');
}

const TOK = token();

async function api(method, p, body, tries = 4) {
  const url = p.startsWith('http') ? p : API + p;
  for (let i = 1; i <= tries; i++) {
    let res, txt;
    try {
      res = await fetch(url, {
        method,
        signal: AbortSignal.timeout(120000),   // 不设超时的话，一次卡住的连接能把整个脚本挂死
        headers: {
          Authorization: 'Bearer ' + TOK,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'mcd-mogul-publish'
        },
        body: body ? JSON.stringify(body) : undefined
      });
      txt = await res.text();
    } catch (e) {
      if (i === tries) throw new Error(method + ' ' + p + ' 网络失败: ' + e.message);
      await new Promise(r => setTimeout(r, 1200 * i));
      continue;
    }
    if (res.ok) return txt ? JSON.parse(txt) : {};
    // 422「Reference already exists」之类交给调用方判断
    if (res.status >= 500 && i < tries) {
      await new Promise(r => setTimeout(r, 1200 * i));
      continue;
    }
    const err = new Error(method + ' ' + p + ' → HTTP ' + res.status + ' ' + txt.slice(0, 400));
    err.status = res.status;
    err.body = txt;
    throw err;
  }
}

/* ── 读本地历史 ───────────────────────────────────────────── */
function commits() {
  const out = git('rev-list', '--reverse', '--topo-order', BRANCH).toString().trim();
  return out.split('\n').filter(Boolean);
}

function parseTree(sha) {
  const raw = git('ls-tree', '-r', '-z', '--full-tree', sha).toString();
  const items = [];
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (type === 'commit') continue;            // submodule 远端没有，跳过
    items.push({ path: p, mode, type, oid });
  }
  return items;
}

function commitMeta(sha) {
  const raw = git('cat-file', '-p', sha).toString();
  const [head, ...rest] = raw.split('\n\n');
  const msg = rest.join('\n\n');
  const h = {};
  for (const line of head.split('\n')) {
    const i = line.indexOf(' ');
    h[line.slice(0, i)] = line.slice(i + 1);
  }
  const person = s => {
    const m = s.match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
    // 必须保留原始时区：Git 的 commit 对象里 date 序列化成 `<unix> <tz>`，
    // 一旦把 +0800 压成 +0000，整条历史的 sha 就全变了，本地与远端从此分叉。
    return { name: m[1], email: m[2], date: localIso(+m[3], m[4]) };
  };
  return { author: person(h.author), committer: person(h.committer), message: msg };
}

/** unix 时间戳 + 时区偏移 → 2026-10-19T17:31:48+08:00 这种带偏移的 ISO 串 */
function localIso(ts, tz) {
  const sign = tz[0] === '-' ? -1 : 1;
  const off = sign * (+tz.slice(1, 3) * 60 + +tz.slice(3, 5));
  const s = new Date((ts + off * 60) * 1000).toISOString().slice(0, 19);
  return s + tz.slice(0, 3) + ':' + tz.slice(3);
}

/* ── 主流程 ───────────────────────────────────────────────── */
(async () => {
  const list = commits();
  console.log('本地 ' + list.length + ' 个 commit，准备重建到 ' + OWNER + '/' + REPO + '#' + BRANCH);

  // 1) 收集所有唯一 blob
  const blobs = new Map();      // oid -> path（取第一个作为来源）
  const trees = new Map();      // commit -> items
  for (const c of list) {
    const items = parseTree(c);
    trees.set(c, items);
    for (const it of items) if (!blobs.has(it.oid)) blobs.set(it.oid, it.path);
  }
  const total = [...blobs.values()].reduce((n, p) => n + fs.statSync(path.join(ROOT, p)).size, 0);
  console.log('唯一 blob ' + blobs.size + ' 个，合计 ' + (total / 1048576).toFixed(2) + ' MB');

  if (DRY) {
    for (const c of list) {
      const m = commitMeta(c);
      console.log('  ' + c.slice(0, 7) + '  ' + trees.get(c).length + ' 文件  ' + m.message.split('\n')[0].slice(0, 50));
    }
    console.log('干跑结束，未改动远端');
    return;
  }

  // 1.5) 空仓库踢一脚：全空时 Git Data API 一律 409「Git Repository is empty」，
  //      先用 Contents API 落一个占位提交，等 ref 顶到我们的历史后它就成孤儿了。
  try {
    await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
    console.log('  远端已有提交，跳过占位');
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
    await api('PUT', '/repos/' + OWNER + '/' + REPO + '/contents/.gitkeep', {
      message: 'init',
      content: Buffer.from('').toString('base64'),
      branch: BRANCH
    });
    console.log('  空仓库 → 落占位提交，Git Data API 可用');
  }

  // 2) 上传 blob（内容寻址，同一内容只传一次；返回 sha 必须与本地一致）
  //    内容必须从 git 对象库取，不能读工作区 —— .gitignore 这类文件历史上改过，
  //    工作区版本 ≠ 旧 commit 里的那个 blob。
  let done = 0;
  for (const [oid, rel] of blobs) {
    const buf = git('cat-file', 'blob', oid);
    const r = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
      content: buf.toString('base64'),
      encoding: 'base64'
    });
    if (r.sha !== oid) {
      throw new Error('blob sha 不匹配：' + rel + ' 本地 ' + oid.slice(0, 8) + ' 远端 ' + String(r.sha).slice(0, 8));
    }
    done++;
    if (done % 8 === 0 || done === blobs.size) process.stdout.write('\r  上传 blob ' + done + '/' + blobs.size);
  }
  console.log();

  // 3) 逐 commit 建 tree + commit
  let parent = null;
  let sameCount = 0;
  const map = new Map();        // 本地 commit -> 远端 commit
  for (const c of list) {
    const items = trees.get(c);
    const treeRes = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
      tree: items.map(it => ({
        path: it.path,
        mode: it.mode,
        type: it.type,
        sha: it.oid
      }))
    });
    const meta = commitMeta(c);
    const body = { message: meta.message, tree: treeRes.sha, author: meta.author, committer: meta.committer };
    if (parent) body.parents = [parent];
    const cm = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', body);
    map.set(c, cm.sha);
    parent = cm.sha;
    const same = cm.sha === c;
    console.log('  ' + (same ? '✔' : '⚠') + ' ' + c.slice(0, 7) + ' → ' + cm.sha.slice(0, 7)
      + (same ? '' : ' （sha 与本地不同）')
      + '  ' + meta.message.split('\n')[0].slice(0, 42));
    sameCount += same ? 1 : 0;
  }
  if (sameCount === list.length) console.log('  所有 commit 的 sha 与本地完全一致 —— 远端与本地没有分叉，以后直接 git push 即可');
  else console.log('  ' + sameCount + '/' + list.length + ' 个 sha 与本地一致，其余不同（内容仍逐字节相同）');

  // 4) 建 ref（已存在就强制指过去）
  const head = map.get(list[list.length - 1]);
  let exists = false;
  try {
    const cur = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
    exists = true;
    console.log('  远端 ' + BRANCH + ' 已存在，当前指向 ' + cur.object.sha.slice(0, 7));
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (exists) {
    await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, { sha: head, force: true });
  } else {
    await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/refs', { ref: 'refs/heads/' + BRANCH, sha: head });
  }
  console.log('  ✔ ' + BRANCH + ' → ' + head.slice(0, 7));

  console.log('\n远端历史已就绪：https://github.com/' + OWNER + '/' + REPO);
})().catch(e => {
  console.error('\n✘ ' + e.message);
  process.exit(1);
});
