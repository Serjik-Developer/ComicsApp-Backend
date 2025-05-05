# Node.js сервер для работы с комиксами

## Описание
Этот сервер на `Node.js` с использованием `Express` и `PostgreSQL` предоставляет API для управления комиксами. Реализована аутентификация с `JWT`, а также CRUD-операции для работы с пользователями и комиксами. 
Реализована отправка PUSH уведомлений на мое Android приложение через `Firebase Cloud Messaging`
Этот сервер необходим для работы моего нативного Android приложения ComicsApp - https://github.com/Serjik-Developer/ComicsApp

## Установка
### 1. Клонирование репозитория
```sh
git clone <https://github.com/Serjik-Developer/ComicsApp-Backend.git>
cd <ИМЯ_ПАПКИ>


### 2. Установка зависимостей
```sh
npm install dotenv express pg jsonwebtoken cors body-parser firebase-admin
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
FIREBASE_PROJECT_ID=<ID_ПРОЕКТА_FIREBASE>
FIREBASE_CLIENT_EMAIL=<ВАШ_FIREBASE_EMAIL>
FIREBASE_PRIVATE_KEY=<СЕКРЕТНЫЙ_КЛЮЧ_FIREBASE>
```
### 4. Получение всех секретных ключей
Ключ от базы данных вам предоставит ваш хостинг. Ключи для Firebase вы можете найти в настройках проекта после его создания 

## Запуск сервера
```sh
npm start
```
Сервер запустится на `http://localhost:3000` или будет использовать порт который вам назначит ваш хостинг

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

#### Изменение имени пользователя
**PUT** `/api/user/name`
```json
{
  "name": "New Name"
}
```

#### Изменение пароля
**PUT** `/api/user/password`
```json
{
  "currentPassword": "oldpass",
  "newPassword": "newpass"
}
```

#### Загрузка аватара
**POST** `/api/user/avatar`
```json
{
  "avatar": "base64-кодировка изображения"
}
```

#### Удаление аватара
**DELETE** `/api/user/avatar`

#### Управление уведомлениями
**PUT** `/api/user/notification_settings`
```json
{
  "enabled": true/false
}
```

#### Сохранение FCM токена
**POST** `/api/user/fcm_token`
```json
{
  "token": "fcm_token_value"
}
```

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

#### Получение информации о комиксе
**GET** `/api/comics/:comicsId/info`

### Управление страницами комикса
#### Добавление новой страницы
**POST** `/api/comics/pages/:comicsId`
```json
{
  "rows": 2,
  "columns": 3
}
```

#### Получение страницы
**GET** `/api/comics/pages/:pageId`

#### Удаление существующей страницы
**DELETE** `/api/comics/pages/:pageId`

### Управление изображениями
#### Добавление нового изображения
**POST** `/api/comics/pages/images/:pageId`
```json
{
  "cellIndex": 1,
  "image": "base64-кодировка"
}
```

#### Удаление существующего изображения
**DELETE** `/api/comics/pages/images/:imageId`

#### Обновление изображения
**PUT** `/api/comics/pages/images/:imageId`
```json
{
  "image": "base64-кодировка"
}
```

### Реакции на комиксы
#### Поставить/убрать лайк
**POST** `/api/comics/:id/like`

#### Проверить лайк
**GET** `/api/comics/:id/like`

#### Получить количество лайков
**GET** `/api/comics/:id/likes/count`

#### Добавить/удалить из избранного
**POST** `/api/comics/:id/favorite`

#### Проверить избранное
**GET** `/api/comics/:id/favorite`

#### Получить избранные комиксы
**GET** `/api/user/favorites`

### Комментарии
#### Добавить комментарий
**POST** `/api/comics/:comicsId/comments`
```json
{
  "text": "Текст комментария"
}
```

#### Удалить комментарий
**DELETE** `/api/comments/:commentId`

### Работа с пользователями
#### Получить информацию о пользователе
**GET** `/api/users/:userId`

#### Подписаться/отписаться
**POST** `/api/users/:userId/subscribe`

#### Проверить подписку
**GET** `/api/users/:userId/subscribe`

#### Получить подписчиков
**GET** `/api/users/:userId/subscribers`

#### Получить подписки
**GET** `/api/users/:userId/subscriptions`

### Проверка работоспособности сервера
**GET** `/health`

---

# Node.js Server for Comics

## Description
This `Node.js` server using `Express` and `PostgreSQL` provides an API for managing comics. It includes authentication with `JWT` and CRUD operations for users and comics.
This server is necessary for my native Android App application - https://github.com/Serjik-Developer/ComicsApp

## Installation
### 1. Clone the repository
```sh
git clone <https://github.com/Serjik-Developer/ComicsApp-Backend.git>
cd <FOLDER_NAME>
```

### 2. Install dependencies
```sh
npm install dotenv express pg jsonwebtoken cors body-parser firebase-admin
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
FIREBASE_PROJECT_ID=<FIREBASE_PROJECT_ID>
FIREBASE_CLIENT_EMAIL=<FIREBASE_CLIENT_EMAIL>
FIREBASE_PRIVATE_KEY=<FIREBASE_PRIVATE_KEY>
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

#### Update User Name
**PUT** `/api/user/name`
```json
{
  "name": "New Name"
}
```

#### Update Password
**PUT** `/api/user/password`
```json
{
  "currentPassword": "oldpass",
  "newPassword": "newpass"
}
```

#### Upload Avatar
**POST** `/api/user/avatar`
```json
{
  "avatar": "base64-encoded image"
}
```

#### Delete Avatar
**DELETE** `/api/user/avatar`

#### Notification Settings
**PUT** `/api/user/notification_settings`
```json
{
  "enabled": true/false
}
```

#### Save FCM Token
**POST** `/api/user/fcm_token`
```json
{
  "token": "fcm_token_value"
}
```

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

#### Get Comic Info
**GET** `/api/comics/:comicsId/info`

### Pages Management
#### Add New Page
**POST** `/api/comics/pages/:comicsId`
```json
{
  "rows": 2,
  "columns": 3
}
```

#### Get Page
**GET** `/api/comics/pages/:pageId`

#### Delete Page
**DELETE** `/api/comics/pages/:pageId`

### Images Management
#### Add New Image
**POST** `/api/comics/pages/images/:pageId`
```json
{
  "cellIndex": 1,
  "image": "base64-encoded"
}
```

#### Delete Image
**DELETE** `/api/comics/pages/images/:imageId`

#### Update Image
**PUT** `/api/comics/pages/images/:imageId`
```json
{
  "image": "base64-encoded"
}
```

### Reactions
#### Like/Unlike Comic
**POST** `/api/comics/:id/like`

#### Check Like
**GET** `/api/comics/:id/like`

#### Get Likes Count
**GET** `/api/comics/:id/likes/count`

#### Add/Remove Favorite
**POST** `/api/comics/:id/favorite`

#### Check Favorite
**GET** `/api/comics/:id/favorite`

#### Get Favorites
**GET** `/api/user/favorites`

### Comments
#### Add Comment
**POST** `/api/comics/:comicsId/comments`
```json
{
  "text": "Comment text"
}
```

#### Delete Comment
**DELETE** `/api/comments/:commentId`

### Users
#### Get User Info
**GET** `/api/users/:userId`

#### Subscribe/Unsubscribe
**POST** `/api/users/:userId/subscribe`

#### Check Subscription
**GET** `/api/users/:userId/subscribe`

#### Get Subscribers
**GET** `/api/users/:userId/subscribers`

#### Get Subscriptions
**GET** `/api/users/:userId/subscriptions`

### Server Health Check
**GET** `/health`
