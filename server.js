/**
 * 聊天服务器 - Node.js + WebSocket + PostgreSQL
 * 支持公网部署（Railway / Render / Fly.io）
 * 数据持久化，重启不丢数据
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==================== PostgreSQL 连接 ====================
// Railway 自动注入 DATABASE_URL 环境变量
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[pg] 连接池错误:', err.message);
});

// ==================== 初始化数据库表 ====================
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT DEFAULT '',
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_user TEXT NOT NULL REFERENCES users(id),
        to_user TEXT NOT NULL REFERENCES users(id),
        content TEXT NOT NULL,
        type TEXT DEFAULT 'text',
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_users
        ON messages (from_user, to_user, created_at DESC);
    `);
    console.log('[db] 数据库表初始化完成');
  } finally {
    client.release();
  }
}

// ==================== 在线用户管理 ====================
const onlineUsers = new Map(); // userId -> WebSocket

// ==================== 健康检查 ====================
app.get('/', async (req, res) => {
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch {}
  res.json({
    status: 'ok',
    service: '聊天服务器',
    online: onlineUsers.size,
    db: dbOk ? 'connected' : 'error',
    time: new Date().toISOString()
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ==================== HTTP 接口 ====================

// 注册
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20)
    return res.status(400).json({ error: '用户名长度为2-20位' });
  if (password.length < 6)
    return res.status(400).json({ error: '密码至少6位' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0)
      return res.status(400).json({ error: '用户名已存在' });

    const hashedPwd = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    await pool.query(
      'INSERT INTO users (id, username, password) VALUES ($1, $2, $3)',
      [userId, username, hashedPwd]
    );
    res.json({ success: true, user: { id: userId, username } });
  } catch (e) {
    console.error('[register]', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: '用户名和密码不能为空' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: '用户名或密码错误' });
    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户列表
app.get('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, username FROM users WHERE id != $1 ORDER BY username',
      [userId]
    );
    res.json({
      users: result.rows.map(u => ({ ...u, online: onlineUsers.has(u.id) }))
    });
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取历史消息
app.get('/api/messages/:userId/:targetId', async (req, res) => {
  const { userId, targetId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const result = await pool.query(`
      SELECT m.*, u.username as from_username
      FROM messages m
      JOIN users u ON m.from_user = u.id
      WHERE (m.from_user = $1 AND m.to_user = $2)
         OR (m.from_user = $2 AND m.to_user = $1)
      ORDER BY m.created_at DESC
      LIMIT $3
    `, [userId, targetId, limit]);
    res.json({ messages: result.rows.reverse() });
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== WebSocket ====================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let currentUserId = null;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' })); return; }

    switch (msg.type) {
      case 'auth': {
        const { userId, username } = msg;
        if (!userId) { ws.send(JSON.stringify({ type: 'error', message: '认证失败' })); return; }

        // 踢掉旧连接
        const old = onlineUsers.get(userId);
        if (old && old !== ws) {
          try { old.send(JSON.stringify({ type: 'kicked', message: '已在其他设备登录' })); old.close(); } catch {}
        }

        currentUserId = userId;
        onlineUsers.set(userId, ws);
        ws.send(JSON.stringify({ type: 'auth_ok', userId, username }));
        broadcast({ type: 'user_online', userId, username }, userId);
        console.log(`[online] ${username} (${userId}) from ${clientIp}`);
        break;
      }

      case 'send_message': {
        if (!currentUserId) { ws.send(JSON.stringify({ type: 'error', message: '未认证' })); return; }
        const { toUserId, content, msgType = 'text' } = msg;
        if (!toUserId || !content?.trim()) { ws.send(JSON.stringify({ type: 'error', message: '消息参数缺失' })); return; }
        if (content.length > 2000) { ws.send(JSON.stringify({ type: 'error', message: '消息过长' })); return; }

        const msgId = uuidv4();
        const now = Math.floor(Date.now() / 1000);
        const trimmed = content.trim();

        try {
          await pool.query(
            'INSERT INTO messages (id, from_user, to_user, content, type, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [msgId, currentUserId, toUserId, trimmed, msgType, now]
          );
        } catch (e) {
          console.error('[send_message db]', e.message);
          ws.send(JSON.stringify({ type: 'error', message: '消息存储失败' }));
          return;
        }

        // 查发送者用户名
        let fromUsername = '未知';
        try {
          const r = await pool.query('SELECT username FROM users WHERE id = $1', [currentUserId]);
          fromUsername = r.rows[0]?.username || '未知';
        } catch {}

        const payload = {
          id: msgId,
          fromUserId: currentUserId,
          fromUsername,
          toUserId,
          content: trimmed,
          msgType,
          createdAt: now
        };

        // 推给对方
        const targetWs = onlineUsers.get(toUserId);
        if (targetWs?.readyState === WebSocket.OPEN)
          targetWs.send(JSON.stringify({ ...payload, type: 'new_message' }));

        // 回执给自己
        ws.send(JSON.stringify({ ...payload, type: 'message_sent' }));
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', async () => {
    if (currentUserId) {
      onlineUsers.delete(currentUserId);
      try {
        const r = await pool.query('SELECT username FROM users WHERE id = $1', [currentUserId]);
        const username = r.rows[0]?.username || '';
        broadcast({ type: 'user_offline', userId: currentUserId, username }, currentUserId);
      } catch {}
      console.log(`[offline] ${currentUserId}`);
    }
  });

  ws.on('error', (err) => console.error('[ws error]', err.message));
});

// 心跳检测（30s，防僵尸连接）
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

function broadcast(data, excludeUserId) {
  const payload = JSON.stringify(data);
  onlineUsers.forEach((ws, uid) => {
    if (uid !== excludeUserId && ws.readyState === WebSocket.OPEN)
      ws.send(payload);
  });
}

// ==================== 启动 ====================
async function main() {
  try {
    await initDb();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ 聊天服务器启动: http://0.0.0.0:${PORT}`);
      console.log(`   WebSocket: ws://0.0.0.0:${PORT}`);
      console.log(`   环境: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   数据库: ${process.env.DATABASE_URL ? 'PostgreSQL (云端)' : '⚠️ 未配置 DATABASE_URL'}`);
    });
  } catch (e) {
    console.error('❌ 启动失败:', e.message);
    process.exit(1);
  }
}

main();
