import os
import json
import threading
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes

# Load local .env if it exists
load_dotenv()

# ==========================================
# 1. FIREBASE & CONFIG
# ==========================================
# Use the Environment Variable we set in the dashboard
service_json = os.environ.get('SERVICE_ACCOUNT_JSON')
if not service_json:
    # Fallback for local testing
    cred = credentials.Certificate('serviceAccount.json')
else:
    cred = credentials.Certificate(json.loads(service_json))

firebase_admin.initialize_app(cred)
db = firestore.client()

BOT_TOKEN = os.environ.get('BOT_TOKEN')
# Convert comma-separated string to list of integers
ADMIN_IDS = [int(i.strip()) for i in os.environ.get('ADMIN_CHAT_IDS', '').split(',') if i.strip()]

# Bilingual messages
MSG = {
    'askName': "እባክዎ ሙሉ ስምዎን ያስገቡ፡\n(Please enter your full name:)",
    'askPhone': "እባክዎ ስልክ ቁጥርዎን ያስገቡ፡\n(Please enter your phone number:)",
    'askPass': "እባክዎ የይለፍ ቃል ይፍጠሩ (ቢያንስ 4 አሃዞች)፡\n(Please create a password - at least 4 digits:)",
    'askPassConfirm': "እባክዎ የይለፍ ቃልዎን ያረጋግጡ፡\n(Please confirm your password:)",
    'payment': (
        "እባክዎ የክፍያውን 150 ብር ከታች ባሉት አካውንቶች ይክፈሉ፡\n"
        "(Please pay the 150 ETB registration fee...)\n\n"
        "🏦 CBE: 1000651098347 (yunus)\n"
        "📱 Telebirr: 0985711861 (yenus)\n\n"
        "ከዚያም ደረሰኝ ይላኩ። (Then upload the receipt.)"
    ),
    'wait': "እናመሰግናለን! ለማረጋገጫ ከ6-24 ሰዓታት ይጠብቁ።\n(Thank you! Please wait 6-24 hours for approval.)",
    'approved': "🎉 እንኳን ደስ አለዎት! መለያዎ ጸድቋል።\n(🎉 Congratulations! Your account has been approved.)",
    'rejected': "❌ ይቅርታ፣ አልጸደቀም። ድጋፍ ሰጪን ያነጋግሩ።\n(❌ Registration rejected. Contact support.)"
}

# ==========================================
# 2. BOT HANDLERS
# ==========================================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data['step'] = 'ASK_NAME'
    context.user_data['tg_username'] = f"@{update.effective_user.username}" if update.effective_user.username else "No Username"
    await update.message.reply_text(f"Welcome to the Bible App!\n\n{MSG['askName']}")

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    step = context.user_data.get('step')
    text = update.message.text
    
    if not step or text.startswith('/'): return

    if step == 'ASK_NAME':
        context.user_data['name'] = text
        context.user_data['step'] = 'ASK_PHONE'
        await update.message.reply_text(MSG['askPhone'])

    elif step == 'ASK_PHONE':
        context.user_data['phone'] = text
        context.user_data['step'] = 'ASK_PASS'
        await update.message.reply_text(MSG['askPass'])

    elif step == 'ASK_PASS':
        if len(text) < 4:
            await update.message.reply_text("Password too short (min 4 digits).")
        else:
            context.user_data['temp_pass'] = text
            context.user_data['step'] = 'CONFIRM_PASS'
            await update.message.reply_text(MSG['askPassConfirm'])

    elif step == 'CONFIRM_PASS':
        if text != context.user_data.get('temp_pass'):
            await update.message.reply_text("Passwords mismatch. Try again:")
        else:
            context.user_data['password'] = text
            context.user_data['step'] = 'ASK_PAYMENT'
            await update.message.reply_text(MSG['payment'])

async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if context.user_data.get('step') != 'ASK_PAYMENT': return

    # Save to Firestore
    user_phone = context.user_data['phone']
    db.collection('users').document(user_phone).set({
        'name': context.user_data['name'],
        'phone': user_phone,
        'password': context.user_data['password'],
        'tg_id': update.effective_user.id,
        'tg_chat_id': update.effective_chat.id,
        'isPaid': False
    })

    await update.message.reply_text(MSG['wait'])

    # Notify Admins
    keyboard = [[
        InlineKeyboardButton("✅ Approve", callback_data=f"approve_{user_phone}"),
        InlineKeyboardButton("❌ Reject", callback_data=f"reject_{user_phone}")
    ]]
    
    for admin_id in ADMIN_IDS:
        await context.bot.send_photo(
            chat_id=admin_id,
            photo=update.message.photo[-1].file_id,
            caption=f"🔔 New Request\n👤 Name: {context.user_data['name']}\n📱 Phone: {user_phone}",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    
    context.user_data.clear()

async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if update.effective_user.id not in ADMIN_IDS:
        await query.answer("Unauthorized", show_alert=True)
        return

    action, phone = query.data.split('_')
    user_ref = db.collection('users').document(phone)
    user_data = user_ref.get().to_dict()

    if action == 'approve':
        user_ref.update({'isPaid': True})
        await context.bot.send_message(user_data['tg_chat_id'], MSG['approved'])
        await query.edit_message_caption(caption=f"{query.message.caption}\n\n✅ Approved")
    else:
        await context.bot.send_message(user_data['tg_chat_id'], MSG['rejected'])
        await query.edit_message_caption(caption=f"{query.message.caption}\n\n❌ Rejected")

# ==========================================
# 3. HEALTH CHECK SERVER
# ==========================================
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"Bot is alive")

def run_health_server():
    port = int(os.environ.get('PORT', 8080))
    httpd = HTTPServer(('0.0.0.0', port), HealthHandler)
    httpd.serve_forever()

# ==========================================
# 4. MAIN
# ==========================================
if __name__ == '__main__':
    # Run Health check in background
    threading.Thread(target=run_health_server, daemon=True).start()

    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(CallbackQueryHandler(callback_handler))

    print("Python Bot is Polling...")
    app.run_polling()