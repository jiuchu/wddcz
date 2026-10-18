/* 百度指数重采 —— 由 GitHub Actions 每天跑一次，产出 baidu-index.json 供 index.html 读取。
 *
 * 为什么必须有一个真浏览器： getIndex 请求头里的 Cipher-Text 是百度黑茶风控 SDK
 * （Paris, sid=2057）的 getSign() 现场算出来的，bundle 里没有可离线复刻的对称密钥，
 * 只有 Chrome 里跑得出来。拿到签名之后其余都是普通 HTTP：
 *
 *   GET /Interface/Newwordgraph/getIndex?region=0&startdate=&enddate=&wordlist[0]=
 *       headers: Cipher-Text: <sign>          → {status:0, uniqid, data[0].index[0].{_all,period}}
 *   GET /Interface/api/ptbk?uniqid=<uniqid>   → {status:0, data:"<30 字符>"}
 *   _all 是单表替换密文：data 前 15 位是密文字母表、后 15 位是明文字母表。
 *
 * 需要两个 Secret（都在 Actions secrets 里，不会进仓库）：
 *   BDUSS   百度账号 Cookie，你的账号不重要，但它只该出现在 Secret 里
 *   仓库 Settings → Actions → General → Workflow permissions 需要 "Read and write"
 *   （或者靠 yml 里的 permissions 声明，二者取其一）
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const WORD = process.env.BAIDU_WORD || '伟大的长征';
const DAYS = Number(process.env.BAIDU_DAYS || 90);
const OUT = process.env.BAIDU_OUT || 'baidu-index.json';
const BDUSS = process.env.BDUSS;
/* 探测模式：不带任何凭据，只看当前机器的 IP + 无头浏览器能不能走到"no login"这一步。
 * 用来单独回答"GitHub 机房 IP 会不会被 10018 风控"，跑通后再加 BDUSS。 */
const PROBE = process.env.BAIDU_PROBE === '1';
if (!BDUSS && !PROBE) { console.error('::error::缺少 BDUSS secret'); process.exit(2); }

/* 百度指数 T+1，且按北京时间出账；用 UTC 日期会差一天。
 * cnDate 给 JSON/前端用（带横杠），cnYmd 给接口参数用（不带）—— 别拿一个比另一个。 */
const cnDate = o => new Date(Date.now() + o * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
const cnYmd = o => cnDate(o).replace(/-/g, '');

function decrypt(ptbk, cipher) {
  const n = ptbk.length >> 1;
  if (n * 2 !== ptbk.length) throw new Error('ptbk 长度异常: ' + ptbk);
  const map = new Map();
  for (let i = 0; i < n; i++) map.set(ptbk[i], ptbk[n + i]);
  let out = '';
  for (const c of cipher) out += map.has(c) ? map.get(c) : ',';
  return out;
}

/* 百度官方每天 12~16 时出昨天的数，所以 workflow 一小时跑一次、连跑好几个整点。
 * 一旦本地这份已经是"昨天"的数，就直接退出：既省一次无头浏览器，
 * 也避免同一个内容反复 commit 触发 Pages 重建（公开仓库软限制约 10 次/小时）。
 * 探测模式不跳过，否则没法用同一份文件反复测 IP。 */
if (!PROBE && fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (prev.asof === cnDate(-1)) {
      console.log(`已是最新（asof=${prev.asof}），跳过本次抓取`);
      process.exit(0);
    }
  } catch { /* 文件坏了就重抓 */ }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ ...devices['iPhone 13'] });
if (BDUSS) await context.addCookies([{ name: 'BDUSS', value: BDUSS, domain: '.baidu.com', path: '/' }]);
const page = await context.newPage();

/* 被动兜底：万一 Paris 路径不通，就用页面自己发出的那对请求 */
const captured = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!/getIndex|ptbk/.test(u)) return;
  try { captured.push({ url: u, body: await res.text() }); } catch { /* 流已被消费 */ }
});

