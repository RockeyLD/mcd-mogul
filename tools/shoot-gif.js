/* 麦麦大亨 · 真机录屏帧采集
   用 CDP 驱动无头 Chrome，注入机器人真的在玩，按固定间隔截帧，
   输出到 shots/ 目录，交给 tools/make-gif.py 合成 GIF。

   用法: node tools/shoot-gif.js [输出目录] [秒数] [帧率] [宽] [高] [预热秒]
   例:   node tools/shoot-gif.js shots 7 10 900 980 12
*/
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, process.argv[2] || 'shots');
const SECS = +(process.argv[3] || 6);
const FPS = +(process.argv[4] || 12);
const W = +(process.argv[5] || 900);
const H = +(process.argv[6] || 980);
const WARM = +(process.argv[7] || 12);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PROFILE = '/tmp/mcd-cdp-profile';
const GAME = path.join(ROOT, 'game', 'index.html');

/* 每次采集写到一个新的时间戳目录，不删旧帧——
   一是省掉清目录的批量删除，二是想重做上一条可以直接拿旧帧重合成。 */
const RUN = path.join(OUT, new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14));
fs.mkdirSync(RUN, { recursive: true });

/* ── 注入的机器人：和 tools/harness.js 同一套逻辑，改成真浏览器 API ── */
function driverScript() {
  const qa = s => [].slice.call(document.querySelectorAll(s));
  const q1 = s => document.querySelector(s);
  const el = id => document.getElementById(id);
  const onTab = k => !!q1('.tab.on[data-tab="' + k + '"]');
  const curTab = () => { const t = q1('.tab.on'); return t ? t.getAttribute('data-tab') : null; };
  const switchTo = k => { const b = q1('.tab[data-tab="' + k + '"]'); if (b) b.click(); };
  const badge = k => { const n = el('bd-' + k); return (!n || n.style.display === 'none') ? 0 : (+n.textContent || 0); };
  const ratioOf = n => { const f = n && n.querySelector('.fill'); return f ? (parseFloat(f.style.width) || 0) / 100 : 0; };
  const patties = () => { const w = el('warmBox'); return w ? qa('.wc.has', w).length : 0; };
  const BAND = [0.76, 0.87], PANIC = 0.95;
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

  window.__step = function () {
    window.__frames++;
    if (el('go')) { el('go').click(); return; }
    if (el('nx')) { el('nx').click(); return; }
    if (el('rs')) return;

    // 1) 能出就出
    for (const g of qa('.tk:not(.going) [data-go]')) if (!g.disabled) { click(g); return; }

    // 2) 正在注液就锁在饮料站
    const tap = el('tap');
    if (tap) {
      if (tap.classList.contains('ready')) { window.dispatchEvent(new Event('pointerup', { bubbles: true })); return; }
      if (tap.classList.contains('on')) return;
    }

    const wanted = neededCodes();
    const cur = curTab();

    const a = actCurrent(cur);
    if (a) return;

    // 3) 导播：每 1.8 秒换一个有活的工位，让录屏能扫到不同工位
    const now = performance.now();
    if (now - lastCam > 1800) {
      const jobs = ['assembly', 'grill', 'fries', 'basket', 'drink'].filter(k => badge(k) > 0);
      const alt = jobs.find(k => k !== cur);
      if (alt) { lastCam = now; switchTo(alt); return; }
    }

    // 4) 当前工位干活
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

    // 5) 换站
    let next = null;
    if (badge('assembly') > 0 && patties() > 0) next = 'assembly';
    else if (badge('grill') > 0) next = 'grill';
    else if (badge('fries') > 0) next = 'fries';
    else if (badge('basket') > 0) next = 'basket';
    else if (badge('drink') > 0) next = 'drink';
    if (next && next !== cur) switchTo(next);
    lastCam = now;
  };

  window.__timer = setInterval(window.__step, 60);
  return 'ok';
}

