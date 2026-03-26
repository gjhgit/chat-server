const http = require('http');
const https = require('https');
const zlib = require('zlib');
const net = require('net');
const dns = require('dns').promises;
const { URL } = require('url');
const WebSocket = require('ws');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'chat_secret_key_change_in_prod';
// Railway Volume 挂载在 /data，本地用当前目录
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'chat.db');

let db;

// 初始化数据库
async function initDB() {
  const SQL = await initSqlJs();
  
  // 如果已有数据文件，加载它；否则新建
  if (fs.existsSync(DB_PATH)) {
    const data = fs.readFileSync(DB_PATH);
    db = new SQL.Database(data);
    console.log(`📦 加载已有数据库: ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    console.log(`📦 创建新数据库: ${DB_PATH}`);
  }

  // 建表
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  
  saveDB();
}

// 保存数据库到文件
function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// 每30秒自动保存一次
setInterval(saveDB, 30000);

app.use(cors());
app.use(express.json());

// 网页版前端静态文件
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

// 图片上传目录（Railway Volume 持久化）
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 静态文件服务（上传的图片可直接通过 URL 访问）
app.use('/uploads', express.static(UPLOAD_DIR));

// multer 配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('只允许上传图片'));
  }
});

// 图片上传接口
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未接收到图片' });
  // 自动适配 Railway 域名 / 自定义 BASE_URL / cpolar
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const baseUrl = process.env.BASE_URL ||
    (railwayDomain ? `https://${railwayDomain}` : `http://localhost:${PORT}`);
  const url = `${baseUrl}/uploads/${req.file.filename}`;
  res.json({ url });
});

// 健康检查（前端由 express.static 托管，/ 路由仅作 API fallback）
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', db: 'sqlite(sql.js)', time: new Date().toISOString() });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ===== PING 接口 =====
// 通过 DNS 解析 + TCP 握手模拟 ping，返回延迟和多轮统计
app.post('/api/ping', async (req, res) => {
  let { host, count = 4, port = 80 } = req.body || {};
  host = (host || 'www.google.com').trim().replace(/^https?:\/\//i, '').split('/')[0];
  count = Math.max(1, Math.min(10, parseInt(count) || 4));
  port = parseInt(port) || 80;

  const results = [];
  let resolvedIp = null;

  // DNS 解析
  const dnsStart = Date.now();
  try {
    const addrs = await dns.resolve4(host);
    resolvedIp = addrs[0];
  } catch (e) {
    try {
      const addrs6 = await dns.resolve6(host);
      resolvedIp = addrs6[0];
    } catch {
      return res.json({
        host, ip: null, port,
        error: `DNS 解析失败: 无法找到主机 ${host}`,
        results: [], stats: null
      });
    }
  }
  const dnsMs = Date.now() - dnsStart;

  // 多轮 TCP 握手探测
  for (let i = 0; i < count; i++) {
    const start = Date.now();
    const result = await new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(3000);
      sock.connect(port, resolvedIp, () => {
        const ms = Date.now() - start;
        sock.destroy();
        resolve({ seq: i + 1, ms, success: true });
      });
      sock.on('timeout', () => {
        sock.destroy();
        resolve({ seq: i + 1, ms: null, success: false, error: '超时' });
      });
      sock.on('error', (err) => {
        sock.destroy();
        // 连接被拒绝也算通（主机可达，端口关闭），用往返时间
        if (err.code === 'ECONNREFUSED') {
          resolve({ seq: i + 1, ms: Date.now() - start, success: true, note: '端口关闭但可达' });
        } else {
          resolve({ seq: i + 1, ms: null, success: false, error: err.message });
        }
      });
    });
    results.push(result);
    // 每次探测间隔 200ms
    if (i < count - 1) await new Promise(r => setTimeout(r, 200));
  }

  const times = results.filter(r => r.success && r.ms !== null).map(r => r.ms);
  const lost = results.filter(r => !r.success).length;
  const stats = times.length > 0 ? {
    sent: count,
    received: times.length,
    lost,
    lossRate: ((lost / count) * 100).toFixed(0) + '%',
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    avgMs: (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1),
    dnsMs,
  } : {
    sent: count, received: 0, lost: count,
    lossRate: '100%', minMs: null, maxMs: null, avgMs: null, dnsMs,
  };

  res.json({ host, ip: resolvedIp, port, results, stats });
});

