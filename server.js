const http = require('http');
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

// 健康检查
app.get('/', (req, res) => {
  res.json({ status: 'ok', db: 'sqlite(sql.js)', time: new Date().toISOString() });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
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