/* ── CDP 最小客户端 ── */
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.ws = null; this.handlers = {}; this.events = []; }
  on(method, fn) { (this.handlers[method] = this.handlers[method] || []).push(fn); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', e => rej(new Error('ws error')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res, rej } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
          return;
        }
        if (m.method) {
          this.events.push(m);
          for (const fn of (this.handlers[m.method] || [])) fn(m.params);
        }
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
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--disable-features=Translate,MediaRouter', '--mute-audio',
    '--force-device-scale-factor=1',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--window-size=' + W + ',' + H,
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  const die = async msg => { console.error('✗ ' + msg); try { chrome.kill('SIGKILL'); } catch (e) {} process.exit(1); };

  // 等 devtools 起来
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

  /* 收集真浏览器里的报错——jsdom 测不出 CSS/渲染层面的问题，这段是补那块的洞 */
  const jsErrs = [];
  cdp.on('Runtime.exceptionThrown', p => {
    const d = p.exceptionDetails || {};
    jsErrs.push('异常: ' + ((d.exception && d.exception.description) || d.text || '?'));
  });
  cdp.on('Log.entryAdded', p => {
    const e = p.entry || {};
    if (e.level === 'error') jsErrs.push('error: ' + (e.text || '') + (e.url ? ' @' + e.url : ''));
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false
  });

  await cdp.send('Page.navigate', { url: 'file://' + GAME });
  await sleep(1800);

  // 注入机器人
  const r = await cdp.send('Runtime.evaluate', {
    expression: '(' + driverScript.toString() + ')()', returnByValue: true
  });
  if (r.exceptionDetails) return die('注入失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));

  // 预热：让机器人先玩一会儿（这段不录）
  await sleep(WARM * 1000);

  /* 等一个"值得录"的时刻：票架上至少 2 张单，否则录出来是空店 */
  const probe = 'JSON.stringify({' +
    'tk: document.querySelectorAll(".tk:not(.going)").length,' +
    'tab: (document.querySelector(".tab.on") || {}).getAttribute ? document.querySelector(".tab.on").getAttribute("data-tab") : "",' +
    'shelf: document.querySelectorAll("#shelf .sf:not(.empty)").length,' +
    'day: (document.querySelector("#app h1") || {}).textContent || ""' +
    '})';
  let waited = 0;
  while (waited < 40000) {
    const v = await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true });
    let m = {}; try { m = JSON.parse(v.result.value); } catch (e) {}
    if (m.tk >= 2) { console.log('  票架 ' + m.tk + ' 张，开录（' + m.day + '）'); break; }
    await sleep(150); waited += 150;
  }

  const total = Math.round(SECS * FPS);
  const gap = 1000 / FPS;
  const meta = [];
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const want = t0 + i * gap;
    const wait = want - Date.now();
    if (wait > 0) await sleep(wait);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const name = 'f_' + String(i).padStart(3, '0') + '.png';
    fs.writeFileSync(path.join(RUN, name), Buffer.from(shot.data, 'base64'));
    const v = await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true });
    try { meta.push(JSON.parse(v.result.value)); } catch (e) { meta.push({}); }
    if (i === 0 || (i + 1) % 12 === 0) process.stdout.write('  ' + (i + 1) + '/' + total + '\n');
  }
  fs.writeFileSync(path.join(RUN, 'meta.json'), JSON.stringify(meta, null, 0));

  const stats = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({frames: window.__frames, h: document.getElementById("hCash") ? document.getElementById("hCash").textContent : ""})',
    returnByValue: true
  });
  console.log('采集完成 ' + total + ' 帧 → ' + RUN);
  console.log('机器人步数 ' + stats.result.value);
  console.log('真浏览器报错 ' + (jsErrs.length ? '\n  ' + jsErrs.slice(0, 10).join('\n  ') : '无 ✅'));

  cdp.close();
  try { chrome.kill('SIGTERM'); } catch (e) {}
  await sleep(400);
  try { chrome.kill('SIGKILL'); } catch (e) {}
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
