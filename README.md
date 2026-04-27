# Telegram -> VK / MAX Crossposting

Один сервис для нескольких направлений публикации.

Сейчас шаблон рассчитан на два профиля:

- `football`: Telegram -> VK
- `flowers`: Telegram -> VK + MAX

## Настройка

1. Скопируй [`.env.example`](./.env.example) в `.env`.
2. Заполни общий `TELEGRAM_BOT_TOKEN`.
3. Для `football` укажи исходный Telegram-канал и VK-группу.
4. Для `flowers` укажи исходный Telegram-канал, VK-группу и MAX-чат.
5. Добавь Telegram-бота администратором в оба исходных канала.
6. Для MAX сначала добавь бота в нужный чат/канал, затем выполни `npm run max:chats -- flowers`, чтобы узнать `FLOWERS_MAX_CHAT_ID`.

## Команды

- `npm start` - запуск всех профилей
- `npm run check` - проверка Telegram/VK/MAX подключений
- `npm run max:chats -- flowers` - список доступных MAX-чатов для профиля

## Что заполнить

### Football Club

- `FOOTBALL_TELEGRAM_SOURCE_CHAT_ID` или `FOOTBALL_TELEGRAM_SOURCE_CHAT_USERNAME`
- `FOOTBALL_VK_ACCESS_TOKEN`
- `FOOTBALL_VK_GROUP_ID`

### Flower Shop

- `FLOWERS_TELEGRAM_SOURCE_CHAT_ID` или `FLOWERS_TELEGRAM_SOURCE_CHAT_USERNAME`
- `FLOWERS_VK_ACCESS_TOKEN`
- `FLOWERS_VK_GROUP_ID`
- `FLOWERS_MAX_ACCESS_TOKEN`
- `FLOWERS_MAX_CHAT_ID`