// ===== 内置浏览器代理接口 =====

// ---- HTTP/HTTPS Keep-Alive Agent（连接复用，大幅减少 TCP 握手开销）----
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 20, timeout: 12000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, timeout: 12000, rejectUnauthorized: false });

// ---- 页面内存缓存（LRU 简化版，最多 30 条，TTL 60s）----
const _pageCache = new Map();
const PAGE_CACHE_TTL = 60 * 1000;
const PAGE_CACHE_MAX = 30;

function _cacheSet(key, value) {
  if (_pageCache.size >= PAGE_CACHE_MAX) {
    // 删最旧的
    _pageCache.delete(_pageCache.keys().next().value);
  }
  _pageCache.set(key, { value, ts: Date.now() });
}
function _cacheGet(key) {
  const entry = _pageCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > PAGE_CACHE_TTL) { _pageCache.delete(key); return null; }
  return entry.value;
}

// ---- 资源内存缓存（最多 100 条，TTL 5分钟）----
const _resCache = new Map();
const RES_CACHE_TTL = 5 * 60 * 1000;
const RES_CACHE_MAX = 100;
function _resCacheSet(key, value) {
  if (_resCache.size >= RES_CACHE_MAX) _resCache.delete(_resCache.keys().next().value);
  _resCache.set(key, { value, ts: Date.now() });
}
function _resCacheGet(key) {
  const e = _resCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > RES_CACHE_TTL) { _resCache.delete(key); return null; }
  return e.value;
}

// ---- 并发请求去重（同一 URL 同时只发一次请求）----
const _inflight = new Map();

// ---- 解压响应体（支持 gzip / deflate / br）----
function _decompress(response) {
  const enc = (response.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip') return response.pipe(zlib.createGunzip());
  if (enc === 'deflate') return response.pipe(zlib.createInflate());
  if (enc === 'br') return response.pipe(zlib.createBrotliDecompress());
  return response;
}

// ---- 从 HTML/响应头中检测字符编码 ----
function _detectCharset(buf, contentType) {
  // 先从 Content-Type 头里找
  const ctMatch = (contentType || '').match(/charset=([^\s;]+)/i);
  if (ctMatch) return ctMatch[1].toLowerCase().replace('utf8', 'utf-8');
  // 再从 HTML meta 里找
  const snippet = buf.slice(0, 4096).toString('binary');
  const metaMatch = snippet.match(/charset=["']?([a-z0-9\-_]+)/i) ||
                    snippet.match(/content=["'][^"']*charset=([^"';\s]+)/i);
  if (metaMatch) return metaMatch[1].toLowerCase().replace('utf8', 'utf-8');
  return 'utf-8';
}

// ---- 核心抓取函数（带重定向跟随、压缩解码、超时）----
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function _fetchUrl(urlObj, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 6) return reject(new Error('重定向次数过多'));

    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      agent: isHttps ? httpsAgent : httpAgent,
      timeout: 12000,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0',
        'Upgrade-Insecure-Requests': '1',
      },
    };

    const reqObj = lib.request(options, (response) => {
      // 跟随重定向
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const loc = response.headers['location'];
        response.resume(); // 清空响应体
        if (loc) {
          try {
            return _fetchUrl(new URL(loc, urlObj.href), redirectCount + 1).then(resolve).catch(reject);
          } catch { return reject(new Error('重定向地址无效: ' + loc)); }
        }
      }

      const ct = (response.headers['content-type'] || '').toLowerCase();
      const sc = response.statusCode;

      // 非 HTML 类型
      if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
        response.resume();
        return resolve({ html: null, finalUrl: urlObj.href, contentType: ct, statusCode: sc });
      }

      const stream = _decompress(response);
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        const charset = _detectCharset(buf, ct);
        let html;
        try {
          html = buf.toString(charset === 'utf-8' ? 'utf8' : 'binary');
          // 如果是 latin-1/gbk 等，先拿 binary 再用 iconv 类似方式（简化处理：直接用 utf8）
          if (charset !== 'utf-8' && charset !== 'utf8') {
            // 简单回退：大多数网页 utf-8，GBK 的会乱码但不崩溃
            html = buf.toString('utf8');
          }
        } catch { html = buf.toString('utf8'); }
        resolve({ html, finalUrl: urlObj.href, contentType: ct, statusCode: sc });
      });
      stream.on('error', reject);
    });

    reqObj.on('timeout', () => { reqObj.destroy(); reject(new Error('请求超时（12s）')); });
    reqObj.on('error', reject);
    reqObj.end();
  });
}

