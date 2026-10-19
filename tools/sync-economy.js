/* 把 data/economy.json 里的数值同步进快照和内嵌数据块。
   不需要 MCP Token，也不需要联网 —— 调数值时只跑这一个就够。

   用法: node tools/sync-economy.js [--dry]
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ECON_PATH = path.join(ROOT, 'data', 'economy.json');
const SNAP_PATH = path.join(ROOT, 'data', 'snapshot.json');
const GAME_PATH = path.join(ROOT, 'game', 'index.html');
const DRY = process.argv.includes('--dry');

const raw = JSON.parse(fs.readFileSync(ECON_PATH, 'utf8'));
const econ = {};
for (const k of Object.keys(raw)) if (!k.startsWith('_')) econ[k] = raw[k];

/* cogsRate 是算成本用的，留在快照里，别被 economy.json 覆盖掉 */
if (fs.existsSync(SNAP_PATH)) {
  const snap = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8'));
  const cogsRate = (snap.economy && snap.economy.cogsRate) != null ? snap.economy.cogsRate : 0.35;
  econ.cogsRate = cogsRate;

  snap.economy = econ;
  const json = JSON.stringify(snap, null, 2);

  if (!DRY) {
    fs.writeFileSync(SNAP_PATH, json, 'utf8');
    console.log('✔ 写入 data/snapshot.json');

    const html = fs.readFileSync(GAME_PATH, 'utf8');
    const re = /(<script id="mcd-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
    if (!re.test(html)) {
      console.error('✖ game/index.html 里没找到 #mcd-data 数据块');
      process.exit(1);
    }
    fs.writeFileSync(GAME_PATH, html.replace(re, (_, a, __, c) => a + '\n' + json + '\n' + c), 'utf8');
    console.log('✔ 已注入 game/index.html');
  } else {
    console.log('（--dry，不写文件）');
  }
} else {
  console.error('✖ 没有 data/snapshot.json，先跑 tools/pull-mcp.js');
  process.exit(1);
}

/* 写完自己核一遍，两边不一致就直接报错 */
if (!DRY) {
  const a = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8')).economy;
  const m = fs.readFileSync(GAME_PATH, 'utf8').match(/<script id="mcd-data" type="application\/json">([\s\S]*?)<\/script>/);
  const b = JSON.parse(m[1]).economy;
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log((same ? '✔' : '✖') + ' 快照与内嵌一致: ' + same);
  console.log('  ' + JSON.stringify(a));
  if (!same) process.exit(1);
}