try {
  await page.goto('https://index.baidu.com/baidu-index-mobile/?from=pinzhuan#/compare/' +
                  encodeURIComponent(WORD), { waitUntil: 'domcontentloaded', timeout: 90000 });

  const end = cnYmd(0), start = cnYmd(1 - DAYS);
  let payload = null;

  try {
    await page.waitForFunction(() => typeof window.Paris === 'object' && window.Paris !== null,
                               { timeout: 20000 });
    payload = await page.evaluate(async ({ start, end, word }) => {
      const sign = () => new Promise((res) => {
        if (typeof Paris.getAcsInstance !== 'function') return res('NONE');
        Paris.getAcsInstance((a, n) => {
          if (a || !n) return res('NONE');
          n.getSign((e, s) => res(e ? 'NONE' : s));
        });
      });
      const ct = await sign();
      const H = { 'X-Requested-With': 'XMLHttpRequest', 'Cipher-Text': ct };
      const gi = await fetch(`/Interface/Newwordgraph/getIndex?region=0&startdate=${start}` +
                             `&enddate=${end}&wordlist%5B0%5D=${encodeURIComponent(word)}`,
                             { headers: H });
      const gj = await gi.json();
      if (gj.status !== 0) return { fail: 'getIndex ' + gj.status + ' ' + (gj.message || ''),
                                    status: gj.status, msg: gj.message };
      const pj = await (await fetch('/Interface/api/ptbk?uniqid=' + gj.uniqid, { headers: H })).json();
      if (pj.status !== 0) return { fail: 'ptbk ' + pj.status };
      return { node: gj.data[0].index[0], key: pj.data };
    }, { start, end, word: WORD });
  } catch (e) {
    console.warn('Paris 直取失败：' + e.message + '，改用页面自身请求');
    await page.getByText('近90天').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const gi = captured.filter(x => x.url.includes('getIndex')).pop();
    const pt = captured.filter(x => x.url.includes('ptbk')).pop();
    if (!gi || !pt) throw new Error(' getIndex 未被页面触发，兜底也失败');
    const gj = JSON.parse(gi.body), pj = JSON.parse(pt.body);
    if (gj.status !== 0) throw new Error('兜底 getIndex status ' + gj.status);
    payload = { node: gj.data[0].index[0], key: pj.data };
  }

  if (PROBE) {
    await browser.close();
    if (payload.status === 10000) {
      console.log('PROBE OK · 签名被接受，本机 IP 未被风控（探测模式不带 BDUSS，no login 是预期的）');
      process.exit(0);
    }
    console.error('::error::PROBE FAIL · status=' + payload.status + ' ' + (payload.msg || ''));
    process.exit(3);
  }
  if (payload.fail) throw new Error(payload.fail);

  const [s, e2] = payload.node.period.split('|');
  const vals = decrypt(payload.key, payload.node._all).split(',').map(Number);
  let cur = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const all = vals.map((v, i) => ({ date: new Date(cur + i * 864e5).toISOString().slice(0, 10), index: v }));
  const rows = all.filter(x => x.index > 0).map(x => [x.date.slice(5), x.index]);
  if (!rows.length) throw new Error('全零：BDUSS 可能已失效，或被 10018 风控');
  const asof = all.filter(x => x.index > 0).pop().date;

  const now = new Date().toISOString();
  const body = { ok: true, word: WORD, asof, rows, fetchedAt: now, region: '全国', lastRun: now };
  /* 百度还没出昨天的数时 asof 会停在更早一天。以前"asof 未前进就不写文件"，
     副作用是 fetchedAt 和"我们到底还在不在采"这件事一起冻住了 —— 面板上看不出来。
     现在数据照旧冻结，只把 lastRun 往前推一格：fetchedAt 是"这份数几时的"，
     lastRun 是"最后一次真去采是几时的"，两个各说各的。
     代价：真跑的每一趟一个 commit、一次 Pages 重建。半小时一格摊下来约 2 次/小时，
     离公共仓库约 10 次/小时的软限制还远；哪天调到 5 分钟要重新算。
     ⚠ 上面那句"已是最新就跳过"的守卫不动 —— 出数之后的那些格子仍然十几秒收工、不写不提交。 */
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 没有或读不懂就整份照写 */ }
  if (prev && prev.rows && prev.rows.length && String(prev.asof || '') >= asof) {
    body.asof = prev.asof; body.rows = prev.rows; body.fetchedAt = prev.fetchedAt || now;
    console.log(`没有新数（百度侧最新仍是 ${asof}），数据保持 ${body.asof}，只更新 lastRun`);
  }
  fs.writeFileSync(OUT, JSON.stringify(body));
  console.log(`OK  ${asof}  非零 ${rows.length} 天  最新 ${rows[rows.length - 1][1]}  ` +
              `峰值 ${Math.max(...rows.map(r => r[1]))}  lastRun ${now}`);
  console.log(JSON.stringify(body));
} finally {
  await browser.close();
}
