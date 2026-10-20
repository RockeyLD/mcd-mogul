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
    const iso = new Date(Number(m[3]) * 1000).toISOString();
    return { name: m[1], email: m[2], date: iso };
  };
  return { author: person(h.author), committer: person(h.committer), message: msg };
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

  // 2) 上传 blob（内容寻址，同一内容只传一次；返回 sha 必须与本地一致）
  let done = 0;
  for (const [oid, rel] of blobs) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
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
    console.log('  ✔ ' + c.slice(0, 7) + ' → ' + cm.sha.slice(0, 7) + '  ' + meta.message.split('\n')[0].slice(0, 46));
  }

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
