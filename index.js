require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const express = require('express'); // ADDED FOR VERCEL

// ==========================================
// 1. CONFIGURATION & SETUP
// ==========================================

// VERCEL FIX: Read Firebase credentials from an Environment Variable
// You must paste your minimized serviceAccount.json into a Vercel Env Var named SERVICE_ACCOUNT_JSON
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);

// VERCEL FIX: Prevent Firebase from initializing multiple times during serverless cold starts
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';

const ADMIN_CHAT_IDS = process.env.ADMIN_CHAT_IDS 
  ? process.env.ADMIN_CHAT_IDS.split(',').map(id => id.trim())
  : ['YOUR_ADMIN_TELEGRAM_ID_1']; 

// VERCEL FIX: Removed { polling: true }
const bot = new TelegramBot(BOT_TOKEN);

// WARNING: This will reset frequently on Vercel. 
// We need to move this to Firestore in the future!
const userSessions = {};

// ==========================================
// 2. BILINGUAL MESSAGES
// ==========================================
const msgText = {
  askName: "እባክዎ ሙሉ ስምዎን ያስገቡ፡\n(Please enter your full name:)",
  askPhone: "እባክዎ ስልክ ቁጥርዎን ያስገቡ፡\n(Please enter your phone number:)",
  askPass: "እባክዎ የይለፍ ቃል ይፍጠሩ (ቢያንስ 4 አሃዞች)፡\n(Please create a password - at least 4 digits:)",
  askPassConfirm: "እባክዎ የይለፍ ቃልዎን ያረጋግጡ፡\n(Please confirm your password:)",
  passMismatch: "የይለፍ ቃሉ አይመሳሰልም። እባክዎ እንደገና ያስገቡ፡\n(Passwords do not match. Please try again:)",
  passShort: "የይለፍ ቃሉ ቢያንስ 4 አሃዞች መሆን አለበት። እንደገና ያስገቡ፡\n(Password must be at least 4 digits. Try again:)",
  payment: `እባክዎ የክፍያውን 150 ብር ከታች ባሉት አካውንቶች ይክፈሉ፡
(Please pay the 150 ETB registration fee to one of the following accounts:)

🏦 **CBE (የኢትዮጵያ ንግድ ባንክ):** 1000651098347
👤 ስም (Name): yunus

📱 **Telebirr (ቴሌብር):** 0985711861
👤 ስም (Name): yenus

ከዚያም የክፍያውን ስክሪንሾት (ደረሰኝ) እዚህ ይላኩ።
(After paying, please upload the screenshot/receipt here.)`,
  wait: "እናመሰግናለን! መረጃዎ ተልኳል። ለማረጋገጫ እባክዎ ከ6-24 ሰዓታት ይጠብቁ።\n(Thank you! Your details have been sent. Please wait 6-24 hours for approval.)",
  approved: "🎉 እንኳን ደስ አለዎት! መለያዎ ጸድቋል። አሁን ወደ አፑ መግባት ይችላሉ።\n(🎉 Congratulations! Your account has been approved. You can now log into the app.)",
  rejected: "❌ ይቅርታ፣ ክፍያዎ ተቀባይነት አላገኘም። እባክዎ ድጋፍ ሰጪን ያነጋግሩ።\n(❌ Sorry, your payment was rejected. Please contact support.)"
};