// ---- HTML 注入与路径重写 ----
function _rewriteHtml(html, finalUrl) {
  const proxyRes = '/api/browse-res?url=';

  // 重写 src/href/action 中的绝对/相对 URL → 代理路径
  const rewrite = (val) => {
    if (!val) return val;
    val = val.trim();
    if (/^(javascript:|data:|#|mailto:|tel:|blob:)/i.test(val)) return val;
    try {
      const abs = new URL(val, finalUrl).href;
      // 仅代理同域或跨域资源（略过 data:）
      return proxyRes + encodeURIComponent(abs);
    } catch { return val; }
  };

  let out = html;

  // 重写 <img src>, <script src>, <link href>, <source src/srcset>
  out = out.replace(/(<img\b[^>]+\bsrc=)(["'])([^"']*)\2/gi,  (m, pre, q, v) => `${pre}${q}${rewrite(v)}${q}`);
  out = out.replace(/(<script\b[^>]+\bsrc=)(["'])([^"']*)\2/gi,(m, pre, q, v) => `${pre}${q}${rewrite(v)}${q}`);
  out = out.replace(/(<link\b[^>]+\bhref=)(["'])([^"']*)\2/gi, (m, pre, q, v) => `${pre}${q}${rewrite(v)}${q}`);
  out = out.replace(/(<source\b[^>]+\bsrc=)(["'])([^"']*)\2/gi,(m, pre, q, v) => `${pre}${q}${rewrite(v)}${q}`);

  // 注入 <base> 标签
  if (/<head[\s>]/i.test(out)) {
    out = out.replace(/(<head[^>]*>)/i, `$1<base href="${finalUrl}">`);
  } else {
    out = `<base href="${finalUrl}">` + out;
  }

  // 禁止表单跳转
  out = out.replace(/<form(\s[^>]*)?>/gi, (m, attrs) => `<form${attrs||''} onsubmit="return false;">`);

  // 注入点击劫持脚本（页内链接 → 内置浏览器导航）
  const injectScript = `<script>(function(){
var B=${JSON.stringify(finalUrl)};
document.addEventListener('click',function(e){
  var a=e.target.closest('a');
  if(!a)return;
  var h=a.getAttribute('href');
  if(!h||/^(javascript:|mailto:|tel:|#|data:)/i.test(h))return;
  e.preventDefault();
  try{var u=new URL(h,B).href;}catch(x){return;}
  window.parent.postMessage({type:'browse-navigate',url:u},'*');
},true);
})();</script>`;

  out = out.includes('</head>')
    ? out.replace('</head>', injectScript + '</head>')
    : out + injectScript;

  return out;
}

// POST /api/browse  — 主代理入口
app.post('/api/browse', async (req, res) => {
  let { url: targetUrl } = req.body || {};
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  let parsedUrl;
  try { parsedUrl = new URL(targetUrl); }
  catch { return res.status(400).json({ error: '无效的 URL: ' + targetUrl }); }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: '仅支持 http/https 协议' });
  }

  const cacheKey = parsedUrl.href;

  // 1. 命中页面缓存
  const cached = _cacheGet(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  // 2. 并发去重：同 URL 正在请求中，等它完成
  if (_inflight.has(cacheKey)) {
    try {
      const result = await _inflight.get(cacheKey);
      return res.json(result);
    } catch (e) {
      return res.json({ ok: false, error: e.message, finalUrl: targetUrl });
    }
  }

  // 3. 发起请求
  const fetchPromise = (async () => {
    const { html, finalUrl, contentType, statusCode } = await _fetchUrl(parsedUrl);

    if (html === null) {
      return {
        ok: false,
        error: `该地址返回的不是 HTML 页面（Content-Type: ${contentType}，HTTP ${statusCode}）`,
        finalUrl,
      };
    }

    const rewritten = _rewriteHtml(html, finalUrl);
    return { ok: true, html: rewritten, finalUrl, statusCode };
  })();

  _inflight.set(cacheKey, fetchPromise);

  try {
    const result = await fetchPromise;
    if (result.ok) _cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message, finalUrl: targetUrl });
  } finally {
    _inflight.delete(cacheKey);
  }
});

// GET /api/browse-frame  — 直接返回代理后的页面HTML（用于iframe src，解决CSP问题）
app.get('/api/browse-frame', async (req, res) => {
  const { url: targetUrl } = req.query;
  if (!targetUrl) return res.status(400).send('missing url');

  let parsedUrl;
  try { parsedUrl = new URL(targetUrl); } catch { return res.status(400).send('invalid url'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return res.status(400).send('protocol not allowed');

  const cacheKey = parsedUrl.href;
  const cached = _cacheGet(cacheKey);
  if (cached && cached.ok) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Cache', 'HIT');
    return res.send(cached.html);
  }

  try {
    const { html, finalUrl, contentType, statusCode } = await _fetchUrl(parsedUrl);
    if (html === null) {
      return res.status(400).send(`Not HTML: ${contentType}`);
    }
    const rewritten = _rewriteHtml(html, finalUrl);
    // 缓存
    _cacheSet(cacheKey, { ok: true, html: rewritten, finalUrl, statusCode });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Cache', 'MISS');
    res.send(rewritten);
  } catch (e) {
    res.status(502).send('Error: ' + e.message);
  }
});

// GET /api/browse-res  — 代理静态资源（图片、CSS、JS 等）
app.get('/api/browse-res', async (req, res) => {
  const { url: resourceUrl } = req.query;
  if (!resourceUrl) return res.status(400).send('missing url');

  let parsedUrl;
  try { parsedUrl = new URL(resourceUrl); } catch { return res.status(400).send('invalid url'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return res.status(400).send('protocol not allowed');

  // 资源缓存（图片/CSS/JS 缓存 5 分钟）
  const cacheKey = parsedUrl.href;
  const cachedRes = _resCacheGet(cacheKey);
  if (cachedRes) {
    res.setHeader('Content-Type', cachedRes.ct);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Cache', 'HIT');
    return res.send(cachedRes.buf);
  }

  const isHttps = parsedUrl.protocol === 'https:';
  const lib = isHttps ? https : http;
  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    agent: isHttps ? httpsAgent : httpAgent,
    timeout: 10000,
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    },
  };

  const doProxy = (urlStr, depth = 0) => {
    if (depth > 3) return res.status(400).send('too many redirects');
    let pu;
    try { pu = new URL(urlStr); } catch { return res.status(400).send('invalid url'); }

    const lib2 = pu.protocol === 'https:' ? https : http;
    const opt2 = {
      ...options,
      hostname: pu.hostname,
      port: pu.port || (pu.protocol === 'https:' ? 443 : 80),
      path: pu.pathname + pu.search,
      agent: pu.protocol === 'https:' ? httpsAgent : httpAgent,
    };

    const proxyReq = lib2.request(opt2, (proxyRes) => {
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
        const loc = proxyRes.headers['location'];
        proxyRes.resume();
        if (loc) return doProxy(new URL(loc, urlStr).href, depth + 1);
        return res.status(502).send('redirect without location');
      }

      const ct = proxyRes.headers['content-type'] || 'application/octet-stream';
      const isText = ct.includes('text/') || ct.includes('javascript') || ct.includes('json');

      // 超过 2MB 的资源不缓存，直接流式转发
      const cl = parseInt(proxyRes.headers['content-length'] || '0');
      const tooBig = cl > 2 * 1024 * 1024;

      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (tooBig) {
        const stream = _decompress(proxyRes);
        stream.pipe(res);
        return;
      }

      const stream = _decompress(proxyRes);
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        _resCacheSet(cacheKey, { buf, ct });
        res.send(buf);
      });
      stream.on('error', (e) => res.status(502).send('decompress error: ' + e.message));
    });

    proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).send('timeout'); });
    proxyReq.on('error', (e) => res.status(502).send('proxy error: ' + e.message));
    proxyReq.end();
  };

  doProxy(parsedUrl.href);
});

// 注册（兼容 /register 和 /api/register）
async function handleRegister(req, res) {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '缺少用户名或密码' });

  try {
    const exists = db.exec(`SELECT id FROM users WHERE username = '${username.replace(/'/g, "''")}'`);
    if (exists.length > 0 && exists[0].values.length > 0) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    const hash = bcrypt.hashSync(password, 10);
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hash]);
    saveDB();
    
    const row = db.exec(`SELECT id FROM users WHERE username = '${username.replace(/'/g, "''")}'`);
    const id = row[0].values[0][0];
    const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '30d' });
    // 返回 Flutter 客户端期望的格式：{ success, token, user: {id, username} }
    res.json({ success: true, token, user: { id: String(id), username } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
app.post('/register', handleRegister);
app.post('/api/register', handleRegister);

// 登录（兼容 /login 和 /api/login）
async function handleLogin(req, res) {
  const { username, password } = req.body;
  try {
    const result = db.exec(`SELECT id, username, password FROM users WHERE username = '${username.replace(/'/g, "''")}'`);
    if (!result.length || !result[0].values.length) {
      return res.status(401).json({ success: false, error: '用户名或密码错误' });
    }
    const [id, uname, hash] = result[0].values[0];
    if (!bcrypt.compareSync(password, hash)) {
      return res.status(401).json({ success: false, error: '用户名或密码错误' });
    }
    const token = jwt.sign({ id, username: uname }, JWT_SECRET, { expiresIn: '30d' });
    // 返回 Flutter 客户端期望的格式：{ success, token, user: {id, username} }
    res.json({ success: true, token, user: { id: String(id), username: uname } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
app.post('/login', handleLogin);
app.post('/api/login', handleLogin);

// 获取用户列表（兼容有/无 token，URL 里的 userId 参数用于排除自己）
function handleGetUsers(req, res) {
  // 优先用 JWT 里的 id，其次用 URL 参数，都没有就返回全部
  const excludeId = (req.user && req.user.id) || req.params.userId || null;
  const sql = excludeId
    ? `SELECT id, username FROM users WHERE id != ${excludeId}`
    : `SELECT id, username FROM users`;
  const result = db.exec(sql);
  if (!result.length) return res.json({ users: [] });
  const users = result[0].values.map(row => ({
    id: String(row[0]), username: row[1]
  }));
  res.json({ users });
}

// 可选鉴权中间件（有 token 就解析，没有也放行）
function optionalToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (auth) {
    try { req.user = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET); } catch {}
  }
  next();
}

app.get('/users', optionalToken, handleGetUsers);
app.get('/users/:userId', optionalToken, handleGetUsers);
app.get('/api/users', optionalToken, handleGetUsers);
app.get('/api/users/:userId', optionalToken, handleGetUsers);

// 获取历史消息（兼容 /messages/:userId 和 /api/messages/:userId/:targetId）
function handleGetMessages(req, res) {
  const targetId = String(req.params.targetId || '0');
  const myId = String(req.params.userId || (req.user && req.user.id) || '0');
  const result = db.exec(`
    SELECT m.id, m.sender_id, m.receiver_id, m.content, m.created_at, u.username as sender_name
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE (m.sender_id = ${myId} AND m.receiver_id = ${targetId})
       OR (m.sender_id = ${targetId} AND m.receiver_id = ${myId})
    ORDER BY m.created_at ASC
    LIMIT 100
  `);
  if (!result.length) return res.json({ messages: [] });
  const msgs = result[0].values.map(row => {
    // 兼容 ISO 时间字符串转 Unix 秒
    let createdAt = row[4];
    if (typeof createdAt === 'string') {
      createdAt = Math.floor(new Date(createdAt).getTime() / 1000);
    }
    return {
      id: String(row[0]),
      from_user: String(row[1]),
      to_user: String(row[2]),
      content: row[3],
      created_at: createdAt,
      from_username: row[5],
    };
  });
  res.json({ messages: msgs });
}
// messages 路由：userId = 自己, targetId = 对方（URL 里已有，不需要 token）
app.get('/messages/:userId/:targetId', optionalToken, handleGetMessages);
app.get('/api/messages/:userId/:targetId', optionalToken, handleGetMessages);

function verifyToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: '未授权' });
  try {
    req.user = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token 无效' });
  }
}

// WebSocket 服务
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

wss.on('connection', (ws) => {
  let userId = null;
  let username = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // 支持两种 auth：token 方式 或 直接 userId/username 方式
    if (data.type === 'auth') {
      if (data.token) {
        try {
          const user = jwt.verify(data.token, JWT_SECRET);
          userId = String(user.id);
          username = user.username;
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Token 无效' }));
          ws.close();
          return;
        }
      } else if (data.userId) {
        userId = String(data.userId);
        username = data.username || userId;
      } else {
        ws.send(JSON.stringify({ type: 'error', message: '缺少认证信息' }));
        ws.close();
        return;
      }
      if (clients.has(userId)) {
        try { clients.get(userId).close(); } catch {}
      }
      clients.set(userId, ws);
      ws.send(JSON.stringify({ type: 'auth_ok', userId }));
      console.log(`用户 ${username}(${userId}) 上线，在线: ${clients.size}`);
      return;
    }

    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (!userId) return;

    // 支持两种消息格式：send_message(Flutter) 和 message(旧)
    if (data.type === 'send_message' || data.type === 'message') {
      const toUserId = String(data.toUserId || data.receiverId || '');
      const content = data.content || '';
      const msgType = data.msgType || 'text';
      if (!toUserId || !content) return;

      db.run(`INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)`,
        [userId, toUserId, content]);
      saveDB();

      const msgId = db.exec(`SELECT last_insert_rowid()`)[0].values[0][0];
      const createdAt = Math.floor(Date.now() / 1000);

      // 统一用 Flutter 期望的字段名
      const msg = {
        type: 'new_message',
        id: String(msgId),
        fromUserId: userId,
        toUserId,
        content,
        msgType,
        createdAt,
        fromUsername: username,
      };

      // 推送给接收方
      if (clients.has(toUserId)) {
        clients.get(toUserId).send(JSON.stringify(msg));
      }
      // 推送回发送方（确认）
      ws.send(JSON.stringify({ ...msg, type: 'message_sent' }));
    }
  });

  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
      console.log(`用户 ${userId} 下线，在线: ${clients.size}`);
    }
  });
});

// 心跳
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// 启动
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ 聊天服务器启动！端口: ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
  });
});
