/* 麦麦大亨 · 无头测试台 v3（五工位版）
   虚拟时钟接管 rAF / setTimeout / setInterval，用真实 DOM 事件驱动机器人。
   用法: node tools/harness.js [game/index.html] [smart|dumb] [step] [guard]
   例:   node tools/harness.js game/index.html smart 16 80000 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const path = require('path');
const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'game', 'index.html'));
const MODE = process.argv[3] || 'smart';
const STEP = +(process.argv[4] || 16);
const GUARD = +(process.argv[5] || 80000);

const html = fs.readFileSync(FILE, 'utf8');

let vnow = 0, rafCb = null, tid = 1, timers = [], finished = false;
const errs = [], days = [];
let lastSettled = -1;

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  beforeParse(window) {
    window.requestAnimationFrame = cb => { rafCb = cb; return 1; };
    window.cancelAnimationFrame = () => { rafCb = null; };
    window.setTimeout = (fn, ms) => { const id = tid++; timers.push({ id, due: vnow + (ms || 0), fn, every: 0 }); return id; };
    window.setInterval = (fn, ms) => { const id = tid++; timers.push({ id, due: vnow + (ms || 1), fn, every: Math.max(1, ms || 1) }); return id; };
    window.clearTimeout = window.clearInterval = id => { timers = timers.filter(t => t.id !== id); };
    window.AudioContext = window.webkitAudioContext = function () { throw new Error('no audio'); };
  }
});
const win = dom.window, doc = win.document;

function tick(ms) {
  const target = vnow + ms;
  let g = 0;
  while (g++ < 4000) {
    let idx = -1, best = Infinity;
    for (let i = 0; i < timers.length; i++) if (timers[i].due <= target && timers[i].due < best) { best = timers[i].due; idx = i; }
    if (idx < 0) break;
    const t = timers[idx];
    vnow = t.due;
    if (t.every) t.due += t.every; else timers.splice(idx, 1);
    try { t.fn(); } catch (e) { if (errs.length < 8) errs.push('timer: ' + e.message); }
  }
  vnow = target;
  const cb = rafCb; rafCb = null;
  if (cb) { try { cb(vnow); } catch (e) { if (errs.length < 8) errs.push('raf: ' + e.message); } }
}

const money = s => {
  const str = String(s || '').replace(/,/g, '');
  const neg = str.indexOf('-') >= 0;
  const m = str.match(/[\d.]+/);
  return m ? (neg ? -1 : 1) * parseFloat(m[0]) : 0;
};
const num = s => { const m = String(s || '').replace(/,/g, '').match(/\d+/); return m ? parseFloat(m[0]) : 0; };
const el = id => doc.getElementById(id);
const qa = (sel, root) => [].slice.call((root || doc).querySelectorAll(sel));
const q1 = sel => doc.querySelector(sel);
function readRow(k) {
  for (const r of qa('#app .card .row')) {
    const kk = r.querySelector('.k');
    if (kk && kk.textContent.trim() === k) { const v = r.querySelector('.v'); return v ? v.textContent : ''; }
  }
  return '';
}
const onTab = k => !!doc.querySelector('.tab.on[data-tab="' + k + '"]');
const switchTo = k => { const b = doc.querySelector('.tab[data-tab="' + k + '"]'); if (b) b.click(); };
const badge = k => { const n = el('bd-' + k); return (!n || n.style.display === 'none') ? 0 : (+n.textContent || 0); };
const curryTab = () => { const t = q1('.tab.on'); return t ? t.getAttribute('data-tab') : null; };

function recordDay() {
  const h1 = doc.querySelector('#app h1');
  if (!h1) return;
  const d = num(h1.textContent);
  if (d === lastSettled) return;
  lastSettled = d;
  const t = String(readRow('接待顾客'));
  days.push({
    day: d,
    served: num(t.split('/')[0]),
    traffic: num(t.split('/')[1] || ''),
    rate: num(readRow('服务率')),
    sold: num(readRow('卖出')),
    perfect: num(readRow('完美出品')),
    lost: num(readRow('跑掉的顾客')),
    waste: num(readRow('炸糊 / 倒掉')),
    revenue: money(readRow('营业收入')),
    tips: money(readRow('小费')),
    cost: Math.abs(money(readRow('原料成本'))),
    rent: Math.abs(money(readRow('房租'))),
    lostPay: Math.abs(money(readRow('跑单赔偿'))),
    profit: money(readRow('今日净利')),
    cash: money(readRow('现金余额'))
  });
}

function neededCodes() {
  const out = [];
  qa('.tk:not(.going) .li.miss').forEach(n => { const c = n.getAttribute('data-w'); if (c) out.push(c); });
  return out;
}

function pickProduct(paneSel, wanted) {
  const pks = qa(paneSel + ' .pk');
  if (!pks.length) return null;
  for (const p of pks) if (wanted.indexOf(p.getAttribute('data-pick')) >= 0) { p.click(); return p.getAttribute('data-pick'); }
  if (MODE === 'dumb') { pks[0].click(); return pks[0].getAttribute('data-pick'); }
  return null;
}
const patties = () => {
  const w = el('warmBox');
  if (!w) return 0;
  return qa('.wc.has', w).length;
};

/* 机器人按"进度条"决定出手时机：绿区起点出手的质量分只有 0.3，正中才是 1.0。
   BAND = 完美出手区间（相对进度条），PANIC = 再不动就要烧了 */
