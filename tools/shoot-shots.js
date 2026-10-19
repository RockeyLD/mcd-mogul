/* 麦麦大亨 · 真机截图（docs/ 里那 7 张）
   和 shoot-gif.js 同一套 CDP + 机器人：先让机器人在真 Chrome 里玩起来，
   再逐个工位停住拍一张。这样截出来的锅里有活、票架上有单，不是空店。

   用法: node tools/shoot-shots.js
   输出: docs/shot_title.png / shot_{fries,basket,drink,grill,assembly}.png / shot_mobile.png
*/
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;
const PROFILE = '/tmp/mcd-shots-profile';
const GAME = path.join(ROOT, 'game', 'index.html');

const DESK = { w: 900, h: 820 };
const MOBILE = { w: 500, h: 900 };

/* ── 注入的机器人：同 shoot-gif.js，多一个 __pause 让截图时画面定住 ── */
function driverScript() {
  const qa = s => [].slice.call(document.querySelectorAll(s));
  const q1 = s => document.querySelector(s);
  const el = id => document.getElementById(id);
  const curTab = () => { const t = q1('.tab.on'); return t ? t.getAttribute('data-tab') : null; };
  const switchTo = k => { const b = q1('.tab[data-tab="' + k + '"]'); if (b) b.click(); };
  const badge = k => { const n = el('bd-' + k); return (!n || n.style.display === 'none') ? 0 : (+n.textContent || 0); };
  const ratioOf = n => { const f = n && n.querySelector('.fill'); return f ? (parseFloat(f.style.width) || 0) / 100 : 0; };
  const patties = () => { const w = el('warmBox'); return w ? qa('.wc.has', w).length : 0; };
  const BAND = [0.78, 0.85], PANIC = 0.95;
  const click = n => n.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));

  function neededCodes() {
    const out = [];
    qa('.tk:not(.going) .li.miss').forEach(n => { const c = n.getAttribute('data-w'); if (c) out.push(c); });
    return out;
  }
  function pick(pane, wanted) {
    const pks = qa(pane + ' .pk'); if (!pks.length) return null;
    for (const p of pks) if (wanted.indexOf(p.getAttribute('data-pick')) >= 0) { p.click(); return p.getAttribute('data-pick'); }
    return null;
  }
  function actCurrent(cur) {
    if (cur === 'fries' || cur === 'basket') {
      const nodes = qa(cur === 'fries' ? '[data-slot]' : '[data-bs]');
      if (cur === 'basket') { const sh = nodes.find(n => n.classList.contains('shake')); if (sh) { click(sh); return 'act'; } }
      for (const n of nodes) {
        if (n.classList.contains('ready')) {
          const r = ratioOf(n);
          if (r >= BAND[0] && r <= BAND[1]) { click(n); return 'act'; }
          if (r > PANIC) { click(n); return 'act'; }
          if (r >= 0.70) return 'camp';
          return null;
        }
        if (n.classList.contains('burnt')) { click(n); return 'act'; }
      }
      return null;
    }
    if (cur === 'grill') {
      for (const n of qa('[data-gr]')) {
        if (n.classList.contains('flip') || n.classList.contains('ready')) {
          const r = ratioOf(n);
          if (r >= BAND[0] && r <= BAND[1]) { click(n); return 'act'; }
          if (r > PANIC) { click(n); return 'act'; }
          if (r >= 0.70) return 'camp';
          return null;
        }
        if (n.classList.contains('burnt')) { click(n); return 'act'; }
      }
    }
    return null;
  }

  let lastCam = 0;
  window.__frames = 0;
  window.__pause = false;
  window.__lockTab = null;   // 锁定工位：机器人照常干活，但不许自己切走

  window.__step = function () {
    if (window.__pause) return;
    window.__frames++;
    if (el('go')) { el('go').click(); return; }
    if (el('nx')) { el('nx').click(); return; }
    if (el('rs')) return;

    for (const g of qa('.tk:not(.going) [data-go]')) if (!g.disabled) { click(g); return; }

    const tap = el('tap');
    if (tap) {
      if (tap.classList.contains('ready')) { window.dispatchEvent(new Event('pointerup', { bubbles: true })); return; }
      if (tap.classList.contains('on')) return;
    }

    const wanted = neededCodes();
    const cur = curTab();

    const a = actCurrent(cur);
    if (a) return;

    const now = performance.now();
    if (!window.__lockTab && now - lastCam > 1800) {
      const jobs = ['assembly', 'grill', 'fries', 'basket', 'drink'].filter(k => badge(k) > 0);
      const alt = jobs.find(k => k !== cur);
      if (alt) { lastCam = now; switchTo(alt); return; }
    }

    let done = false;
    if (cur === 'fries') {
      const on = q1('#pick-fries .pk.on');
      const tgt = wanted.find(c => q1('#pick-fries .pk[data-pick="' + c + '"]'));
      if (tgt && (!on || on.getAttribute('data-pick') !== tgt)) { pick('#pick-fries', wanted); done = true; }
      else { const idle = q1('[data-slot].idle'); if (idle && tgt && qa('[data-slot]:not(.idle)').length < 2) { click(idle); done = true; } }
    } else if (cur === 'basket') {
      const on = q1('#pick-basket .pk.on');
      const tgt = wanted.find(c => q1('#pick-basket .pk[data-pick="' + c + '"]'));
      if (tgt && (!on || on.getAttribute('data-pick') !== tgt)) { pick('#pick-basket', wanted); done = true; }
      else { const idle = q1('[data-bs].idle'); if (idle && tgt && qa('[data-bs]:not(.idle)').length < 1) { click(idle); done = true; } }
    } else if (cur === 'grill') {
      const idle = q1('[data-gr].idle');
      if (idle && badge('grill') > 0 && qa('[data-gr]:not(.idle)').length < 2) { click(idle); done = true; }
    } else if (cur === 'drink') {
      const on = q1('#pick-drink .pk.on');
      const tgt = wanted.find(c => q1('#pick-drink .pk[data-pick="' + c + '"]'));
      if (tgt && (!on || on.getAttribute('data-pick') !== tgt)) { pick('#pick-drink', wanted); done = true; }
      else if (tgt && tap) { tap.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); done = true; }
    } else if (cur === 'assembly') {
      const fin = el('fin');
      if (fin && !fin.disabled) { fin.click(); done = true; }
      else {
        const chip = q1('.need span.next');
        if (chip) {
          const nm = chip.textContent.replace(/^\d+/, '').trim();
          const btn = qa('.ig').find(x => x.getAttribute('data-ig') === nm);
          if (btn) { btn.click(); done = true; }
        }
      }
    }
    if (done) return;

    let next = null;
    if (badge('assembly') > 0 && patties() > 0) next = 'assembly';
    else if (badge('grill') > 0) next = 'grill';
    else if (badge('fries') > 0) next = 'fries';
    else if (badge('basket') > 0) next = 'basket';
    else if (badge('drink') > 0) next = 'drink';
    if (next && next !== cur && !window.__lockTab) switchTo(next);
    lastCam = now;
  };

  window.__speed = 60;   // 每次出手的间隔（毫秒）。调慢一点，票架才会堆起单来，截图才不是空店
  (function loop(){ setTimeout(loop, window.__speed); window.__step(); })();
  return 'ok';
}

