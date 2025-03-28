require('dotenv').config();
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
        description TEXT
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
  if (req.headers.authorization) {
    try {
      const token = req.headers.authorization.split(' ')[1];
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      
      if (payload && payload.id) {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [payload.id]);
        
        if (result.rows.length > 0) {
          req.user = result.rows[0]; // Сохраняем всего пользователя
          return next();
        }
      }
    } catch (err) {
      console.error('Ошибка проверки токена:', err);
    }
  }
  next();
});

app.post('/auth', async(req, res) => {
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
          id: user.id,
          login: user.login,
          name: user.name,
          token: token
      });
  }
  catch(err) {
      console.error('Auth error:', err);
      return res.status(500).json({ message: 'Authentication failed' });
  }
});

app.post('/register', (req, res) => {
  const { login, password, name } = req.body;
  if (!login || !password || !name) {
      return res
          .status(400)
          .json({ message: 'Login, password and name are required' });
  }
  const result = pool.query('SELECT id FROM users WHERE login = $1', [login])
  if (result.rows) {
    return res
    .status(409)
    .json({ message: 'User already exists' });
  }
  else {
    let id = crypto.randomUUID(); 
    pool.query(
      'INSERT INTO users (id, login, password, name) VALUES ($1, $2, $3, $4)',
      [id, login, password, name]
    );
    return res.status(200).json({
      login: login,
      token: jwt.sign({ id: id }, process.env.JWT_SECRET),
  })
  }
});




//GET INFO ABOUT CURRENT USER
app.get('/user', (req, res) => {
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


app.get('/api/comics', async(req,res) => {
    try {
        const result = await pool.query('SELECT * FROM comics')
        res.status(200).json({
            response: result.rows
        })
    }
    catch (err) {
        res.status(500).json({
            response: "Ошибка получения списка  комиксов"
        })
    }
}
)

app.get('/api/comics/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
      // 1. Получаем данные комикса
      const comicQuery = await client.query(
          'SELECT id, text, description FROM comics WHERE id = $1',
          [id]
      );

      if (comicQuery.rows.length === 0) {
          return res.status(404).json({ 
              success: false,
              error: 'Комикс не найден' 
          });
      }

      const comic = comicQuery.rows[0];

      // 2. Получаем все страницы комикса
      const pagesQuery = await client.query(
          'SELECT pageid, comicsid, number, rows, columns FROM pages WHERE comicsid = $1 ORDER BY number ASC',
          [id]
      );

      // 3. Для каждой страницы получаем изображения
      comic.pages = await Promise.all(
          pagesQuery.rows.map(async (page) => {
              const imagesQuery = await client.query(
                  'SELECT id, cellindex, encode(image, \'base64\') as image FROM image WHERE pageid = $1 ORDER BY cellindex ASC',
                  [page.pageid]
              );
              
              return {
                  pageId: page.pageid,
                  comicsId: page.comicsid,
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

      res.json({
          success: true,
          comic
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


// Обработчик для /api/comics
app.post('/api/comics', async (req, res) => {
  if (req.user) {
  const { comic, pages } = req.body;
  
  // Валидация входных данных
  if (!comic || !pages) {
    return res.status(400).json({ error: 'Необходимы comic и pages' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Сохраняем комикс
    await client.query(
      'INSERT INTO comics (id, text, description) VALUES ($1, $2, $3)',
      [comic.id, comic.text, comic.description]
    );
    
    // Сохраняем страницы и изображения
    for (const page of pages) {
      await client.query(
        'INSERT INTO pages (pageId, comicsId, number, rows, columns) VALUES ($1, $2, $3, $4, $5)',
        [page.pageId, page.comicsId, page.number, page.rows, page.columns]
      );
      
      for (const img of page.images) {
        const imageBuffer = Buffer.from(img.image, 'base64');
        await client.query(
          'INSERT INTO image (id, pageId, cellIndex, image) VALUES ($1, $2, $3, $4)',
          [img.id, page.pageId, img.cellIndex, imageBuffer]
        );
      }
      
    }
    // Временно добавьте в POST /api/comics после сохранения:
const checkImages = await client.query('SELECT COUNT(*) FROM image WHERE pageId IN (SELECT pageId FROM pages WHERE comicsId = $1)', [comic.id]);
console.log(`Сохранено изображений: ${checkImages.rows[0].count}`);
    await client.query('COMMIT');
    
    res.status(200).json({ message: 'Комикс сохранён!' });
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
}
else
return res
    .status(401)
    .json({ message: 'Not authorized' })
});

app.put('/api/comics/:id', async (req, res) => {
  if (req.user) {
  const { id } = req.params;
  const { comic, pages } = req.body; // Обратите внимание: comic вместо comics
  const client = await pool.connect();

  if (!comic || !pages) {
      return res.status(400).json({ error: "Необходимы comic и pages" });
  }

  try {
      await client.query('BEGIN');

      // 1. Обновляем данные комикса (кроме id)
      await client.query(
          'UPDATE comics SET text = $1, description = $2 WHERE id = $3',
          [comic.text, comic.description, id]
      );

      // 2. Обрабатываем страницы
      for (const page of pages) {
          // Проверяем существование страницы
          const pageExists = await client.query(
              'SELECT 1 FROM pages WHERE pageid = $1 AND comicsid = $2',
              [page.pageId, id]
          );

          if (pageExists.rows.length > 0) {
              // Обновляем существующую страницу
              await client.query(
                  'UPDATE pages SET number = $1, rows = $2, columns = $3 WHERE pageid = $4',
                  [page.number, page.rows, page.columns, page.pageId]
              );
          } else {
              // Добавляем новую страницу
              await client.query(
                  'INSERT INTO pages (pageid, comicsid, number, rows, columns) VALUES ($1, $2, $3, $4, $5)',
                  [page.pageId, id, page.number, page.rows, page.columns]
              );
          }

          // 3. Обрабатываем изображения для страницы
          for (const img of page.images) {
              const imageBuffer = Buffer.from(img.image, 'base64');
              const imgExists = await client.query(
                  'SELECT 1 FROM image WHERE id = $1 AND pageid = $2',
                  [img.id, page.pageId]
              );

              if (imgExists.rows.length > 0) {
                  // Обновляем существующее изображение
                  await client.query(
                      'UPDATE image SET cellindex = $1, image = $2 WHERE id = $3',
                      [img.cellIndex, imageBuffer, img.id]
                  );
              } else {
                  // Добавляем новое изображение
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
      client.release();
  }
}
else
return res
    .status(401)
    .json({ message: 'Not authorized' })
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
      console.log(`🚀 Сервер запущен на http://localhost:${port}`);
    });
  }
  
  startServer().catch(err => {
    console.error('Ошибка запуска сервера:', err);
    process.exit(1);
  });