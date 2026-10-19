#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   麦麦大亨 · 数据层
   直接从麦当劳 MCP 拉真实数据，生成 data/snapshot.json，并把快照
   注入 game/index.html 的内嵌数据块（保证单文件可分发、离线能玩）。

   Token 来源优先级：
     1. 环境变量 MCD_MCP_TOKEN
     2. ~/.workbuddy/mcp.json 里的 mcd-mcp Authorization
     3. tools/.mcd-token（本地私有文件，已在 .gitignore）

   用法：
     node tools/pull-mcp.js                  # 用默认门店
     node tools/pull-mcp.js --store 1421136  # 指定门店
     node tools/pull-mcp.js --dry            # 只打印不写文件
   ══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = path.join(ROOT, 'data', 'snapshot.json');
const GAME_PATH = path.join(ROOT, 'game', 'index.html');

/* ── 参数 ── */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DRY = argv.includes('--dry');
const STORE = arg('store', '1421136');

/* ── Token ── */
function loadToken() {
  if (process.env.MCD_MCP_TOKEN) return process.env.MCD_MCP_TOKEN.trim();
  const tokenFile = path.join(__dirname, '.mcd-token');
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
  const cfgPath = path.join(process.env.HOME || '', '.workbuddy', 'mcp.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const s = cfg.mcpServers && cfg.mcpServers['mcd-mcp'];
      if (s && s.headers && s.headers.Authorization) {
        return String(s.headers.Authorization).replace(/^Bearer\s+/i, '').trim();
      }
    } catch (e) { /* ignore */ }
  }
  throw new Error('找不到 MCP Token。请设置环境变量 MCD_MCP_TOKEN，或写入 tools/.mcd-token');
}

const TOKEN = loadToken();

