#!/usr/bin/env node
/* 麦麦大亨 · 整单核价
 *
 * 用麦当劳 MCP 的 calculate-price 把游戏里那 6 款堡逐个核一遍：
 *   单点（堡 + 中薯 + 中可）算一次，同名三件套算一次，差多少就是真实优惠。
 * 套餐里到底装了什么，不是我们编的，来自 query-meal-detail 的 rounds。
 *
 * 产物：data/price-check.json —— 不含 Token，只含价格与门店，可随仓库公开。
 *
 * 用法：
 *   node tools/check-price.js            # 核价并写文件
 *   node tools/check-price.js --dry      # 只打印，不写文件
 *
 * Token 读取顺序与 pull-mcp.js 一致：
 *   1. 环境变量 MCD_MCP_TOKEN
 *   2. ~/.workbuddy/mcp.json 里的 mcd-mcp Authorization
 *   3. tools/.mcd-token（已在 .gitignore）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const ENDPOINT = 'https://mcp.mcd.cn';

/* 游戏里用到的 6 款堡，与 pull-mcp.js 的 MENU.assembly 一致 */
const BURGERS = [
  { code: '1100', name: '巨无霸' },
  { code: '1406', name: '板烧鸡腿堡' },
  { code: '1440', name: '麦辣鸡腿汉堡' },
  { code: '1450', name: '麦香鸡' },
  { code: '1600', name: '麦香鱼' },
  { code: '1120', name: '双层吉士汉堡' }
];

/* 单点对照用的两件 */
const SIDE = { fries: '4810', drink: '9900008751' };   // 中薯条 / 可乐中杯

function loadToken() {
  if (process.env.MCD_MCP_TOKEN) return process.env.MCD_MCP_TOKEN.trim();
  const tokenFile = path.join(__dirname, '.mcd-token');
  if (fs.existsSync(tokenFile)) {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (t) return t;
  }
  const cfgPath = path.join(process.env.HOME || '', '.workbuddy', 'mcp.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const srv = (cfg.mcpServers || {})['mcd-mcp'];
    const auth = srv && srv.headers && srv.headers.Authorization;
    if (auth) return String(auth).replace(/^Bearer\s+/i, '').trim();
  }
  throw new Error('找不到 MCP Token。设置环境变量 MCD_MCP_TOKEN，或写入 tools/.mcd-token');
}

const TOKEN = loadToken();

async function rpc(method, params) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + TOKEN
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} })
  });
  const text = await res.text();
  if (text.trim().startsWith('event:') || text.includes('\ndata:')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.result || j.error) return j;
      } catch (e) { /* 跳过心跳行 */ }
    }
    throw new Error('SSE 响应无法解析');
  }
  return JSON.parse(text);
}

async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  if (r.error) throw new Error(name + ' → ' + (r.error.message || JSON.stringify(r.error)));
  const sc = r.result && r.result.structuredContent;
  if (sc && sc.success === false) throw new Error(name + ' → 业务失败：' + (sc.message || '未知'));
  return sc && sc.data !== undefined ? sc.data : sc;
}

/* ⚠ 单位陷阱：两个 Tool 回的价不是一个单位
 *   query-meals.currentPrice   → 元（巨无霸 26）
 *   calculate-price.*Price     → 分（巨无霸 2600）
 * 混着用会把 ¥26 算成 ¥0.26。下面两个换算函数分开写，谁也别偷懒。 */
const fromCents = cents => Math.round(Number(cents)) / 100;   // calculate-price
const fromYuan = v => Math.round(Number(v) * 100) / 100;      // query-meals

/* 从 rounds 里抽出这档套餐实际装了什么 */
function describeRounds(rounds) {
  return (rounds || []).map(rd => {
    const picked = (rd.choices || []).filter(c => c.isDefault === 1).map(c => c.name);
    return { round: rd.name, picked: picked.length ? picked : (rd.choices || []).slice(0, 1).map(c => c.name) };
  });
}

