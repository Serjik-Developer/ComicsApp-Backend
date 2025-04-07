require('dotenv').config();
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
        creator TEXT
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
        name TEXT
      );
    `);
    console.log('✅ Таблицы созданы/проверены');
  } catch (err) {
    console.error('❌ Ошибка создания таблиц:', err.message);
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
      const result = await pool.query('SELECT * FROM users WHERE login = $1', [login]);
      if (result.rows.length === 0) {
          return res.status(404).json({ message: 'User not found' });
      }
      const user = result.rows[0];
      if (user.password !== password) {
          return res.status(401).json({ message: 'Invalid password' });
      }
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




//GET INFO ABOUT CURRENT USER
app.get('/api/user', (req, res) => {
  if (req.user) return res.status(200).json( {response : req.user});
  else
      return res
          .status(401)
          .json({ message: 'Not authorized' });
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

app.post('/api/comics', async (req, res) => {
  if (req.user) {
    const { text, description, pages } = req.body;
    
    // Validation
    if (!text || !description || !pages) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Generate new IDs
      const comicId = crypto.randomUUID();
      
      // Save comic
      await client.query(
        'INSERT INTO comics (id, text, description, creator) VALUES ($1, $2, $3, $4)',
        [comicId, text, description, req.user.id]
      );
      
      // Save pages and images
      for (const page of pages) {
        const pageId = crypto.randomUUID();
        
        await client.query(
          'INSERT INTO pages (pageId, comicsId, number, rows, columns) VALUES ($1, $2, $3, $4, $5)',
          [pageId, comicId, page.number, page.rows, page.columns]
        );
        
        if (page.images) {
          // Используем for...of вместо forEach для поддержки await
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

// Проверка работы сервера
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

// Инициализация сервера
async function startServer() {
    const isConnected = await checkDatabaseConnection();
    if (!isConnected) {
      console.error('Не удалось подключиться к БД. Завершение работы.');
      process.exit(1);
    }
  
    await createTables();
    
    app.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Сервер запущен на ${port} порту`);
    });
  }
  
  startServer().catch(err => {
    console.error('Ошибка запуска сервера:', err);
    process.exit(1);
  });
