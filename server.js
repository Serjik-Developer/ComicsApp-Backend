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

app.delete('/api/comics/:id', async(req,res) => {
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
            response: "Ошибка получениясписка  комиксов"
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


app.get('/api/debug/columns', async (req, res) => {
  try {
    const tables = ['comics', 'pages', 'image'];
    const result = {};
    
    for (const table of tables) {
      const query = `
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = $1
      `;
      const res = await pool.query(query, [table]);
      result[table] = res.rows;
    }
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
});

app.put('/api/comics:id', async(req,res) => {
  try {
  const {comics, pages} = req.body
  if (!comics || !pages) {
    return res.status(400).json({error : "Необходимы comics и pages"})
  }
  const client = await pool.connect()
  await client.query('BEGIN');
      // обновляем комикс
      await client.query(
        'UPDATE comics SET (text, description) VALUES($1, $2) WHERE id = $3',
        [comic.text, comic.description, comics.id]
      );
        // обновляем страницы и изображения
        for (const page of pages) {
          await client.query(
            'UPDATE pages SET (pageId, comicsId, number, rows, columns) VALUES ($1, $2, $3, $4, $5)',
            [page.pageId, page.comicsId, page.number, page.rows, page.columns]
          );
          
          for (const img of page.images) {
            const imageBuffer = Buffer.from(img.image, 'base64');
            await client.query(
              'UPDATE image SET(id, pageId, cellIndex, image) VALUES ($1, $2, $3, $4)',
              [img.id, page.pageId, img.cellIndex, imageBuffer]
            );
          }
        }
  res.status(200)
      }
  catch(err) {
    res.status(500).json({error : err})
  }
}
)


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