const BAND = [0.76, 0.87];
const PANIC = 0.95;
function ratioOf(node) {
  const f = node && node.querySelector('.fill');
  if (!f) return 0;
  return (parseFloat(f.style.width) || 0) / 100;
}
function actCurrent(cur) {
  if (cur === 'fries' || cur === 'basket') {
    const nodes = qa(cur === 'fries' ? '[data-slot]' : '[data-bs]');
    if (cur === 'basket') {
      const sh = nodes.find(n => n.classList.contains('shake'));
      if (sh) { sh.click(); return 'act'; }        // 抖篮不扣质量，越早越好
    }
    for (const n of nodes) {
      if (n.classList.contains('ready')) {
        const r = ratioOf(n);
        if (r >= BAND[0] && r <= BAND[1]) { n.click(); return 'act'; }
        if (r > PANIC) { n.click(); return 'act'; }
        if (r >= 0.70) return 'camp';
        return null;
      }
      if (n.classList.contains('burnt')) { n.click(); return 'act'; }
    }
    return null;
  }
  if (cur === 'grill') {
    for (const n of qa('[data-gr]')) {
      if (n.classList.contains('flip') || n.classList.contains('ready')) {
        const r = ratioOf(n);
        if (r >= BAND[0] && r <= BAND[1]) { n.click(); return 'act'; }
        if (r > PANIC) { n.click(); return 'act'; }
        if (r >= 0.70) return 'camp';
        return null;
      }
      if (n.classList.contains('burnt')) { n.click(); return 'act'; }
    }
    return null;
  }
  return null;
}

function doFries(wanted) {
  const cur = q1('#pick-fries .pk.on');
  const target = wanted.find(c => q1('#pick-fries .pk[data-pick="' + c + '"]'));
  if (target && (!cur || cur.getAttribute('data-pick') !== target)) { pickProduct('#pick-fries', wanted); return true; }
  const busy = qa('[data-slot]:not(.idle)').length;
  const idle = q1('[data-slot].idle');
  if (idle && (MODE === 'dumb' || (target && badge('fries') > 0 && busy < 2))) { idle.click(); return true; }
  return false;
}
function doBasket(wanted) {
  const cur = q1('#pick-basket .pk.on');
  const target = wanted.find(c => q1('#pick-basket .pk[data-pick="' + c + '"]'));
  if (target && (!cur || cur.getAttribute('data-pick') !== target)) { pickProduct('#pick-basket', wanted); return true; }
  const busy = qa('[data-bs]:not(.idle)').length;
  const idle = q1('[data-bs].idle');
  if (idle && (MODE === 'dumb' || (target && badge('basket') > 0 && busy < 1))) { idle.click(); return true; }
  return false;
}
function doGrill() {
  const g = badge('grill');
  const busy = qa('[data-gr]:not(.idle)').length;
  const idle = q1('[data-gr].idle');
  if (idle && (MODE === 'dumb' || (g > 0 && busy < 2))) { idle.click(); return true; }
  return false;
}
function doDrink(wanted) {
  const tap = el('tap');
  if (!tap) return false;
  const cur = q1('#pick-drink .pk.on');
  const target = wanted.find(c => q1('#pick-drink .pk[data-pick="' + c + '"]'));
  if (target && (!cur || cur.getAttribute('data-pick') !== target)) { pickProduct('#pick-drink', wanted); return true; }
  if (MODE === 'dumb' || (target && badge('drink') > 0)) {
    tap.dispatchEvent(new win.Event('pointerdown', { bubbles: true, cancelable: true }));
    return true;
  }
  return false;
}
function doAssembly() {
  const fin = el('fin');
  if (fin && !fin.disabled) { fin.click(); return true; }
  const chip = q1('.need span.next');
  if (chip) {
    const name = chip.textContent.replace(/^\d+/, '').trim();
    const btn = qa('.ig').find(x => x.getAttribute('data-ig') === name);
    if (btn) { btn.click(); return true; }
  }
  return false;
}

