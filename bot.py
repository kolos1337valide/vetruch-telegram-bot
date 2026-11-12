import os
import asyncio
from aiogram import Bot, Dispatcher, types
from aiogram.filters import CommandStart
from aiogram.types import WebAppInfo, InlineKeyboardMarkup, InlineKeyboardButton

# Токен берется из переменных окружения сервера, либо пропиши прямо сюда
BOT_TOKEN = os.getenv("BOT_TOKEN", "СЮДА_ВСТАВЬ_ТОКЕН_ОТ_BOTFATHER")

# Ссылка на твой хостинг с Mini App (index.html)
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://kolos1337valide.github.io/vetruch-telegram-bot/")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

@dp.message(CommandStart())
async def start_handler(message: types.Message):
    user_name = message.from_user.first_name or "друг"
    
    caption_text = (
        f"Привет, {user_name}! Добро пожаловать в <b>Vetruch_bot</b> — твой личный хаб бонусов! ⚡\n\n"
        "• Смотри стримы и получай бонусы! 📺\n"
        "• Выполняй квесты и фарми монеты без остановки 🪙\n"
        "• Забирай гарантированные призы и выигрывай в розыгрышах 🎁\n\n"
        "Начинай копить монеты прямо сейчас, чтобы не упустить крутой дроп! 🔥"
    )

    # Кнопка открытия Mini App
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🎮 Открыть приложение", web_app=WebAppInfo(url=WEBAPP_URL))]
    ])

    photo_path = os.path.join(os.path.dirname(__file__), "welcome.jpg")
    if os.path.exists(photo_path):
        photo = types.FSInputFile(photo_path)
        await message.answer_photo(photo=photo, caption=caption_text, reply_markup=keyboard, parse_mode="HTML")
    else:
        # Если картинка не найдена, отправляем текстом с кнопкой
        await message.answer(caption_text, reply_markup=keyboard, parse_mode="HTML")

async def main():
    print("✅ Бот успешно запущен!")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
