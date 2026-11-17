import os
import json
import html
import asyncio
import urllib.request
from aiogram import Bot, Dispatcher, types
from aiogram.filters import CommandStart, CommandObject, Command
from aiogram.types import WebAppInfo, InlineKeyboardMarkup, InlineKeyboardButton

# Токен берется из переменных окружения сервера, либо пропиши прямо сюда
BOT_TOKEN = os.getenv("BOT_TOKEN", "СЮДА_ВСТАВЬ_ТОКЕН_ОТ_BOTFATHER")

# Ссылка на твой хостинг с Mini App (index.html)
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://kolos1337valide.github.io/vetruch-telegram-bot/?v=1794599457")

# ID закрытой группы, куда бот будет слать мечты (например: -1001234567890)
DREAMS_GROUP_ID = int(os.getenv("DREAMS_GROUP_ID", "-5488019144"))

ADMIN_IDS = {1067693099, 978548564}
FIREBASE_DB_URL = "https://vetruchbot-default-rtdb.firebaseio.com"

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()


def fb_request(path: str, method: str = "GET", data=None):
    url = f"{FIREBASE_DB_URL}/{path}.json"
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else None


def mark_known_user(user_id: str):
    try:
        if user_id:
            fb_request(f"vetruch_app/known_users/{user_id}", method="PUT", data=True)
    except Exception as e:
        print("Known user error:", e)


def register_referral_in_firebase(new_user_id: str, inviter_id: str) -> bool:
    try:
        if not new_user_id or not inviter_id or new_user_id == inviter_id:
            return False

        already_ref = fb_request(f"vetruch_app/referred_by/{new_user_id}")
        existing_user = fb_request(f"vetruch_app/users/{new_user_id}")
        existing_bal = fb_request(f"vetruch_app/balances/{new_user_id}")
        known = fb_request(f"vetruch_app/known_users/{new_user_id}")

        if already_ref or existing_user is not None or existing_bal is not None or known:
            if not known:
                fb_request(f"vetruch_app/known_users/{new_user_id}", method="PUT", data=True)
            return False

        fb_request(f"vetruch_app/known_users/{new_user_id}", method="PUT", data=True)
        fb_request(f"vetruch_app/referred_by/{new_user_id}", method="PUT", data=inviter_id)

        refs = fb_request(f"vetruch_app/referrals/{inviter_id}")
        if isinstance(refs, dict):
            refs = list(refs.values())
        if not isinstance(refs, list):
            refs = []

        if new_user_id not in refs:
            refs.append(new_user_id)
            fb_request(f"vetruch_app/referrals/{inviter_id}", method="PUT", data=refs)

        if len(refs) >= 3:
            reward_done = fb_request(f"vetruch_app/ref_reward_done/{inviter_id}")
            if not reward_done:
                fb_request(f"vetruch_app/ref_reward_done/{inviter_id}", method="PUT", data=True)
                cur_bal = fb_request(f"vetruch_app/balances/{inviter_id}")
                cur_bal = int(cur_bal) if cur_bal is not None else 500
                fb_request(f"vetruch_app/balances/{inviter_id}", method="PUT", data=cur_bal + 500)

        return True
    except Exception as e:
        print("Referral error:", e)
        return False


async def dreams_watcher():
    while True:
        try:
            if DREAMS_GROUP_ID != 0:
                queue = await asyncio.to_thread(fb_request, "vetruch_app/dreams_queue")
                if isinstance(queue, dict):
                    for key, item in queue.items():
                        if not isinstance(item, dict) or not item.get("text"):
                            await asyncio.to_thread(fb_request, f"vetruch_app/dreams_queue/{key}", "DELETE")
                            continue

                        uid = html.escape(str(item.get("userId") or ""))
                        fname = html.escape(str(item.get("firstName") or "Игрок"))
                        uname = html.escape(str(item.get("username") or "").strip())
                        dream_text = html.escape(str(item.get("text") or ""))

                        user_line = f'<a href="tg://user?id={uid}">{fname}</a>'
                        if uname:
                            user_line += f" ({uname})"

                        msg = (
                            "🌟 <b>Новая мечта!</b>\n\n"
                            f"👤 Игрок: {user_line}\n"
                            f"🆔 ID: <code>{uid}</code>\n\n"
                            f"💭 <b>Мечта:</b>\n{dream_text}"
                        )

                        await bot.send_message(chat_id=DREAMS_GROUP_ID, text=msg, parse_mode="HTML")
                        await asyncio.to_thread(fb_request, f"vetruch_app/dreams_queue/{key}", "DELETE")
        except Exception as e:
            print("Dreams watcher error:", e)
        await asyncio.sleep(4)


@dp.message(Command("chatid"))
async def chatid_handler(message: types.Message):
    if message.from_user and message.from_user.id in ADMIN_IDS:
        await message.reply(f"ID этого чата: <code>{message.chat.id}</code>", parse_mode="HTML")


@dp.message(CommandStart())
async def start_handler(message: types.Message, command: CommandObject):
    user_name = message.from_user.first_name or "друг"
    user_id_str = str(message.from_user.id)
    raw_args = (command.args or "").strip()
    ref_id = raw_args.replace("ref_", "").strip() if raw_args else ""

    app_url = WEBAPP_URL
    if ref_id and ref_id.isdigit() and ref_id != user_id_str:
        is_new_ref = await asyncio.to_thread(register_referral_in_firebase, user_id_str, ref_id)
        if is_new_ref:
            sep = "&" if "?" in WEBAPP_URL else "?"
            app_url = f"{WEBAPP_URL}{sep}ref={ref_id}"
    else:
        await asyncio.to_thread(mark_known_user, user_id_str)

    caption_text = (
        f"Привет, {user_name}! Добро пожаловать в <b>Vetruch_bot</b> — твой личный хаб бонусов! ⚡\n\n"
        "• Смотри стримы и получай бонусы! 📺\n"
        "• Выполняй квесты и фарми монеты без остановки 🪙\n"
        "• Забирай гарантированные призы и выигрывай в розыгрышах 🎁\n\n"
        "Начинай копить монеты прямо сейчас, чтобы не упустить крутой дроп! 🔥"
    )

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🎮 Открыть приложение", web_app=WebAppInfo(url=app_url))]
    ])

    photo_path = os.path.join(os.path.dirname(__file__), "welcome.jpg")
    if os.path.exists(photo_path):
        photo = types.FSInputFile(photo_path)
        await message.answer_photo(photo=photo, caption=caption_text, reply_markup=keyboard, parse_mode="HTML")
    else:
        await message.answer(caption_text, reply_markup=keyboard, parse_mode="HTML")


async def main():
    print("✅ Бот успешно запущен!")
    watcher_task = asyncio.create_task(dreams_watcher())
    try:
        await dp.start_polling(bot)
    finally:
        watcher_task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
