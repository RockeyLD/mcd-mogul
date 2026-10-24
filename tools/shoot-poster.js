/* 把 poster/poster.html 渲染成 PNG。
   无头 Chrome + CDP，跟 shoot-shots.js 一个路子，但只做一件事：
   精确按 1080×1440 排版，2 倍像素导出（2160×2880），字体和 SVG 都是浏览器原生渲染。

   用法: node tools/shoot-poster.js
   输出: poster/poster.png
*/
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'poster', 'poster.html');
const OUT = path.join(ROOT, 'poster', 'poster.png');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9341;
const PROFILE = '/tmp/mcd-poster-profile';

const W = 1080;
const H = 1440;
const DSF = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitPort() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { await r.json(); return; }
    } catch (e) {}
    await sleep(100);
  }
  throw new Error('Chrome 没起来（端口 ' + PORT + '）');
}

/* /json/version 给的是浏览器级 WS，上面没有 Page 域。
   得从 /json/list 里挑 type === 'page' 那个 target。 */
async function pageWs() {
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page.webSocketDebuggerUrl;
    await sleep(100);
  }
  throw new Error('/json/list 里没有可用的 page target');
}

function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', e => reject(new Error('WS 错误: ' + e.message)));
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const mid = ++id;
          return new Promise((res, rej) => {
            // 没有超时的话，Chrome 中途崩掉会让这里永远 pending，
            // 进程静默退出、exit 0、什么都没生成 —— 排查起来最费劲的那种失败。
            const t = setTimeout(() => {
              pending.delete(mid);
              rej(new Error(`CDP ${method} 超时 20s（Chrome 大概崩了）`));
            }, 20000);
            pending.set(mid, {
              res: v => { clearTimeout(t); res(v); },
              rej: e => { clearTimeout(t); rej(e); }
            });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close() { try { ws.close(); } catch (e) {} }
      });
    });
  });
}

async function main() {
  if (!fs.existsSync(SRC)) throw new Error('找不到 ' + SRC);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-sandbox',                 // 这台机器的 Chrome sandbox 起不来，必须关
    '--disable-gpu',                // GPU 进程会崩
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--font-render-hinting=none',
    '--force-color-profile=srgb',
    `--window-size=${W},${H}`,
    'about:blank'
  ], { stdio: 'ignore' });

  const info = await waitPort();
  const cdp = await cdpClient(await pageWs());

  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: DSF, mobile: false
  });

  const url = 'file://' + SRC;
  await cdp.send('Page.navigate', { url });
  await sleep(1800);   // 等图片和字体

  // 尺寸自检：海报必须正好 1080×1440，多一像素都会让二维码/排版偏移
  const probe = await cdp.send('Runtime.evaluate', {
    expression: `(function(){
      const p = document.querySelector('.poster').getBoundingClientRect();
      const q = document.querySelector('.qr-box img');
      const m = document.querySelector('.phone img');
      return JSON.stringify({
        w: Math.round(p.width), h: Math.round(p.height),
        qrLoaded: q ? q.complete && q.naturalWidth > 0 : null,
        phoneLoaded: m ? m.complete && m.naturalWidth > 0 : null,
        scroll: document.documentElement.scrollHeight
      });
    })()`,
    returnByValue: true
  });
  const info2 = JSON.parse(probe.result.value);
  console.log(`海报尺寸 ${info2.w}×${info2.h}（期望 ${W}×${H}）`);
  console.log(`二维码图 ${info2.qrLoaded ? '已加载 ✅' : '没加载 ❌'}`);
  console.log(`手机截图 ${info2.phoneLoaded ? '已加载 ✅' : '没加载 ❌'}`);
  if (info2.w !== W || info2.h !== H) throw new Error('尺寸不对，排版会错位');
  if (!info2.qrLoaded || !info2.phoneLoaded) throw new Error('有图片没加载出来');

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: W, height: H, scale: 1 }
  });

  const buf = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(OUT, buf);
  console.log(`✓ ${OUT}  ${(buf.length / 1024).toFixed(0)} KB  (${W * DSF}×${H * DSF})`);

  cdp.close();
  try { chrome.kill('SIGTERM'); } catch (e) {}
  await sleep(300);
  try { chrome.kill('SIGKILL'); } catch (e) {}
}

main().catch(async e => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
