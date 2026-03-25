const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'chat_secret_key_change_in_prod';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'chat.db');

// 初始化 SQLite 数据库
const db = new Database(DB_PATH);

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (receiver_id) REFERENCES users(id)
  );
`);

app.use(cors());
app.use(express.json());

// 健康检查
app.get('/', (req, res) => {
  res.json({ status: 'ok', db: 'sqlite', time: new Date().toISOString() });
});

// 注册
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '缺少用户名或密码' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
    const result = stmt.run(username, hash);
    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username, id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: '用户名已存在' });
    res.status(500).json({ error: e.message });
  }
});

// 登录
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, id: user.id });
});

// 获取用户列表
app.get('/users', verifyToken, (req, res) => {
  const users = db.prepare('SELECT id, username FROM users WHERE id != ?').all(req.user.id);
  res.json(users);
});

// 获取历史消息
app.get('/messages/:userId', verifyToken, (req, res) => {
  const { userId } = req.params;
  const msgs = db.prepare(`
    SELECT m.*, u.username as sender_name
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE (m.sender_id = ? AND m.receiver_id = ?)
       OR (m.sender_id = ? AND m.receiver_id = ?)
    ORDER BY m.created_at ASC
    LIMIT 100
  `).all(req.user.id, userId, userId, req.user.id);
  res.json(msgs);
});

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

const clients = new Map(); // userId -> ws

wss.on('connection', (ws, req) => {
  let userId = null;

  // 心跳
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'auth') {
      try {
        const user = jwt.verify(data.token, JWT_SECRET);
        userId = user.id;
        // 踢出旧连接
        if (clients.has(userId)) {
          const old = clients.get(userId);
          old.close();
        }
        clients.set(userId, ws);
        ws.send(JSON.stringify({ type: 'auth_ok', userId }));
        console.log(`用户 ${user.username}(${userId}) 已连接，当前在线: ${clients.size}`);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Token 无效' }));
        ws.close();
      }
      return;
    }

    if (!userId) return;

    if (data.type === 'message') {
      const { receiverId, content } = data;
      if (!receiverId || !content) return;

      // 保存到数据库
      const stmt = db.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)');
      const result = stmt.run(userId, receiverId, content);

      const msg = {
        type: 'message',
        id: result.lastInsertRowid,
        sender_id: userId,
        receiver_id: receiverId,
        content,
        created_at: new Date().toISOString()
      };

      // 推送给接收方
      if (clients.has(receiverId)) {
        clients.get(receiverId).send(JSON.stringify(msg));
      }
      // 回显给发送方
      ws.send(JSON.stringify({ ...msg, type: 'message_sent' }));
    }
  });

  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
      console.log(`用户 ${userId} 已断开，当前在线: ${clients.size}`);
    }
  });
});

// 心跳检测（30秒一次）
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`✅ 聊天服务器启动成功！端口: ${PORT}`);
  console.log(`📦 数据库: ${DB_PATH}`);
  console.log(`🌐 健康检查: http://localhost:${PORT}`);
});