/* ── CDP 最小客户端 ── */
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.ws = null; this.handlers = {}; }
  on(method, fn) { (this.handlers[method] = this.handlers[method] || []).push(fn); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws error')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res, rej } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
          return;
        }
        if (m.method) for (const fn of (this.handlers[m.method] || [])) fn(m.params);
      });
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--disable-features=Translate,MediaRouter', '--mute-audio',
    '--force-device-scale-factor=1',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--window-size=' + DESK.w + ',' + DESK.h,
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  const die = async msg => { console.error('✗ ' + msg); try { chrome.kill('SIGKILL'); } catch (e) {} process.exit(1); };

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await r.json();
      if (targets && targets.length) break;
    } catch (e) {}
  }
  if (!targets || !targets.length) return die('devtools 没起来');

  const page = targets.find(t => t.type === 'page') || targets[0];
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const jsErrs = [];
  cdp.on('Runtime.exceptionThrown', p => {
    const d = p.exceptionDetails || {};
    jsErrs.push('异常: ' + ((d.exception && d.exception.description) || d.text || '?'));
  });
  cdp.on('Log.entryAdded', p => {
    const e = p.entry || {};
    if (e.level === 'error') jsErrs.push('error: ' + (e.text || '') + (e.url ? ' @' + e.url : ''));
  });

  const evalJS = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    return r.result ? r.result.value : undefined;
  };
  const shot = async name => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
    console.log('  ✔ ' + name + '  ' + Math.round(Buffer.from(s.data, 'base64').length / 1024) + ' KB');
  };

  /* 1) 标题页（还没点开门营业，机器人注入前拍，画面最干净） */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: DESK.w, height: DESK.h, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: 'file://' + GAME });
  await sleep(1600);
  if (!(await evalJS('!!document.getElementById("go")'))) return die('标题页没渲染出来');
  await shot('shot_title.png');

  /* 2) 注入机器人，让它替我们把店开起来、把锅烧上 */
  const r = await cdp.send('Runtime.evaluate', { expression: '(' + driverScript.toString() + ')()', returnByValue: true });
  if (r.exceptionDetails) return die('注入失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));

  /* 放慢到 ~200ms 一次：机器人 16ms 那种手速会把单做完、票架永远是空的，
     截图拍出来像没人光顾。放慢后订单会排到 4~6 张，画面才是"手忙脚乱"的真实样子。 */
  await evalJS('window.__speed = 200');

  // 等它开门 + 攒出几张单
  let waited = 0;
  while (waited < 40000) {
    const m = JSON.parse(await evalJS('JSON.stringify({tk:document.querySelectorAll(".tk:not(.going)").length, tabs:document.querySelectorAll(".tab").length})'));
    if (m.tk >= 4) { console.log('  票架 ' + m.tk + ' 张，开始逐站拍'); break; }
    await sleep(200); waited += 200;
  }
  await sleep(1200);

  /* 3) 工位截图：组装站先拍 —— 它要同时满足"有肉饼"和"票架上有汉堡单"，
        越往后营业时间越少、票架越空，所以先把它拿下，其余四站随手就拍 */
  const STATIONS = [
    ['assembly', '组装站', '#bench .asm', 1],
    ['fries', '薯条站', '[data-slot]:not(.idle)', 2],
    ['basket', '炸物站', '[data-bs]:not(.idle)', 1],
    ['drink', '饮料站', '#tap.on, #tap.ready', 1],
    ['grill', '煎区', '[data-gr]:not(.idle)', 2]
  ];
  const BADGE = k => '(function(){var n=document.getElementById("bd-' + k + '");return (!n||n.style.display==="none")?0:(+n.textContent||0);})()';
  const WARM = 'document.querySelectorAll("#warmBox .wc.has").length';
  const HAS_TICKET = 'document.querySelectorAll(".tk:not(.going)").length >= 1';

  for (const [key, label, busySel, minN] of STATIONS) {
    if (key === 'assembly') {
      /* 先在煎区攒肉饼，同时等一张汉堡单挂上来 —— 少一个条件拍出来就是空台 */
      await evalJS('window.__lockTab = "grill"; window.__pause = false');
      await evalJS('(function(){var b=document.querySelector(\'.tab[data-tab="grill"]\');if(b)b.click();})()');
      let patty = 0, tickets = 0;
      for (let i = 0; i < 60; i++) {
        await sleep(400);
        patty = +(await evalJS(WARM) || 0);
        tickets = +(await evalJS(BADGE('assembly')) || 0);
        if (patty >= 1 && tickets >= 1) break;
      }
      console.log('  肉饼 ' + patty + ' 块 · 待做汉堡 ' + tickets + ' 张');
    }
    await evalJS('window.__lockTab = ' + JSON.stringify(key) + '; window.__pause = false');
    const ok = await evalJS('(function(){var b=document.querySelector(\'.tab[data-tab="' + key + '"]\');if(!b)return false;b.click();return true;})()');
    if (!ok) { console.log('  ⚠ 找不到 ' + label + ' 的 tab，跳过'); continue; }

    /* 等"光看就知道在干活"的那一瞬：本工位有够多的活在走 + 票架上还有单。
       机器人的节奏比客流快，票架经常是空的，硬等固定时长大概率拍到空店。
       先按理想数量等，等不到就退一步按 1 个算，还等不到就直接拍。 */
    const countBusy = 'document.querySelectorAll(' + JSON.stringify(busySel) + ').length';
    let hit = false, best = 0;
    for (let pass = 0; pass < 2 && !hit; pass++) {
      const want = pass === 0 ? minN : 1;
      const tries = pass === 0 ? 34 : 20;                 // 约 5s + 3s
      for (let i = 0; i < tries; i++) {
        await sleep(150);
        const n = +(await evalJS(countBusy) || 0);
        best = Math.max(best, n);
        if (n >= want && (await evalJS(HAS_TICKET))) { hit = true; break; }
      }
    }
    await evalJS('window.__pause = true');
    await sleep(60);

    /* 票架上一直没有这站的单（薯条站最常见）—— 不管了，直接替玩家"先备一锅"，
       反正取景要的是锅里有货，不是把这张单做出来 */
    if (!hit && (key === 'fries' || key === 'basket')) {
      await evalJS('window.__pause = false');
      await evalJS('(function(){' +
        'var C=function(n){n.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:100,clientY:100}));};' +
        'var p=document.querySelector("#pick-' + key + ' .pk");if(p)C(p);})()');
      await sleep(200);
      const slots = await evalJS('(function(){' +
        'var C=function(n){n.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:100,clientY:100}));};' +
        'var s=document.querySelectorAll("' + (key === 'fries' ? '[data-slot].idle' : '[data-bs].idle') + '");' +
        'for(var i=0;i<s.length;i++)C(s[i]);return s.length;})()');
      console.log('  ' + label + ' 没单，手动下 ' + slots + ' 锅');
      await sleep(700);
      await evalJS('window.__pause = true');
      await sleep(60);
    }

    /* 饮料站同理：票上没饮料就自己打一杯，画面里液面正在绿区附近最好看 */
    if (!hit && key === 'drink') {
      await evalJS('window.__pause = false');
      await evalJS('(function(){' +
        'var C=function(n){n.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:100,clientY:100}));};' +
        'var p=document.querySelector("#pick-drink .pk");if(p)C(p);})()');
      await sleep(200);
      await evalJS('(function(){var t=document.getElementById("tap");if(t)t.dispatchEvent(new Event("pointerdown",{bubbles:true,cancelable:true}));})()');
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        const pct = +(await evalJS('(function(){var n=document.getElementById("pourPct");return n?(+n.textContent||0):0;})()') || 0);
        if (pct >= 78) break;
      }
      await evalJS('window.__pause = true');
      await sleep(60);
    }

    /* 煎区：票上没汉堡就自己先放两块肉上去，画面里才不是三个空煎位 */
    if (!hit && key === 'grill') {
      await evalJS('window.__pause = false');
      const slots = await evalJS('(function(){' +
        'var C=function(n){n.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:100,clientY:100}));};' +
        'var s=document.querySelectorAll("[data-gr].idle");var n=0;' +
        'for(var i=0;i<s.length&&n<2;i++){C(s[i]);n++;}return n;})()');
      console.log('  ' + label + ' 没单，手动放 ' + slots + ' 块肉饼');
      await sleep(1500);
      await evalJS('window.__pause = true');
      await sleep(60);
    }

    const cur = await evalJS('(function(){var t=document.querySelector(".tab.on");return t&&t.getAttribute("data-tab");})()');
    const finalN = +(await evalJS(countBusy) || 0);
    if (cur !== key) console.log('  ⚠ ' + label + ' 拍到了 ' + cur + '，画面与文件名不符');
    console.log('  ' + label + (finalN > 0 ? ' 画面里有 ' + finalN + ' 个在走' : ' ⚠ 空的（' + best + '）'));
    /* 清掉上一站留下的 toast（"没打满，倒了"飘到煎区画面上很跳戏） */
    await evalJS('(function(){var t=document.querySelectorAll(".toast");for(var i=0;i<t.length;i++)t[i].remove();})()');
    await shot('shot_' + key + '.png');
    if (key === 'drink') await evalJS('window.dispatchEvent(new Event("pointerup",{bubbles:true}))');  // 别让杯子一直注到溢出
    await evalJS('window.__lockTab = null');
  }

  /* 4) 窄屏：只换视口，重新截一张整体（工位锁定在煎区） */
  await evalJS('window.__lockTab = "grill"; window.__pause = false');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: MOBILE.w, height: MOBILE.h, deviceScaleFactor: 1, mobile: true });
  await evalJS('(function(){var b=document.querySelector(\'.tab[data-tab="grill"]\');if(b)b.click();})()');
  await sleep(900);
  await evalJS('window.__pause = true');
  await sleep(120);
  await shot('shot_mobile.png');

  const frames = await evalJS('window.__frames');
  console.log('机器人步数 ' + frames);
  console.log('真浏览器报错 ' + (jsErrs.length ? '\n  ' + jsErrs.slice(0, 10).join('\n  ') : '无 ✅'));

  cdp.close();
  try { chrome.kill('SIGTERM'); } catch (e) {}
  await sleep(400);
  try { chrome.kill('SIGKILL'); } catch (e) {}
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
