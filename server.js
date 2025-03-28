require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json({ limit: '50mb' }));

// Правильная конфигурация подключения для Render
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
    `);
    console.log('✅ Таблицы созданы/проверены');
  } catch (err) {
    console.error('❌ Ошибка создания таблиц:', err.message);
  }
}
app.get('/api/comics', async(req,res) => {
    try {
        const result = await pool.query('SELECT * FROM comics')
        res.status(200).json({
            response: result.rows
        })
    }
    catch (err) {
        res.status(500).json({
            response: "Ошибка получениясписка  комиксов"
        })
    }
}
)
/**
 * @api {get} /api/comicsById/:id Получить комикс по ID со страницами и изображениями
 * @apiName GetComicWithPagesAndImages
 * @apiGroup Comics
 *
 * @apiParam {String} id ID комикса
 *
 * @apiSuccess {Object} comic Данные комикса
 * @apiSuccess {String} comic.id ID комикса
 * @apiSuccess {String} comic.text Название комикса
 * @apiSuccess {String} comic.description Описание комикса
 * @apiSuccess {Array} comic.pages Страницы комикса
 * @apiSuccess {String} comic.pages.pageId ID страницы
 * @apiSuccess {Number} comic.pages.number Номер страницы
 * @apiSuccess {Array} comic.pages.images Изображения страницы
 */
app.get('/api/comicsById/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
  
    try {
      // 1. Получаем данные комикса
      const comicQuery = await client.query(
        'SELECT * FROM comics WHERE id = $1',
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
        'SELECT * FROM pages WHERE comicsId = $1 ORDER BY number ASC',
        [id]
      );
  
      // 3. Для каждой страницы получаем изображения
      comic.pages = await Promise.all(
        pagesQuery.rows.map(async (page) => {
          const imagesQuery = await client.query(
            'SELECT id, cellIndex FROM image WHERE pageId = $1 ORDER BY cellIndex ASC',
            [page.pageId]
          );
          
          return {
            ...page,
            images: imagesQuery.rows
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
        error: 'Ошибка сервера при получении комикса' 
      });
    } finally {
      client.release();
    }
  });

// Обработчик для /api/comics
app.post('/api/comics', async (req, res) => {
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
    
    await client.query('COMMIT');
    res.status(201).json({ message: 'Комикс сохранён!' });
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