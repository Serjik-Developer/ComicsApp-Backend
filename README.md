# Node.js сервер для работы с комиксами

## Описание
Этот сервер на `Node.js` с использованием `Express` и `PostgreSQL` предоставляет API для управления комиксами. Реализована аутентификация с `JWT`, а также CRUD-операции для работы с пользователями и комиксами.

## Установка
### 1. Клонирование репозитория
```sh
git clone <https://github.com/Serjik-Developer/ComicsApp-Backend.git>
cd <ИМЯ_ПАПКИ>
```

### 2. Установка зависимостей
```sh
npm install dotenv express pg jsonwebtoken cors body-parser
```

### 3. Создание `.env` файла
Создайте файл `.env` в корневой директории и укажите в нем параметры подключения к базе данных и JWT:
```env
PORT=5432
PG_USER=<ВАШ_ПОЛЬЗОВАТЕЛЬ>
PG_HOST=<АДРЕС_СЕРВЕРА>
PG_DATABASE=<ИМЯ_БД>
PG_PASSWORD=<ВАШ_ПАРОЛЬ>
PG_PORT=5432
JWT_SECRET=<СЕКРЕТНЫЙ_КЛЮЧ>
```

## Запуск сервера
```sh
npm start
```
Сервер запустится на `http://localhost:3000`

## API эндпоинты
### Аутентификация
#### Регистрация пользователя
**POST** `/api/user/register`
```json
{
  "login": "user123",
  "password": "securepassword",
  "name": "User Name"
}
```
#### Авторизация пользователя
**POST** `/api/user/auth`
```json
{
  "login": "user123",
  "password": "securepassword"
}
```
Возвращает `JWT-токен`.

#### Получение информации о пользователе
**GET** `/api/user`

### Работа с комиксами
#### Получение всех комиксов
**GET** `/api/comics`

#### Получение комиксов текущего пользователя
**GET** `/api/mycomics`

#### Получение комикса по `id`
**GET** `/api/comics/:id`

#### Создание комикса
**POST** `/api/comics`
```json
{
  "comic": {
    "id": "uuid",
    "text": "Название комикса",
    "description": "Описание комикса"
  },
  "pages": [
    {
      "pageId": "uuid",
      "comicsId": "uuid",
      "number": 1,
      "rows": 2,
      "columns": 3,
      "images": [
        {
          "id": "uuid",
          "cellIndex": 1,
          "image": "base64-кодировка"
        }
      ]
    }
  ]
}
```

#### Обновление комикса
**PUT** `/api/comics/:id`

#### Удаление комикса
**DELETE** `/api/comics/:id`

### Проверка работоспособности сервера
**GET** `/health`

---

# Node.js Server for Comics

## Description
This `Node.js` server using `Express` and `PostgreSQL` provides an API for managing comics. It includes authentication with `JWT` and CRUD operations for users and comics.

## Installation
### 1. Clone the repository
```sh
git clone <https://github.com/Serjik-Developer/ComicsApp-Backend.git>
cd <FOLDER_NAME>
```

### 2. Install dependencies
```sh
npm install dotenv express pg jsonwebtoken cors body-parser
```

### 3. Create a `.env` file
Create a `.env` file in the root directory and specify the database connection parameters and JWT settings:
```env
PORT=5432
PG_USER=<YOUR_USER>
PG_HOST=<SERVER_ADDRESS>
PG_DATABASE=<DATABASE_NAME>
PG_PASSWORD=<YOUR_PASSWORD>
PG_PORT=5432
JWT_SECRET=<SECRET_KEY>
```

## Start the Server
```sh
npm start
```
The server will start at `http://localhost:3000`

## API Endpoints
### Authentication
#### User Registration
**POST** `/api/user/register`
```json
{
  "login": "user123",
  "password": "securepassword",
  "name": "User Name"
}
```
#### User Authentication
**POST** `/api/user/auth`
```json
{
  "login": "user123",
  "password": "securepassword"
}
```
Returns a `JWT token`.

#### Get User Information
**GET** `/api/user`

### Comics Management
#### Get All Comics
**GET** `/api/comics`

#### Get User's Comics
**GET** `/api/mycomics`

#### Get Comic by `id`
**GET** `/api/comics/:id`

#### Create a Comic
**POST** `/api/comics`
```json
{
  "comic": {
    "id": "uuid",
    "text": "Comic Title",
    "description": "Comic Description"
  },
  "pages": [
    {
      "pageId": "uuid",
      "comicsId": "uuid",
      "number": 1,
      "rows": 2,
      "columns": 3,
      "images": [
        {
          "id": "uuid",
          "cellIndex": 1,
          "image": "base64-encoded"
        }
      ]
    }
  ]
}
```

#### Update a Comic
**PUT** `/api/comics/:id`

#### Delete a Comic
**DELETE** `/api/comics/:id`

### Server Health Check
**GET** `/health`