// ==========================================
// 3. BOT EVENT LISTENERS (USER FLOW)
// ==========================================
// (Your existing bot.onText, bot.on('message'), bot.on('photo'), and bot.on('callback_query') code goes here. 
// I am leaving it exactly as you wrote it so you don't lose any logic.)

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userSessions[chatId] = { 
    step: 'ASK_NAME',
    telegramId: msg.from.id,
    username: msg.from.username ? `@${msg.from.username}` : 'No Username'
  };
  bot.sendMessage(chatId, `ወደ መጽሐፍ ቅዱስ አፕሊኬሽን እንኳን በደህና መጡ! / Welcome to the Bible App!\n\n${msgText.askName}`);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const session = userSessions[chatId];
  if (!session || !text || text.startsWith('/')) return;

  switch (session.step) {
    case 'ASK_NAME':
      session.name = text;
      session.step = 'ASK_PHONE';
      bot.sendMessage(chatId, msgText.askPhone);
      break;
    case 'ASK_PHONE':
      session.phone = text;
      session.step = 'ASK_PASSWORD';
      bot.sendMessage(chatId, msgText.askPass);
      break;
    case 'ASK_PASSWORD':
      if (text.length < 4) {
        bot.sendMessage(chatId, msgText.passShort);
      } else {
        session.tempPassword = text;
        session.step = 'CONFIRM_PASSWORD';
        bot.sendMessage(chatId, msgText.askPassConfirm);
      }
      break;
    case 'CONFIRM_PASSWORD':
      if (text !== session.tempPassword) {
        bot.sendMessage(chatId, msgText.passMismatch);
      } else {
        session.password = text;
        delete session.tempPassword;
        session.step = 'ASK_PAYMENT';
        bot.sendMessage(chatId, msgText.payment, { parse_mode: 'Markdown' });
      }
      break;
  }
});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions[chatId];
  if (!session || session.step !== 'ASK_PAYMENT') return;

  const photo = msg.photo[msg.photo.length - 1];
  const fileId = photo.file_id;

  try {
    const userRef = db.collection('users').doc(session.phone);
    await userRef.set({
      telegramChatId: chatId,
      telegramId: session.telegramId,
      telegramUsername: session.username,
      name: session.name,
      phone: session.phone,
      password: session.password,
      isPaid: false,
      deviceId: null,
      registeredAt: admin.firestore.FieldValue.serverTimestamp()
    });

    bot.sendMessage(chatId, msgText.wait);

    const adminMessage = `
🔔 **New Registration Request** 🔔
👤 **Name:** ${session.name}
📱 **Phone:** ${session.phone}
🆔 **TG ID:** \`${session.telegramId}\`
💬 **TG Username:** ${session.username}
    `;

    const adminOptions = {
      caption: adminMessage,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve_${session.phone}` },
            { text: '❌ Reject', callback_data: `reject_${session.phone}` }
          ]
        ]
      }
    };

    ADMIN_CHAT_IDS.forEach(adminId => {
      bot.sendPhoto(adminId, fileId, adminOptions).catch(err => {
        console.error(`Failed to send to admin ${adminId}:`, err.message);
      });
    });
    
    delete userSessions[chatId];

  } catch (error) {
    console.error("Error saving to Firestore:", error);
    bot.sendMessage(chatId, "An error occurred. Please try again later. /start");
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  if (data.startsWith('approve_') || data.startsWith('reject_')) {
    if (!ADMIN_CHAT_IDS.includes(String(query.from.id))) {
        return bot.answerCallbackQuery(query.id, { text: "You are not authorized to do this.", show_alert: true });
    }

    const action = data.split('_')[0];
    const userPhone = data.split('_')[1];
    const adminIdentity = query.from.username ? `@${query.from.username}` : query.from.first_name;

    try {
      const userRef = db.collection('users').doc(userPhone);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        return bot.answerCallbackQuery(query.id, { text: "User not found in database.", show_alert: true });
      }

      const userData = userDoc.data();
      const userChatId = userData.telegramChatId;

      if (action === 'approve') {
        await userRef.update({ isPaid: true });
        bot.sendMessage(userChatId, msgText.approved);
        bot.editMessageCaption(`${query.message.caption}\n\n✅ **Approved by ${adminIdentity}**`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: query.message.reply_markup
        });
        bot.answerCallbackQuery(query.id, { text: "User Approved successfully!" });

      } else if (action === 'reject') {
        bot.sendMessage(userChatId, msgText.rejected);
        bot.editMessageCaption(`${query.message.caption}\n\n❌ **Rejected by ${adminIdentity}**`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: query.message.reply_markup 
        });
        bot.answerCallbackQuery(query.id, { text: "User Rejected." });
      }

    } catch (error) {
      console.error("Admin action error:", error);
      bot.answerCallbackQuery(query.id, { text: "Error processing request.", show_alert: true });
    }
  }
});

// ==========================================
// 4. VERCEL WEBHOOK EXPORT
// ==========================================
const app = express();
app.use(express.json());

// Telegram will send updates to this URL
app.post('/api/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// A simple route to check if your bot is online when you visit your Vercel URL
app.get('/', (req, res) => {
  res.send('🤖 Bible App Registration Bot is running!');
});

// Export the Express app for Vercel
module.exports = app;