/* ── JSON-RPC ── */
async function rpc(method, params) {
  const res = await fetch('https://mcp.mcd.cn', {
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
      } catch (e) { /* ignore */ }
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

/* ── 选品：三座工位 ── */
/* 只挑真实单品（非套餐、非周边），价格与名称全部来自 query-meals */
const MENU = {
  fries: [
    { code: '4810',   nutritionName: '中薯条' },      // 薯条 ¥14.5
    { code: '514782', nutritionName: '脆脆薯条' },    // 脆脆薯条 ¥16
    { code: '1401',   nutritionName: '麦乐鸡5块' },   // 麦乐鸡 ¥14.5
    { code: '1700',   nutritionName: '麦辣鸡翅-2块' } // 麦辣鸡翅 ¥14.5
  ],
  drink: [
    { code: '9900008751', nutritionName: '可乐中杯' },        // 可乐 ¥9.5
    { code: '3010',       nutritionName: '雪碧中杯' },        // 雪碧 ¥9.5
    { code: '2430',       nutritionName: '【美汁源】“黄金橙橙”' } // ¥13
  ],
  assembly: [
    { code: '1100', nutritionName: '巨无霸' },       // ¥26
    { code: '1406', nutritionName: '板烧鸡腿堡' },   // ¥24
    { code: '1440', nutritionName: '麦辣鸡腿汉堡' }, // ¥23
    { code: '1450', nutritionName: '麦香鸡' },       // ¥17
    { code: '1600', nutritionName: '麦香鱼' },       // ¥22.5
    { code: '1120', nutritionName: '双层吉士汉堡' }  // ¥23
  ]
};

/* 原料成本率：MCP 不提供成本，按售价 35% 估算（已在 README 说明为游戏数值，非官方数据） */
const COGS_RATE = 0.35;

/* ── 解析营养表 ──
   返回格式是 "  {productName,nutritionDescription,energyKj,...}:" 的竖排表格 */
function parseNutrition(raw) {
  const map = {};
  const lines = String(raw).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(',');
    if (parts.length < 8) continue;
    const name = parts[0].trim();
    if (!name) continue;
    map[name] = {
      kcal: parseFloat(parts[3]) || 0,
      protein: parseFloat(parts[4]) || 0,
      fat: parseFloat(parts[5]) || 0,
      carb: parseFloat(parts[6]) || 0,
      sodium: parseFloat(parts[7]) || 0
    };
  }
  return map;
}

/* 短名：去掉【】前缀和引号，够 6 字就截断（芯片/票据上放得下） */
function shortName(name){
  const s = String(name)
    .replace(/【[^】]*】/g, '')
    .replace(/[“”"'‘’]/g, '')
    .trim();
  return s.length > 6 ? s.slice(0, 6) : s;
}

/* ── 主流程 ── */
(async () => {
  const log = (...a) => console.log(...a);

  log('▶ 拉取门店…');
  const stores = await callTool('query-nearby-stores', { beType: 1, searchType: 1 });
  const store = (Array.isArray(stores) ? stores : []).find(s => s.storeCode === STORE) ||
                (Array.isArray(stores) ? stores[0] : null);
  if (!store) throw new Error('该账号下查不到门店');
  log('  门店：' + store.storeName + '（' + store.storeCode + '）');

  log('▶ 拉取菜单…');
  const menu = await callTool('query-meals', { storeCode: store.storeCode, orderType: 1, beType: 1 });
  const dict = menu.meals || {};
  log('  在线商品 ' + Object.keys(dict).length + ' 项');

  log('▶ 拉取营养表…');
  const nutMap = parseNutrition(await callTool('list-nutrition-foods', {}));
  log('  营养条目 ' + Object.keys(nutMap).length + ' 条');

  log('▶ 拉取活动日历…');
  let campaign = null;
  try {
    const cal = await callTool('campaign-calendar', {});
    const today = (cal.dailyList || []).find(d => d.dateText && d.dateText.indexOf('今日') >= 0) ||
                  (cal.dailyList || [])[0];
    const ev = today && (today.events || []).find(e => e.articleDto && e.articleDto.title);
    if (ev) campaign = {
      date: today.date,
      title: ev.articleDto.title,
      highlight: ev.articleDto.highlights || ''
    };
    log('  今日活动：' + (campaign ? campaign.title : '无'));
  } catch (e) {
    log('  ⚠ 活动日历拉取失败（不阻塞）：' + e.message);
  }

  /* 组装站配方：来自 query-meal-detail 的 modification */
  log('▶ 拉取汉堡配料（6 次）…');
  const recipes = {};
  for (const item of MENU.assembly) {
    try {
      const d = await callTool('query-meal-detail', {
        storeCode: store.storeCode, orderType: 1, beType: 1, code: item.code
      });
      const groups = (d.modification && d.modification.items) || [];
      const toppings = [];
      groups.forEach(g => (g.values || []).forEach(v => {
        // selectedQuantity>0 表示默认就配，这才是这汉堡的标准配料
        if (v.selectedQuantity > 0) toppings.push(v.name);
      }));
      recipes[item.code] = toppings;
      log('  ' + d.name + ' → ' + toppings.join('、'));
    } catch (e) {
      recipes[item.code] = [];
      log('  ⚠ ' + item.code + ' 配料拉取失败：' + e.message);
    }
  }

  /* ── 组装快照 ── */
  const dishes = {};
  Object.keys(MENU).forEach(station => {
    MENU[station].forEach(item => {
      const m = dict[item.code];
      if (!m || !m.name) {
        log('  ⚠ 菜单里找不到 ' + item.code + '，跳过');
        return;
      }
      const price = parseFloat(m.currentPrice) || 0;
      dishes[item.code] = {
        code: item.code,
        name: m.name,
        short: shortName(m.name),
        price: price,
        originalPrice: parseFloat(m.originalPrice) || price,
        cost: Math.round(price * COGS_RATE * 10) / 10,
        station: station,
        image: m.image || '',
        nutrition: nutMap[item.nutritionName] || null,
        recipe: recipes[item.code] || []
      };
    });
  });

  const snapshot = {
    meta: {
      source: '麦当劳 MCP（mcp.mcd.cn）',
      pulledAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      store: {
        storeCode: store.storeCode,
        storeName: store.storeName,
        address: store.address
      },
      campaign: campaign
    },
    stations: [
      { key: 'fries',    label: '薯条站', kind: 'fryer',    hint: '下锅 → 绿区捞出，过火就焦' },
      { key: 'drink',    label: '饮料站', kind: 'pour',     hint: '按住 → 绿区松手，满溢作废' },
      { key: 'assembly', label: '组装站', kind: 'assemble', hint: '照着单子依序加配料' }
    ],
    dishes: dishes,
    economy: {
      days: 5,
      dayMs: 60000,
      startCash: 1200,
      rent: 40,
      targetCash: 2000,
      cogsRate: COGS_RATE
    }
  };

  const json = JSON.stringify(snapshot, null, 2);
  log('\n商品数 ' + Object.keys(dishes).length +
      '　价格合计 ¥' + Object.values(dishes).reduce((a, d) => a + d.price, 0).toFixed(1));

  if (DRY) {
    log('\n--dry 模式，不写文件。预览：');
    log(json.slice(0, 1200));
    return;
  }

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, json, 'utf8');
  log('✔ 写入 ' + path.relative(ROOT, SNAPSHOT_PATH));

  /* ── 注入游戏内嵌数据块 ── */
  if (fs.existsSync(GAME_PATH)) {
    const html = fs.readFileSync(GAME_PATH, 'utf8');
    const re = /(<script id="mcd-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
    if (re.test(html)) {
      const out = html.replace(re, (_, a, __, c) => a + '\n' + json + '\n' + c);
      fs.writeFileSync(GAME_PATH, out, 'utf8');
      log('✔ 已注入 ' + path.relative(ROOT, GAME_PATH));
    } else {
      log('⚠ game/index.html 里没找到 #mcd-data 数据块，跳过注入');
    }
  }
})().catch(e => {
  console.error('✖ ' + e.message);
  process.exit(1);
});
