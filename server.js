require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;
const jwt = require('jsonwebtoken')
app.use(express.json({ limit: '50mb' }));
const poolConfig = {
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT || 5432,
  ssl: {
    rejectUnauthorized: false,
    require: true
  }
};

const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: privateKey
  })
});


const pool = new Pool(poolConfig);

// Улучшенная проверка подключения
async function checkDatabaseConnection() {
  let client;
  try {
    client = await pool.connect();
    const res = await client.query('SELECT NOW()');
    console.log('✅ Подключение успешно. Время в БД:', res.rows[0].now);
    return true;
  } catch (err) {
    console.error('❌ Ошибка подключения:', {
      message: err.message,
      code: err.code,
      stack: err.stack
    });
    
    console.log('Используемые параметры:', {
      host: process.env.PG_HOST,
      user: process.env.PG_USER,
      database: process.env.PG_DATABASE,
      port: process.env.PG_PORT
    });
    
    return false;
  } finally {
    if (client) client.release();
  }
}

// Создание таблиц с обработкой ошибок
async function createTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comics (
        id TEXT PRIMARY KEY,
        text TEXT,
        description TEXT,
        creator TEXT,
        hash TEXT
      );
      
      CREATE TABLE IF NOT EXISTS pages (
        pageId TEXT PRIMARY KEY,
        comicsId TEXT REFERENCES comics(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        columns INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS image (
        id TEXT PRIMARY KEY,
        pageId TEXT REFERENCES pages(pageId) ON DELETE CASCADE,
        cellIndex INTEGER,
        image BYTEA NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        login TEXT,
        password TEXT,
        name TEXT,
        avatar BYTEA
      );
      
      CREATE TABLE IF NOT EXISTS login_attempts (
        login TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt TIMESTAMP WITH TIME ZONE,
        blocked_until TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS likes (
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        comic_id TEXT REFERENCES comics(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, comic_id)
      );
      
      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        comic_id TEXT REFERENCES comics(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, comic_id)
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        comic_id TEXT REFERENCES comics(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        subscriber_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (subscriber_id, target_user_id)
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        fcm_token TEXT,
        notifications_enabled BOOLEAN DEFAULT true
);
    `);
    console.log('✅ Таблицы созданы/проверены');
  } catch (err) {
    console.error('❌ Ошибка создания таблиц:', err.message);
  }
}
async function addHashColumnIfNotExists() {
  try {
    await pool.query(`
      ALTER TABLE comics 
      ADD COLUMN IF NOT EXISTS hash TEXT;
    `);
    console.log('✅ Колонка hash проверена/добавлена');
  } catch (err) {
    console.error('❌ Ошибка добавления колонки hash:', err.message);
  }
}
async function trackFailedAttempt(login) {
  const client = await pool.connect();
  try {
      await client.query('BEGIN');
      const result = await client.query(
          `INSERT INTO login_attempts (login, attempts, last_attempt)
           VALUES ($1, 1, NOW())
           ON CONFLICT (login) 
           DO UPDATE SET attempts = login_attempts.attempts + 1, last_attempt = NOW()
           RETURNING attempts`,
          [login]
      );
      
      const attempts = result.rows[0].attempts;
      if (attempts >= 5) {
          await client.query(
              `UPDATE login_attempts 
               SET blocked_until = NOW() + INTERVAL '1 minute'
               WHERE login = $1`,
              [login]
          );
      }
      
      await client.query('COMMIT');
  } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error tracking failed attempt:', err);
  } finally {
      client.release();
  }
}


app.use(async (req, res, next) => {
  if (req.path === '/api/user/auth' || req.path === '/api/user/register' || req.path === '/health') {
    return next();
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }

  const parts = authHeader.split(' ');
  
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ message: 'Authorization format should be: Bearer [token]' });
  }

  const token = parts[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Token not provided' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    if (!payload || !payload.id) {
      return res.status(401).json({ message: 'Invalid token payload' });
    }

    const result = await pool.query('SELECT * FROM users WHERE id = $1', [payload.id]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token' });
    }
    
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    
    return res.status(500).json({ message: 'Authentication failed' });
  }
});

app.post('/api/user/auth', async(req, res) => {
  try {
      const { login, password } = req.body;
      if (!login || !password) {
          return res.status(400).json({ message: 'Login and password are required' });
      }
      const loginAttemptsKey = `login_attempts:${login}`;
      const isBlocked = await pool.query(
          'SELECT blocked_until FROM login_attempts WHERE login = $1 AND blocked_until > NOW()',
          [login]
      );

      if (isBlocked.rows.length > 0) {
          const blockedUntil = new Date(isBlocked.rows[0].blocked_until);
          const remainingTime = Math.ceil((blockedUntil - new Date()) / 1000);
          return res.status(429).json({ 
              message: `Too many attempts. Try again in ${remainingTime} seconds.`
          });
      }

      const result = await pool.query('SELECT * FROM users WHERE login = $1', [login]);
      if (result.rows.length === 0) {
          await trackFailedAttempt(login);
          return res.status(404).json({ message: 'User not found' });
      }

      const user = result.rows[0];
      if (user.password !== password) {
          await trackFailedAttempt(login);
          return res.status(401).json({ message: 'Invalid password' });
      }
      await pool.query(
          'DELETE FROM login_attempts WHERE login = $1',
          [login]
      );

      const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
      
      return res.status(200).json({
          name: user.name,
          token: token
      });
  }
  catch(err) {
      console.error('Auth error:', err);
      return res.status(500).json({ message: 'Authentication failed' });
  }
});

app.post('/api/user/register', async (req, res) => {
  const { login, password, name } = req.body;
  if (!login || !password || !name) {
    return res
      .status(400)
      .json({ message: 'Login, password and name are required' });
  }
  
  try {
    // Check if user exists
    const result = await pool.query('SELECT id FROM users WHERE login = $1', [login]);
    
    if (result.rows.length > 0) {
      return res
        .status(409)
        .json({ message: 'User already exists' });
    }
    
    // Create new user
    const id = crypto.randomUUID(); 
    await pool.query(
      'INSERT INTO users (id, login, password, name) VALUES ($1, $2, $3, $4)',
      [id, login, password, name]
    );
    
    // Return response with new user's info
    return res.status(200).json({
      name: name,  // Use the name from the request, not undefined 'user'
      token: jwt.sign({ id: id }, process.env.JWT_SECRET),
    });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ message: 'Registration failed' });
  }
});

app.put('/api/user/name', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ message: 'Name is required' });
  }

  if (name.length > 50) {
    return res.status(400).json({ message: 'Name is too long (max 50 characters)' });
  }

  try {
    await pool.query(
      'UPDATE users SET name = $1 WHERE id = $2',
      [name, req.user.id]
    );

    res.status(200).json({ 
      message: 'Name changed successfully',
      newName: name
    });
  } catch (err) {
    console.error('Error changing name:', err);
    res.status(500).json({ message: 'Error changing name' });
  }
});

app.put('/api/user/password', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Current and new password are required' });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({ message: 'New password must be different from current password' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const userCheck = await client.query(
      'SELECT password FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (userCheck.rows[0].password !== currentPassword) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    await client.query(
      'UPDATE users SET password = $1 WHERE id = $2',
      [newPassword, req.user.id]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Password changed successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error changing password:', err);
    res.status(500).json({ message: 'Error changing password' });
  } finally {
    client.release();
  }
});


app.get('/api/user', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  try {
    const result = await pool.query(
      'SELECT id, login, name, encode(avatar, \'base64\') as avatar FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = result.rows[0];
    res.status(200).json({
      id: user.id,
      login: user.login,
      name: user.name,
      avatar: user.avatar || null
    });
  } catch (err) {
    console.error('Error getting user info:', err);
    res.status(500).json({ message: 'Error getting user info' });
  }
});

app.delete('/api/comics/:id', async(req,res) => {
  if (req.user) {
  const { id } = req.params
  const client = await pool.connect()
    try {
      const creatorCheck = await client.query(
        'SELECT creator FROM comics WHERE id = $1',
        [id]
      );
  
      if (creatorCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Комикс не найден' });
      }
  
      if (creatorCheck.rows[0].creator !== req.user.id) {
        return res.status(403).json({ message: 'Недостаточно прав для удаления' });
      }
      await client.query('DELETE FROM comics WHERE id = $1', [id])
      res.status(200).json({"status" : "success"})
    }
    catch (err) {
      res.status(500).json({"status" : "error"})
    }
}
else {
return res
    .status(401)
    .json({ message: 'Not authorized' })}
}
)


app.get('/api/comics', async(req, res) => {
  try {
      // Получаем все комиксы
      const comicsResult = await pool.query('SELECT id, text, description FROM comics');
      
      // Для каждого комикса находим первую картинку
      const comicsWithImages = await Promise.all(
          comicsResult.rows.map(async (comic) => {
              // Находим первую страницу комикса
              const firstPageResult = await pool.query(
                  'SELECT pageid FROM pages WHERE comicsid = $1 ORDER BY number ASC LIMIT 1',
                  [comic.id]
              );
              
              let imageBase64 = null;
              
              if (firstPageResult.rows.length > 0) {
                  const pageId = firstPageResult.rows[0].pageid;
                  
                  // Находим первую картинку на странице (сортировка по cellIndex)
                  const firstImageResult = await pool.query(
                      'SELECT encode(image, \'base64\') as image FROM image WHERE pageid = $1 ORDER BY cellindex ASC LIMIT 1',
                      [pageId]
                  );
                  
                  if (firstImageResult.rows.length > 0) {
                      imageBase64 = firstImageResult.rows[0].image;
                  }
              }
              
              return {
                  id: comic.id,
                  text: comic.text,
                  description: comic.description,
                  image: imageBase64
              };
          })
      );
      
      res.status(200).json(comicsWithImages);
  }
  catch (err) {
      console.error('Ошибка получения списка комиксов:', err);
      res.status(500).json({
          error: "Ошибка получения списка комиксов"
      });
  }
});

app.get('/api/mycomics', async(req, res) => {
  try {
      // Получаем все комиксы
      const comicsResult = await pool.query('SELECT id, text, description FROM comics WHERE creator = $1', [req.user.id]);
      
      // Для каждого комикса находим первую картинку
      const comicsWithImages = await Promise.all(
          comicsResult.rows.map(async (comic) => {
              // Находим первую страницу комикса
              const firstPageResult = await pool.query(
                  'SELECT pageid FROM pages WHERE comicsid = $1 ORDER BY number ASC LIMIT 1',
                  [comic.id]
              );
              
              let imageBase64 = null;
              
              if (firstPageResult.rows.length > 0) {
                  const pageId = firstPageResult.rows[0].pageid;
                  
                  // Находим первую картинку на странице (сортировка по cellIndex)
                  const firstImageResult = await pool.query(
                      'SELECT encode(image, \'base64\') as image FROM image WHERE pageid = $1 ORDER BY cellindex ASC LIMIT 1',
                      [pageId]
                  );
                  
                  if (firstImageResult.rows.length > 0) {
                      imageBase64 = firstImageResult.rows[0].image;
                  }
              }
              
              return {
                  id: comic.id,
                  text: comic.text,
                  description: comic.description,
                  image: imageBase64
              };
          })
      );
      
      res.status(200).json(comicsWithImages);
  }
  catch (err) {
      console.error('Ошибка получения списка комиксов:', err);
      res.status(500).json({
          error: "Ошибка получения списка комиксов"
      });
  }
});
app.get('/api/comics/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
      // 1. Get comic data
      const comicQuery = await client.query(
          'SELECT id, text, description, creator FROM comics WHERE id = $1',
          [id]
      );

      if (comicQuery.rows.length === 0) {
          return res.status(404).json({
              error: 'Комикс не найден' 
          });
      }

      const comic = comicQuery.rows[0];

      // 2. Get all pages for the comic with explicit ordering
      const pagesQuery = await client.query(
          `SELECT pageid, comicsid, number, rows, columns 
           FROM pages 
           WHERE comicsid = $1 
           ORDER BY number ASC`,  // Явная сортировка по номеру страницы
          [id]
      );

      // 3. Get images for each page with explicit ordering
      comic.pages = await Promise.all(
          pagesQuery.rows.map(async (page) => {
              const imagesQuery = await client.query(
                  `SELECT id, cellindex, encode(image, 'base64') as image 
                   FROM image 
                   WHERE pageid = $1 
                   ORDER BY cellindex ASC`,  // Явная сортировка изображений
                  [page.pageid]
              );
              
              return {
                  pageId: page.pageid,
                  number: page.number,
                  rows: page.rows,
                  columns: page.columns,
                  images: imagesQuery.rows.map(img => ({
                      id: img.id,
                      cellIndex: img.cellindex,
                      image: img.image
                  }))
              };
          })
      );

      res.status(200).json({
          id: comic.id,
          text: comic.text,
          description: comic.description,
          pages: comic.pages
      });

  } catch (err) {
      console.error('Ошибка при получении комикса:', err);
      res.status(500).json({ 
          success: false,
          error: 'Ошибка сервера при получении комикса',
          details: err.message
      });
  } finally {
      client.release();
  }
});

app.get('/api/comics/pages/:pageId', async(req, res) => {
  if(!req.user) {
    return res.status(401).json({ message: 'Not authorized'})
  }

  const {pageId} = req.params
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    
    // 1. Получаем информацию о странице
    const pageQuery = await client.query(
      `SELECT pageid, comicsid, number, rows, columns 
       FROM pages 
       WHERE pageid = $1`,
      [pageId]
    )

    if (pageQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Страница не найдена' })
    }

    const pageInfo = pageQuery.rows[0]

    // 2. Получаем изображения для страницы
    const imagesQuery = await client.query(
      `SELECT id, cellindex, encode(image, 'base64') as image 
       FROM image 
       WHERE pageid = $1 
       ORDER BY cellindex ASC`,
      [pageId]
    )

    // 3. Формируем ответ
    const response = {
      pageId: pageInfo.pageid,
      number: pageInfo.number,
      rows: pageInfo.rows,
      columns: pageInfo.columns,
      images: imagesQuery.rows.map(img => ({
        id: img.id,
        cellIndex: img.cellindex,
        image: img.image
      }))
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error('Ошибка при получении страницы:', err);
    res.status(500).json({ 
        success: false,
        error: 'Ошибка сервера при получении страницы',
        details: err.message
    });
  } finally {
    client.release();
  }
})

app.delete('/api/comics/pages/:pageId', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { pageId } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const comicCheck = await client.query(
      `SELECT c.id, c.creator 
       FROM comics c
       JOIN pages p ON p.comicsid = c.id
       WHERE p.pageid = $1`,
      [pageId]
    );

    if (comicCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Страница не найдена' });
    }

    const comic = comicCheck.rows[0];

    if (comic.creator !== req.user.id) {
      return res.status(403).json({ message: 'Недостаточно прав для удаления' });
    }

    await client.query('DELETE FROM pages WHERE pageid = $1', [pageId]);

    const remainingPages = await client.query(
      'SELECT pageid, number FROM pages WHERE comicsid = $1 ORDER BY number ASC',
      [comic.id]
    );

    for (let i = 0; i < remainingPages.rows.length; i++) {
      if (remainingPages.rows[i].number !== i) {
        await client.query(
          'UPDATE pages SET number = $1 WHERE pageid = $2',
          [i, remainingPages.rows[i].pageid]
        );
      }
    }

    await client.query('COMMIT');
    res.status(200).json({ 
      success: true,
      message: 'Страница успешно удалена' 
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ошибка при удалении страницы:', err);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера при удалении страницы',
      details: err.message
    });
  } finally {
    client.release();
  }
});

app.post('/api/comics/pages/:comicsId', async(req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }
  const { rows, columns } = req.body;
  const { comicsId } = req.params;
  if (!rows || !columns || !comicsId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const client = await pool.connect()
  const pageId = crypto.randomUUID()
  try {
    await client.query('BEGIN')
    const creatorCheck = await client.query(
      'SELECT creator FROM comics WHERE id = $1',
      [comicsId]
    );

    if (creatorCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Комикс не найден' });
    }

    if (creatorCheck.rows[0].creator !== req.user.id) {
      return res.status(403).json({ message: 'Недостаточно прав для редактирования' });
    }
    
    const pageCount = await pool.query('SELECT COUNT(*) FROM pages WHERE comicsId = $1', [comicsId])
    const pageNumber = parseInt(pageCount.rows[0].count, 10)
    await client.query(
      'INSERT INTO pages (pageId, comicsId, number, rows, columns) VALUES ($1, $2, $3, $4, $5)',
      [pageId, comicsId, pageNumber, rows, columns]
    );
    await client.query('COMMIT');
    res.status(200).json({ 
      message: 'Страница добавлена!'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ошибка добавления страницы', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  } finally {
    client.release();
  }
})

app.delete('/api/comics/pages/images/:imageId', async(req, res) => {
  if(!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const {imageId} = req.params;

  if (!imageId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const checkQuery = await client.query(
      `SELECT c.creator 
       FROM comics c
       JOIN pages p ON p.comicsid = c.id
       JOIN image i ON i.pageid = p.pageid
       WHERE i.id = $1`,
      [imageId]
    );

    if (checkQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Изображение не найдено' });
    }

    if (checkQuery.rows[0].creator !== req.user.id) {
      return res.status(403).json({ message: 'Недостаточно прав для удаления' });
    }
    await client.query('DELETE FROM image WHERE id = $1', [imageId]);
    
    await client.query('COMMIT');
    res.status(200).json({ 
      success: true,
      message: 'Изображение успешно удалено'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ошибка при удалении изображения:', err);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера при удалении изображения',
      details: err.message
    });
  } finally {
    client.release();
  }
});

app.put('/api/comics/pages/images/:imageId', async(req, res) => {
  if(!req.user) {
    return res.status(401).json({ message: 'Not authorized'})
  }
  const { image } = req.body;
  const { imageId } = req.params;

  if (!image || !imageId) {
    return res.status(400).json({message: 'Missing required fields'});
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const checkQuery = await client.query(
      `SELECT c.creator 
       FROM comics c
       JOIN pages p ON p.comicsid = c.id
       JOIN image i ON i.pageid = p.pageid
       WHERE i.id = $1`,
      [imageId]
    );

    if (checkQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Изображение не найдено' });
    }

    if (checkQuery.rows[0].creator !== req.user.id) {
      return res.status(403).json({ message: 'Недостаточно прав для редактирования' });
    }
    const imageBuffer = Buffer.from(image, 'base64');
    
    await client.query(
      'UPDATE image SET image = $1 WHERE id = $2',
      [imageBuffer, imageId]
    );
    
    await client.query('COMMIT');
    res.status(200).json({ 
      success: true,
      message: 'Изображение успешно обновлено!'
    });
  } catch(err) {
    await client.query('ROLLBACK');
    console.error('Ошибка при обновлении изображения:', err);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера при редактировании изображения',
      details: err.message
    });
  } finally {
    client.release();
  }
});
app.post('/api/comics/pages/images/:pageId', async(req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }
  
  const { cellIndex, image } = req.body;
  const { pageId } = req.params;
  
  if (cellIndex === undefined || cellIndex === null || !image || !pageId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const client = await pool.connect();
  const imageId = crypto.randomUUID();
  
  try {
    await client.query('BEGIN');
    const pageCheck = await client.query(
      `SELECT p.comicsId, c.creator 
       FROM pages p
       JOIN comics c ON p.comicsId = c.id
       WHERE p.pageId = $1`,
      [pageId]
    );

    if (pageCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Страница не найдена' });
    }

    const comicData = pageCheck.rows[0];
    if (!comicData.creator || comicData.creator !== req.user.id) {
      return res.status(403).json({ message: 'Недостаточно прав для добавления' });
    }
    const imageBuffer = Buffer.from(image, 'base64');
    
    await client.query(
      'INSERT INTO image (id, pageId, cellIndex, image) VALUES ($1, $2, $3, $4)',
      [imageId, pageId, cellIndex, imageBuffer] 
    );
    
    await client.query('COMMIT');
    res.status(200).json({ 
      message: 'Изображение успешно добавлено!',
      imageId: imageId
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ошибка добавления изображения', err);
    res.status(500).json({ 
      error: 'Server error',
      details: err.message 
    });
  } finally {
    client.release();
  }
});

app.post('/api/comics', async (req, res) => {
  if (req.user) {
    const { text, description, pages } = req.body;
    if (!text || !description || !pages) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify({ text, description, pages }));
    const comicHash = hash.digest('hex');

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      const existingComic = await client.query(
        'SELECT id FROM comics WHERE creator = $1 AND hash = $2',
        [req.user.id, comicHash]
      );

      if (existingComic.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ 
          error: 'Комикс с таким же содержанием уже существует',
          existingId: existingComic.rows[0].id
        });
      }
      const comicId = crypto.randomUUID();
      await client.query(
        'INSERT INTO comics (id, text, description, creator, hash) VALUES ($1, $2, $3, $4, $5)',
        [comicId, text, description, req.user.id, comicHash]
      );
      
      for (const page of pages) {
        const pageId = crypto.randomUUID();
        
        await client.query(
          'INSERT INTO pages (pageId, comicsId, number, rows, columns) VALUES ($1, $2, $3, $4, $5)',
          [pageId, comicId, page.number, page.rows, page.columns]
        );
        
        if (page.images) {
          for (const [index, img] of page.images.entries()) {
            const imageId = crypto.randomUUID();
            const imageBuffer = Buffer.from(img.image, 'base64');
            
            await client.query(
              'INSERT INTO image (id, pageId, cellIndex, image) VALUES ($1, $2, $3, $4)',
              [imageId, pageId, index, imageBuffer]
            );
          }
        }
      }
      
      await client.query('COMMIT');
      
      // Отправка уведомлений подписчикам
   // Отправка уведомлений подписчикам
try {
  // Получаем список подписчиков с FCM токенами
  const subscribers = await client.query(
    `SELECT u.id, s.fcm_token 
     FROM subscriptions sub
     JOIN users u ON sub.subscriber_id = u.id
     LEFT JOIN user_settings s ON u.id = s.user_id
     WHERE sub.target_user_id = $1 
       AND s.fcm_token IS NOT NULL
       AND (s.notifications_enabled IS NULL OR s.notifications_enabled = true)`,
    [req.user.id]
  );
  
  if (subscribers.rows.length > 0) {
    const creator = await client.query(
      'SELECT name FROM users WHERE id = $1',
      [req.user.id]
    );
    
    const creatorName = creator.rows[0]?.name || 'Автор';
    
    // Для Firebase Admin SDK < 9.0.0
    const sendResults = await Promise.all(
      subscribers.rows.map(async (sub) => {
        try {
          const message = {
            notification: {
              title: 'Новый комикс',
              body: `${creatorName} опубликовал новый комикс: "${text}"`
            },
            data: {
              type: 'new_comic',
              comic_id: comicId,
              creator_id: req.user.id,
              click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            token: sub.fcm_token
          };
          
          return await admin.messaging().send(message);
        } catch (err) {
          console.error(`Ошибка отправки уведомления пользователю ${sub.id}:`, err);
          return { error: err };
        }
      })
    );

    const successCount = sendResults.filter(r => !r.error).length;
    const failureCount = sendResults.filter(r => r.error).length;
    console.log(`Уведомления отправлены: ${successCount} успешно, ${failureCount} с ошибкой`);
  }
} catch (notifyErr) {
  console.error('Ошибка отправки уведомлений:', notifyErr);
}

      res.status(200).json({ 
        message: 'Комикс сохранён!',
        comicId: comicId 
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Ошибка сохранения комикса:', err);
      res.status(500).json({ 
        error: 'Ошибка сервера',
        details: err.message 
      });
    } finally {
      client.release();
    }
  } else {
    return res.status(401).json({ message: 'Not authorized' });
  }
});

app.put('/api/comics/:id', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { id } = req.params;
  const { comic, pages } = req.body;
  
  if (!comic || !pages) {
    return res.status(400).json({ error: "Необходимы comic и pages" });
  }

  const client = await pool.connect();
  let shouldRelease = true;

  try {
    // 1. Проверяем, является ли пользователь создателем комикса
    const creatorCheck = await client.query(
      'SELECT creator FROM comics WHERE id = $1',
      [id]
    );

    if (creatorCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Комикс не найден' });
    }

    if (creatorCheck.rows[0].creator !== req.user.id) {
      return res.status(403).json({ message: 'Недостаточно прав для редактирования' });
    }

    await client.query('BEGIN');

    // 2. Обновляем данные комикса
    await client.query(
      'UPDATE comics SET text = $1, description = $2 WHERE id = $3',
      [comic.text, comic.description, id]
    );

    // 3. Обрабатываем страницы
    for (const page of pages) {
      const pageExists = await client.query(
        'SELECT 1 FROM pages WHERE pageid = $1 AND comicsid = $2',
        [page.pageId, id]
      );

      if (pageExists.rows.length > 0) {
        await client.query(
          'UPDATE pages SET number = $1, rows = $2, columns = $3 WHERE pageid = $4',
          [page.number, page.rows, page.columns, page.pageId]
        );
      } else {
        await client.query(
          'INSERT INTO pages (pageid, comicsid, number, rows, columns) VALUES ($1, $2, $3, $4, $5)',
          [page.pageId, id, page.number, page.rows, page.columns]
        );
      }

      // 4. Обрабатываем изображения
      for (const img of page.images) {
        const imageBuffer = Buffer.from(img.image, 'base64');
        const imgExists = await client.query(
          'SELECT 1 FROM image WHERE id = $1 AND pageid = $2',
          [img.id, page.pageId]
        );

        if (imgExists.rows.length > 0) {
          await client.query(
            'UPDATE image SET cellindex = $1, image = $2 WHERE id = $3',
            [img.cellIndex, imageBuffer, img.id]
          );
        } else {
          await client.query(
            'INSERT INTO image (id, pageid, cellindex, image) VALUES ($1, $2, $3, $4)',
            [img.id, page.pageId, img.cellIndex, imageBuffer]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.status(200).json({ 
      success: true,
      message: 'Комикс успешно обновлен' 
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ошибка при обновлении комикса:', err);
    res.status(500).json({ 
      success: false,
      error: 'Ошибка сервера при обновлении комикса',
      details: err.message
    });
  } finally {
    if (shouldRelease && client) {
      client.release();
    }
  }
});

app.post('/api/comics/:id/like', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { id } = req.params;
  
  try {
    const comicCheck = await pool.query('SELECT 1 FROM comics WHERE id = $1', [id]);
    if (comicCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Комикс не найден' });
    }

    const likeCheck = await pool.query(
      'SELECT 1 FROM likes WHERE user_id = $1 AND comic_id = $2',
      [req.user.id, id]
    );

    if (likeCheck.rows.length > 0) {
      await pool.query(
        'DELETE FROM likes WHERE user_id = $1 AND comic_id = $2',
        [req.user.id, id]
      );
      return res.status(200).json({ liked: false });
    } else {
      await pool.query(
        'INSERT INTO likes (user_id, comic_id) VALUES ($1, $2)',
        [req.user.id, id]
      );
      return res.status(200).json({ liked: true });
    }
  } catch (err) {
    console.error('Ошибка при обработке лайка:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.get('/api/comics/:id/like', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { id } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT 1 FROM likes WHERE user_id = $1 AND comic_id = $2',
      [req.user.id, id]
    );
    
    res.status(200).json({ liked: result.rows.length > 0 });
  } catch (err) {
    console.error('Ошибка при проверке лайка:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.get('/api/comics/:id/likes/count', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT COUNT(*) FROM likes WHERE comic_id = $1',
      [id]
    );
    
    res.status(200).json({ count: parseInt(result.rows[0].count, 10) });
  } catch (err) {
    console.error('Ошибка при получении количества лайков:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.post('/api/comics/:id/favorite', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { id } = req.params;
  
  try {
    const comicCheck = await pool.query('SELECT 1 FROM comics WHERE id = $1', [id]);
    if (comicCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Комикс не найден' });
    }

    const favCheck = await pool.query(
      'SELECT 1 FROM favorites WHERE user_id = $1 AND comic_id = $2',
      [req.user.id, id]
    );

    if (favCheck.rows.length > 0) {
      await pool.query(
        'DELETE FROM favorites WHERE user_id = $1 AND comic_id = $2',
        [req.user.id, id]
      );
      return res.status(200).json({ favorited: false });
    } else {
      await pool.query(
        'INSERT INTO favorites (user_id, comic_id) VALUES ($1, $2)',
        [req.user.id, id]
      );
      return res.status(200).json({ favorited: true });
    }
  } catch (err) {
    console.error('Ошибка при обработке избранного:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.get('/api/comics/:id/favorite', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { id } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT 1 FROM favorites WHERE user_id = $1 AND comic_id = $2',
      [req.user.id, id]
    );
    
    res.status(200).json({ favorited: result.rows.length > 0 });
  } catch (err) {
    console.error('Ошибка при проверке избранного:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.get('/api/user/favorites', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  try {
    const result = await pool.query(`
      SELECT 
        c.id, 
        c.text, 
        c.description,
        (
          SELECT encode(i.image, 'base64') as image
          FROM pages p
          JOIN image i ON i.pageid = p.pageid
          WHERE p.comicsid = c.id AND i.cellindex = 0
          ORDER BY p.number
          LIMIT 1
        ) as image
      FROM comics c
      JOIN favorites f ON f.comic_id = c.id
      WHERE f.user_id = $1
    `, [req.user.id]);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Ошибка при получении избранного:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});
app.get('/api/comics/:comicsId/info', async (req, res) => {
  const { comicsId } = req.params;
  const userId = req.user?.id;

  try {
    const client = await pool.connect();
    
    try {
      const comicInfo = await client.query(
        `SELECT c.id, c.text, c.description, c.creator, u.name as creator_name 
         FROM comics c
         JOIN users u ON c.creator = u.id
         WHERE c.id = $1`,
        [comicsId]
      );

      if (comicInfo.rows.length === 0) {
        return res.status(404).json({ error: 'Комикс не найден' });
      }

      const comic = comicInfo.rows[0];

      const firstPageResult = await client.query(
        `SELECT pageid, number, rows, columns
         FROM pages 
         WHERE comicsid = $1
         ORDER BY number ASC
         LIMIT 1`,
        [comicsId]
      );

      let firstPage = null;
      if (firstPageResult.rows.length > 0) {
        const page = firstPageResult.rows[0];
        
        const imagesResult = await client.query(
          `SELECT id, cellindex, encode(image, 'base64') as image
           FROM image 
           WHERE pageid = $1
           ORDER BY cellindex ASC`,
          [page.pageid]
        );

        firstPage = {
          pageId: page.pageid,
          number: page.number,
          rows: page.rows,
          columns: page.columns,
          images: imagesResult.rows.map(img => ({
            id: img.id,
            cellIndex: img.cellindex,
            image: img.image
          }))
        };
      }

      const likesCount = await client.query(
        `SELECT COUNT(*) as count 
         FROM likes 
         WHERE comic_id = $1`,
        [comicsId]
      );
      let userLiked = false;
      if (userId) {
        const likeCheck = await client.query(
          `SELECT 1 
           FROM likes 
           WHERE user_id = $1 AND comic_id = $2`,
          [userId, comicsId]
        );
        userLiked = likeCheck.rows.length > 0;
      }

      let userFavorited = false;
      if (userId) {
        const favoriteCheck = await client.query(
          `SELECT 1 
           FROM favorites 
           WHERE user_id = $1 AND comic_id = $2`,
          [userId, comicsId]
        );
        userFavorited = favoriteCheck.rows.length > 0;
      }

      const comments = await client.query(
        `SELECT c.id, c.text, c.created_at, u.id as user_id, u.name as user_name
         FROM comments c
         JOIN users u ON c.user_id = u.id
         WHERE c.comic_id = $1
         ORDER BY c.created_at DESC`,
        [comicsId]
      );

      const response = {
        id: comic.id,
        text: comic.text,
        description: comic.description,
        creator: comic.creator,
        creator_name: comic.creator_name,
        firstPage: firstPage,
        likesCount: parseInt(likesCount.rows[0].count, 10),
        userLiked,
        userFavorited,
        comments: comments.rows.map(comment => ({
          ...comment,
          isCommentMy: userId ? comment.user_id === userId : false
        }))
      };

      res.status(200).json(response);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Ошибка при получении информации о комиксе:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});
app.post('/api/comics/:comicsId/comments', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { comicsId } = req.params;
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Текст комментария обязателен' });
  }

  try {
    const client = await pool.connect();
    
    try {
      const comicCheck = await client.query(
        'SELECT 1 FROM comics WHERE id = $1',
        [comicsId]
      );

      if (comicCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Комикс не найден' });
      }

      const commentId = crypto.randomUUID();
      
      await client.query(
        'INSERT INTO comments (id, comic_id, user_id, text) VALUES ($1, $2, $3, $4)',
        [commentId, comicsId, req.user.id, text]
      );

      const newComment = await client.query(
        `SELECT c.id, c.text, c.created_at, u.id as user_id, u.name as user_name
         FROM comments c
         JOIN users u ON c.user_id = u.id
         WHERE c.id = $1`,
        [commentId]
      );

      res.status(201).json(newComment.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Ошибка при добавлении комментария:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.delete('/api/comments/:commentId', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { commentId } = req.params;

  try {
    const client = await pool.connect();
    
    try {
      const commentCheck = await client.query(
        `SELECT 1 FROM comments 
         WHERE id = $1 AND (user_id = $2 OR 
           EXISTS (SELECT 1 FROM comics c 
                  JOIN comments cm ON c.id = cm.comic_id 
                  WHERE cm.id = $1 AND c.creator = $2))`,
        [commentId, req.user.id]
      );

      if (commentCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Комментарий не найден или у вас нет прав на его удаление' });
      }

      await client.query('DELETE FROM comments WHERE id = $1', [commentId]);

      res.status(200).json({ success: true });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Ошибка при удалении комментария:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user?.id;
    const client = await pool.connect();

    try {
      const userInfo = await client.query(
        `SELECT 
          id, 
          name,
          encode(avatar, 'base64') as avatar
         FROM users 
         WHERE id = $1`,
        [userId]
      );

      if (userInfo.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      const user = userInfo.rows[0];
      
      const likesCount = await client.query(
        `SELECT COUNT(*) as total_likes
         FROM likes l
         JOIN comics c ON l.comic_id = c.id
         WHERE c.creator = $1`,
        [userId]
      );
      
      const comics = await client.query(
        `SELECT 
           c.id, 
           c.text, 
           c.description,
           (
             SELECT COUNT(*) 
             FROM likes 
             WHERE comic_id = c.id
           ) as likes_count,
           (
             SELECT encode(i.image, 'base64') as image
             FROM pages p
             JOIN image i ON i.pageid = p.pageid
             WHERE p.comicsid = c.id AND i.cellindex = 0
             ORDER BY p.number
             LIMIT 1
           ) as cover_image
         FROM comics c
         WHERE c.creator = $1
         ORDER BY c.text`,
        [userId]
      );
      
      const subscribersCount = await client.query(
        `SELECT COUNT(*) as count 
         FROM subscriptions 
         WHERE target_user_id = $1`,
        [userId]
      );
      
      const subscriptionsCount = await client.query(
        `SELECT COUNT(*) as count 
         FROM subscriptions 
         WHERE subscriber_id = $1`,
        [userId]
      );
      
      let isSubscribed = null;
      if (currentUserId && currentUserId !== userId) {
        const subCheck = await client.query(
          `SELECT 1 
           FROM subscriptions 
           WHERE subscriber_id = $1 AND target_user_id = $2`,
          [currentUserId, userId]
        );
        isSubscribed = subCheck.rows.length > 0;
      }

      const response = {
        id: user.id,
        name: user.name,
        avatar: user.avatar || null,
        total_likes: parseInt(likesCount.rows[0].total_likes, 10),
        subscribers_count: parseInt(subscribersCount.rows[0].count, 10),
        subscriptions_count: parseInt(subscriptionsCount.rows[0].count, 10),
        is_subscribed: isSubscribed,
        comics: comics.rows.map(comic => ({
          id: comic.id,
          text: comic.text,
          description: comic.description,
          likes_count: parseInt(comic.likes_count, 10),
          image: comic.cover_image
        }))
      };

      res.status(200).json(response);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Ошибка при получении информации о пользователе:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.post('/api/users/:userId/subscribe', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { userId } = req.params;
  
  try {
    const userCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Нельзя подписаться на себя' });
    }

    const subCheck = await pool.query(
      'SELECT 1 FROM subscriptions WHERE subscriber_id = $1 AND target_user_id = $2',
      [req.user.id, userId]
    );

    if (subCheck.rows.length > 0) {
      await pool.query(
        'DELETE FROM subscriptions WHERE subscriber_id = $1 AND target_user_id = $2',
        [req.user.id, userId]
      );
      return res.status(200).json({ subscribed: false });
    } else {
      await pool.query(
        'INSERT INTO subscriptions (subscriber_id, target_user_id) VALUES ($1, $2)',
        [req.user.id, userId]
      );
      return res.status(200).json({ subscribed: true });
    }
  } catch (err) {
    console.error('Ошибка при обработке подписки:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.get('/api/users/:userId/subscribe', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { userId } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT 1 FROM subscriptions WHERE subscriber_id = $1 AND target_user_id = $2',
      [req.user.id, userId]
    );
    
    res.status(200).json({ subscribed: result.rows.length > 0 });
  } catch (err) {
    console.error('Ошибка при проверке подписки:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.get('/api/users/:userId/subscribers', async (req, res) => {
  const { userId } = req.params;
  const currentUserId = req.user?.id;
  
  try {
    const result = await pool.query(
      `SELECT 
         u.id, 
         u.name,
         encode(u.avatar, 'base64') as avatar,
         CASE
           WHEN u.id = $2 THEN NULL
           ELSE EXISTS (
             SELECT 1 FROM subscriptions 
             WHERE subscriber_id = $2 AND target_user_id = u.id
           )
         END as is_subscribed_by_me
       FROM users u
       JOIN subscriptions s ON u.id = s.subscriber_id
       WHERE s.target_user_id = $1`,
      [userId, currentUserId]
    );
    
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Ошибка при получении подписчиков:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.get('/api/users/:userId/subscriptions', async (req, res) => {
  const { userId } = req.params;
  const currentUserId = req.user?.id;
  
  try {
    const result = await pool.query(
      `SELECT 
         u.id, 
         u.name,
         encode(u.avatar, 'base64') as avatar,
         CASE
           WHEN u.id = $2 THEN NULL
           ELSE EXISTS (
             SELECT 1 FROM subscriptions 
             WHERE subscriber_id = $2 AND target_user_id = u.id
           )
         END as is_subscribed_by_me
       FROM users u
       JOIN subscriptions s ON u.id = s.target_user_id
       WHERE s.subscriber_id = $1`,
      [userId, currentUserId]
    );
    
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Ошибка при получении подписок:', err);
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: err.message 
    });
  }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'OK',
      database: 'connected'
    });
  } catch (err) {
    res.status(500).json({
      status: 'ERROR',
      database: 'disconnected',
      error: err.message
    });
  }
});

app.post('/api/user/avatar', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { avatar } = req.body;

  if (!avatar) {
    return res.status(400).json({ message: 'Avatar image is required' });
  }

  try {
    const avatarBuffer = Buffer.from(avatar, 'base64');
    await pool.query(
      'UPDATE users SET avatar = $1 WHERE id = $2',
      [avatarBuffer, req.user.id]
    );
    const updatedUser = await pool.query(
      'SELECT id, login, name, encode(avatar, \'base64\') as avatar FROM users WHERE id = $1',
      [req.user.id]
    );

    res.status(200).json({
      message: 'Avatar uploaded successfully',
      user: updatedUser.rows[0]
    });
  } catch (err) {
    console.error('Error uploading avatar:', err);
    res.status(500).json({ message: 'Error uploading avatar' });
  }
});

app.delete('/api/user/avatar', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  try {
    await pool.query(
      'UPDATE users SET avatar = NULL WHERE id = $1',
      [req.user.id]
    );

    const updatedUser = await pool.query(
      'SELECT id, login, name, encode(avatar, \'base64\') as avatar FROM users WHERE id = $1',
      [req.user.id]
    );

    res.status(200).json({
      message: 'Avatar removed successfully',
      user: updatedUser.rows[0]
    });
  } catch (err) {
    console.error('Error removing avatar:', err);
    res.status(500).json({ message: 'Error removing avatar' });
  }
});

app.post('/api/user/fcm_token', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ message: 'Token is required' });
  }

  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, fcm_token) 
       VALUES ($1, $2)
       ON CONFLICT (user_id) 
       DO UPDATE SET fcm_token = EXCLUDED.fcm_token`,
      [req.user.id, token]
    );
    
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error saving FCM token:', err);
    res.status(500).json({ message: 'Error saving token' });
  }
});

app.put('/api/user/notification_settings', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  const { enabled } = req.body;
  
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ message: 'Enabled flag is required' });
  }

  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, notifications_enabled) 
       VALUES ($1, $2)
       ON CONFLICT (user_id) 
       DO UPDATE SET notifications_enabled = EXCLUDED.notifications_enabled`,
      [req.user.id, enabled]
    );
    
    res.status(200).json({ success: true, notifications_enabled: enabled });
  } catch (err) {
    console.error('Error updating notification settings:', err);
    res.status(500).json({ message: 'Error updating settings' });
  }
});
async function startServer() {
    const isConnected = await checkDatabaseConnection();
    if (!isConnected) {
      console.error('Не удалось подключиться к БД. Завершение работы.');
      process.exit(1);
    }
  
    await createTables();
    await addHashColumnIfNotExists();
    app.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Сервер запущен на ${port} порту`);
    });
  }
  
  startServer().catch(err => {
    console.error('Ошибка запуска сервера:', err);
    process.exit(1);
  });