function botStep() {
  if (el('rs')) { finished = true; return; }
  if (el('nx')) { recordDay(); el('nx').click(); return; }
  if (el('go')) { el('go').click(); return; }

  // 1) 能出就出
  for (const g of qa('.tk:not(.going) [data-go]')) {
    if (!g.disabled) { g.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 })); return; }
  }

  // 2) 正在注液：锁死在饮料站
  const tap = el('tap');
  if (tap) {
    if (tap.classList.contains('ready')) { win.dispatchEvent(new win.Event('pointerup', { bubbles: true })); return; }
    if (tap.classList.contains('on')) return;
  }

  const wanted = neededCodes();
  const cur = curryTab();

  // 3) 当前工位的"到点"动作（按进度条挑时机）
  const a = actCurrent(cur);
  if (a === 'act') return;
  if (a === 'camp') return;

  // 4) 当前工位干正经活
  let done = false;
  if (cur === 'fries') done = doFries(wanted);
  else if (cur === 'basket') done = doBasket(wanted);
  else if (cur === 'grill') done = doGrill();
  else if (cur === 'drink') done = doDrink(wanted);
  else if (cur === 'assembly') done = doAssembly();
  if (done) return;

  // 5) 换站：先保证有肉饼，再按角标多少排队
  const nA = badge('assembly'), nG = badge('grill'), nF = badge('fries'),
        nB = badge('basket'), nD = badge('drink');
  let next = null;
  if (nA > 0 && patties() > 0) next = 'assembly';
  else if (nG > 0) next = 'grill';
  else if (nF > 0) next = 'fries';
  else if (nB > 0) next = 'basket';
  else if (nD > 0) next = 'drink';
  if (next && next !== cur) { switchTo(next); return; }
  // 都没活：轮流看一圈（别卡死在一个空工位）
  const order = ['assembly', 'grill', 'fries', 'basket', 'drink'];
  const i = order.indexOf(cur || 'assembly');
  switchTo(order[(i + 1) % order.length]);
}

/* ── 跑 ── */
let guard = 0, stuckSince = -1, stuckInfo = '';
const T0 = Date.now();
let peakNodes = 0;

while (!finished && guard++ < GUARD) {
  if (Date.now() - T0 > 180000) { stuckInfo = '超时 180s @帧' + guard; break; }
  tick(STEP);
  botStep();
  peakNodes = Math.max(peakNodes, doc.body.childNodes.length);
  const alive = el('go') || el('nx') || el('rs') || el('hTime');
  if (!alive && stuckSince < 0) stuckSince = guard;
  else if (alive && stuckSince > 0) stuckSince = -1;
  if (stuckSince > 0 && guard - stuckSince > 400) {
    stuckInfo = '卡死 @帧' + stuckSince + ' 标题=' +
      (doc.querySelector('#app h1') ? doc.querySelector('#app h1').textContent : '无') +
      ' 文本=' + (el('app') ? el('app').textContent.slice(0, 160).replace(/\s+/g, ' ') : '');
    break;
  }
}
if (stuckInfo) console.log('⚠ ' + stuckInfo);

const p = (v, n) => String(v).padStart(n);
console.log('\n模式 ' + MODE + '  步长 ' + STEP + 'ms  总帧 ' + guard + '  峰值节点 ' + peakNodes + '  残留定时器 ' + timers.length);
console.log('─'.repeat(116));
console.log('天 | 接待/总 | 服务率 | 完美 | 跑单 | 废品 |    收入 |   小费 |   成本 |   房租 |  赔偿 |     净利 |     现金');
console.log('─'.repeat(116));
for (const r of days) {
  console.log(p(r.day, 2) + ' |' + p(r.served + '/' + r.traffic, 7) + ' |' + p(r.rate + '%', 6) + ' |' +
    p(r.perfect, 5) + ' |' + p(r.lost, 5) + ' |' + p(r.waste, 5) + ' |' +
    p(Math.round(r.revenue), 8) + ' |' + p(Math.round(r.tips), 7) + ' |' +
    p(Math.round(r.cost), 7) + ' |' + p(Math.round(r.rent), 7) + ' |' + p(Math.round(r.lostPay), 5) + ' |' +
    p(Math.round(r.profit), 9) + ' |' + p(Math.round(r.cash), 9));
}
console.log('─'.repeat(116));

const grade = doc.querySelector('#app .grade');
const startCash = num(readRowStart());
function readRowStart() {
  // 开局现金从快照里取（标题页看不到，用第一天反推不出来，直接读数据块）
  const raw = el('mcd-data');
  try { return JSON.parse(raw.textContent).economy.startCash; } catch (e) { return 1000; }
}
const endCash = days.length ? days[days.length - 1].cash : 0;
const sum = f => days.reduce((a, r) => a + (r[f] || 0), 0);
const expect = startCash + sum('revenue') + sum('tips') - sum('cost') - sum('rent') - sum('lostPay');
console.log('结算天数 ' + days.length + '   评级 ' + (grade ? grade.textContent : '(未到结局页)'));
console.log('收入 ' + Math.round(sum('revenue')) + ' + 小费 ' + Math.round(sum('tips')) +
  ' - 成本 ' + Math.round(sum('cost')) + ' - 房租 ' + Math.round(sum('rent')) +
  ' - 赔偿 ' + Math.round(sum('lostPay')) + ' = 净利 ' + Math.round(sum('profit')));
console.log('现金守恒 ' + startCash + '→' + Math.round(endCash) + '，理论 ' + Math.round(expect) +
  (Math.abs(expect - endCash) < 4 ? '  ✅' : '  ❌ 差 ' + Math.round(expect - endCash)));
console.log('完美 ' + sum('perfect') + ' / 服务 ' + sum('served') + '，服务率 ' +
  (sum('served') + sum('lost') ? Math.round(sum('served') / (sum('served') + sum('lost')) * 100) : 0) + '%');
console.log('错误 ' + (errs.length ? JSON.stringify(errs) : '无'));
