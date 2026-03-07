import os
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from dotenv import load_dotenv
import telebot
from telebot import types
import firebase_admin
from firebase_admin import credentials, firestore

# 1. LOAD CONFIG & DOTENV
load_dotenv()
BOT_TOKEN = os.environ.get('BOT_TOKEN')
ADMIN_IDS = [int(i.strip()) for i in os.environ.get('ADMIN_CHAT_IDS', '').split(',') if i.strip()]

# 2. FIREBASE SETUP
service_json = os.environ.get('SERVICE_ACCOUNT_JSON')
if not service_json:
    cred = credentials.Certificate('serviceAccount.json')
else:
    cred = credentials.Certificate(json.loads(service_json))

firebase_admin.initialize_app(cred)
db = firestore.client()

# 3. INITIALIZE BOT
bot = telebot.TeleBot(BOT_TOKEN)

# Bilingual messages (Exact copy of your data)
MSG = {
    'askName': "እባክዎ ሙሉ ስምዎን ያስገቡ፡\n(Please enter your full name:)",
    'askPhone': "እባክዎ ስልክ ቁጥርዎን ያስገቡ፡\n(Please enter your phone number:)",
    'askPass': "እባክዎ የይለፍ ቃል ይፍጠሩ (ቢያንስ 4 አሃዞች)፡\n(Please create a password - at least 4 digits:)",
    'payment': (
        "እባክዎ የክፍያውን 150 ብር ከታች ባሉት አካውንቶች ይክፈሉ፡\n"
        "(Please pay the 150 ETB registration fee...)\n\n"
        "🏦 CBE: 1000651098347 (yunus)\n"
        "ከዚያም ደረሰኝ ይላኩ። (Then upload the receipt.)"
    ),
    'wait': "እናመሰግናለን! ለማረጋገጫ ከ6-24 ሰዓታት ይጠብቁ።\n(Thank you! Please wait 6-24 hours for approval.)",
    'approved': "🎉 እንኳን ደስ አለዎት! መለያዎ ጸድቋል፡፡\n(🎉 Congratulations! Your account has been approved.)",
    'rejected': "❌ ይቅርታ፣ አልጸደቀም። (Registration rejected.)"
}

# ==========================================
# 4. BOT LOGIC (CONVERSATION FLOW)
# ==========================================

@bot.message_handler(commands=['start'])
def send_welcome(message):
    msg = bot.reply_to(message, f"Welcome to the Bible App!\n\n{MSG['askName']}")
    bot.register_next_step_handler(msg, process_name_step)

def process_name_step(message):
    chat_id = message.chat.id
    name = message.text
    msg = bot.send_message(chat_id, MSG['askPhone'])
    bot.register_next_step_handler(msg, process_phone_step, name)

def process_phone_step(message, name):
    chat_id = message.chat.id
    phone = message.text
    msg = bot.send_message(chat_id, MSG['askPass'])
    bot.register_next_step_handler(msg, process_pass_step, name, phone)

def process_pass_step(message, name, phone):
    chat_id = message.chat.id
    password = message.text
    if len(password) < 4:
        msg = bot.send_message(chat_id, "Password too short. Try again:")
        bot.register_next_step_handler(msg, process_pass_step, name, phone)
        return
    
    msg = bot.send_message(chat_id, MSG['payment'], parse_mode='Markdown')
    bot.register_next_step_handler(msg, process_payment_step, name, phone, password)

def process_payment_step(message, name, phone, password):
    chat_id = message.chat.id
    if not message.photo:
        msg = bot.send_message(chat_id, "Please upload a photo of the receipt:")
        bot.register_next_step_handler(msg, process_payment_step, name, phone, password)
        return

    # Save to Firestore
    db.collection('users').document(phone).set({
        'name': name,
        'phone': phone,
        'password': password,
        'chat_id': chat_id,
        'isPaid': False
    })

    bot.send_message(chat_id, MSG['wait'])

    # Notify Admins
    markup = types.InlineKeyboardMarkup()
    markup.add(types.InlineKeyboardButton("✅ Approve", callback_data=f"app_{phone}"),
               types.InlineKeyboardButton("❌ Reject", callback_data=f"rej_{phone}"))

    for admin_id in ADMIN_IDS:
        bot.send_photo(admin_id, message.photo[-1].file_id, 
                       caption=f"🔔 New User: {name}\n📱 Phone: {phone}", 
                       reply_markup=markup)

@bot.callback_query_handler(func=lambda call: True)
def callback_query(call):
    if call.from_user.id not in ADMIN_IDS: return

    action, phone = call.data.split('_')
    user_ref = db.collection('users').document(phone)
    user_data = user_ref.get().to_dict()

    if action == "app":
        user_ref.update({'isPaid': True})
        bot.send_message(user_data['chat_id'], MSG['approved'])
        bot.edit_message_caption(f"{call.message.caption}\n\n✅ APPROVED", call.message.chat.id, call.message.message_id)
    else:
        bot.send_message(user_data['chat_id'], MSG['rejected'])
        bot.edit_message_caption(f"{call.message.caption}\n\n❌ REJECTED", call.message.chat.id, call.message.message_id)

# ==========================================
# 5. HEALTH CHECK SERVER (For JustRunMy.App)
# ==========================================
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"Bot is active on Python 3.14")

def run_health_server():
    httpd = HTTPServer(('0.0.0.0', int(os.environ.get('PORT', 8080))), HealthHandler)
    httpd.serve_forever()

if __name__ == '__main__':
    # Start the health check server
    threading.Thread(target=run_health_server, daemon=True).start()
    
    # TELL TELEGRAM TO FORGET VERCEL
    print("Clearing old webhooks...")
    bot.remove_webhook()
    
    print("🚀 Telebot is running on Python 3.14...")
    bot.infinity_polling()