async function main() {
  const snapshotPath = path.join(ROOT, 'data', 'snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const storeCode = snapshot.meta.store.storeCode;
  const storeName = snapshot.meta.store.storeName;
  const base = { storeCode, orderType: 1, beType: 1 };

  console.log('门店 ' + storeCode + ' · ' + storeName);
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcd-mogul-check-price', version: '1' } });

  /* 1) 拉菜单，给每款堡找同名套餐 */
  const menu = await callTool('query-meals', base);
  const meals = menu.meals || {};
  console.log('菜单 ' + Object.keys(meals).length + ' 款\n');

  /* 2) 逐款核价：单点三件 vs 同名套餐 */
  const combos = [];
  for (const b of BURGERS) {
    const comboEntry = Object.entries(meals).find(([, m]) =>
      (m.name || '').includes(b.name) && /三件套|套餐/.test(m.name || ''));

    let combo = null, rounds = [];
    if (comboEntry) {
      const [code, m] = comboEntry;
      const detail = await callTool('query-meal-detail', Object.assign({ code }, base));
      rounds = describeRounds(detail.rounds);
      const priced = await callTool('calculate-price', Object.assign({
        items: [{ productCode: code, quantity: 1 }]
      }, base));
      combo = { code, name: m.name, price: fromCents(priced.price) };
    }

    const single = await callTool('calculate-price', Object.assign({
      items: [
        { productCode: b.code, quantity: 1 },
        { productCode: SIDE.fries, quantity: 1 },
        { productCode: SIDE.drink, quantity: 1 }
      ]
    }, base));

    const row = {
      burger: { code: b.code, name: b.name },
      singles: { burger: fromCents(single.productList[0].subtotal), fries: fromCents(single.productList[1].subtotal), drink: fromCents(single.productList[2].subtotal) },
      singlePrice: fromCents(single.price),
      combo: combo ? { code: combo.code, name: combo.name, price: combo.price } : null,
      rounds,
      save: combo ? +(fromCents(single.price) - combo.price).toFixed(2) : null
    };
    combos.push(row);

    console.log('  ' + b.name.padEnd(8) +
      ' 单点 ¥' + row.singlePrice.toFixed(2).padStart(6) +
      ' | 套餐 ' + (combo ? combo.name + ' ¥' + combo.price.toFixed(2) : '无') +
      (row.save !== null ? ' | 省 ¥' + row.save.toFixed(2) : ''));
    if (row.rounds.length) {
      console.log('           套餐 = ' + row.rounds.map(r => r.picked.join('/')).join(' + '));
    }
  }

  /* 3) 单价三方差对：快照 / query-meals / calculate-price 各自说的价要一样 */
  const itemCheck = BURGERS.map(b => {
    const snap = snapshot.dishes[b.code];
    const m = meals[b.code];
    const calc = combos.find(c => c.burger.code === b.code);
    const menuPrice = m ? fromYuan(m.currentPrice) : null;      // query-meals 回的是元
    const calcPrice = calc ? calc.singles.burger : null;        // calculate-price 回的是分
    const prices = [snap && snap.price, menuPrice, calcPrice].filter(v => v !== null && v !== undefined);
    return {
      code: b.code, name: b.name,
      snapshotPrice: snap ? snap.price : null,
      menuPrice,
      calcPrice,
      ok: prices.length === 3 && prices.every(p => Math.abs(p - prices[0]) < 0.01)
    };
  });
  const okCount = itemCheck.filter(x => x.ok).length;
  console.log('\n单价三方核对（快照 / query-meals / calculate-price）：' + okCount + '/' + itemCheck.length + ' 一致');
  itemCheck.filter(x => !x.ok).forEach(x =>
    console.log('  ⚠ ' + x.name + '  ¥' + x.snapshotPrice + ' / ¥' + x.menuPrice + ' / ¥' + x.calcPrice));

  /* 4) 汇总 */
  const withCombo = combos.filter(c => c.combo);
  const out = {
    _说明: 'calculate-price 整单核价结果。单点＝堡+中薯+中可各一份，套餐＝同名三件套。价格单位元。此文件不含 Token，可随仓库公开。',
    meta: {
      source: '麦当劳 MCP（mcp.mcd.cn）',
      pulledAt: new Date().toLocaleString('sv-SE').replace('T', ' '),
      store: { storeCode, storeName },
      orderType: 1,
      beType: 1,
      tools: ['query-meals', 'query-meal-detail', 'calculate-price']
    },
    itemPriceCheck: itemCheck,
    combos,
    summary: {
      burgerCount: combos.length,
      comboCount: withCombo.length,
      avgSave: withCombo.length
        ? +(withCombo.reduce((s, c) => s + c.save, 0) / withCombo.length).toFixed(2)
        : 0,
      maxSave: withCombo.length ? Math.max(...withCombo.map(c => c.save)) : 0
    }
  };

  console.log('\n套餐 ' + withCombo.length + '/' + combos.length + ' 款，平均省 ¥' + out.summary.avgSave + '，最多省 ¥' + out.summary.maxSave);

  if (DRY) {
    console.log('\n--dry：不写文件。');
    return;
  }
  const outPath = path.join(ROOT, 'data', 'price-check.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log('已写入 ' + path.relative(ROOT, outPath));
}

main().catch(e => { console.error('✘ ' + e.message); process.exit(1); });
