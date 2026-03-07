// api/webhook.js
// Webhook server for Telegram registration bot (Vercel serverless friendly).
// ENV required: BOT_TOKEN, ADMIN_CHAT_IDS (comma list), SERVICE_ACCOUNT_JSON (stringified JSON)

const fetch = require('node-fetch');
const admin = require('firebase-admin');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SERVICE_ACCOUNT_JSON = process.env.SERVICE_ACCOUNT_JSON;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var');
}
if (!SERVICE_ACCOUNT_JSON) {
  console.error('Missing SERVICE_ACCOUNT_JSON env var');
}

const TELEGRAM_API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

function tgApi(method, body) {
  return fetch(`${TELEGRAM_API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

function tgSendMessage(chatId, text, opts = {}) {
  const body = { chat_id: chatId, text, ...opts };
  return tgApi('sendMessage', body);
}
function tgSendPhoto(chatId, photo, caption = '', opts = {}) {
  const body = { chat_id: chatId, photo, caption, ...opts };
  return tgApi('sendPhoto', body);
}
function tgAnswerCallback(queryId, opts = {}) {
  return tgApi('answerCallbackQuery', { callback_query_id: queryId, ...opts });
}
function tgEditMessageCaption(chatId, messageId, caption, opts = {}) {
  const body = { chat_id: chatId, message_id: messageId, caption, ...opts };
  return tgApi('editMessageCaption', body);
}

// Initialize Firebase Admin (safe for serverless - init only once)
function initFirebase() {
  if (admin.apps && admin.apps.length) return;
  const sa = JSON.parse(SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
}
try {
  initFirebase();
} catch (e) {
  console.error('Firebase init error', e);
}
const db = admin.firestore();

// Utility: safe doc id from phone or fallback chatId
function userDocIdFrom(phone, chatId) {
  if (phone && String(phone).trim()) {
    return String(phone).replace(/\s+/g, '');
  }
  return String(chatId);
}

// Messages (bilingual prompts)
const M = {
  chooseLang: 'Please choose a language / እባክዎ ቋንቋ ይምረጡ።',
  askName: { am: 'እባክዎ ሙሉ ስምዎን ያስገቡ።', en: 'Please enter your full name:' },
  askPhone: { am: 'እባክዎ ስልክ ቁጥርዎን ያስገቡ።', en: 'Please enter your phone number:' },
  askPass: { am: 'እባክዎ 4 የሚገባ የይለፍ ቃል ይፍጠሩ።', en: 'Please create a password (min 4 chars):' },
  confirmPass: { am: 'እባክዎ የይለፍ ቃልዎን ያረጋግጡ።', en: 'Please confirm your password:' },
  passShort: { am: 'የይለፍ ቃሉ አጭር ነው። 4 አሃዞች ይወስዱ።', en: 'Password too short; min 4 chars.' },
  passMismatch: { am: 'የይለፍ ቃሉ አይመሳሰልም። እንደገና ይሞክሩ።', en: 'Passwords do not match. Try again.' },
  paymentInstructionAm:
    'እባክዎ 150 ብር ይክፈሉ።\nCBE: 1000651098347 (yunus)\nTelebirr: 0985711861 (yenus)\nከዚያም የክፍያ ስክሪንሾት ይላኩ።',
  paymentInstructionEn:
    'Please pay 150 ETB to:\nCBE: 1000651098347 (yunus)\nTelebirr: 0985711861 (yenus)\nThen upload the payment screenshot here.',
  thanksWait: { am: 'መረጃዎት ተቀብሏል። 6-24 ሰዓታት ይጠብቁ።', en: 'Thanks! Your payment is submitted. Please wait 6-24 hours.' },
  approved: { am: '🎉 መለያዎ ተፈትሏል። አሁን መግባት ይችላሉ።', en: '🎉 Your account is approved. You can now log in.' },
  rejected: { am: '❌ ክፍያዎ አልተቀበለም። እባክዎ ያገለግሉ።', en: '❌ Your payment was rejected. Contact support.' }
};

// Handle language keyboard
function langKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'አማርኛ', callback_data: 'lang_am' }, { text: 'English', callback_data: 'lang_en' }]
      ]
    }
  };
}

// Admin approve/reject keyboard
function adminKeyboardFor(userPhoneOrId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve_${userPhoneOrId}` },
          { text: '❌ Reject', callback_data: `reject_${userPhoneOrId}` }
        ]
      ]
    }
  };
}

// MAIN exported handler for Vercel serverless (req/res)
module.exports = async (req, res) => {
  try {
    // Telegram will POST updates here
    if (req.method !== 'POST') {
      res.status(200).send('OK');
      return;
    }

    const update = req.body;

    // CALLBACK QUERY (inline button clicks)
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data;
      const from = cb.from;
      const cbId = cb.id;

      // Language selection
      if (data === 'lang_am' || data === 'lang_en') {
        const lang = data === 'lang_am' ? 'am' : 'en';
        await db.collection('registrations').doc(String(from.id)).set(
          {
            step: 'ASK_NAME',
            lang,
            telegramId: from.id,
            telegramUsername: from.username || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        // Ask name in chosen language
        const ask = lang === 'am' ? M.askName.am : M.askName.en;
        await tgSendMessage(from.id, ask);
        await tgAnswerCallback(cbId, lang === 'am' ? 'አማርኛ ተመርጧል' : 'English selected');
        res.status(200).send('ok');
        return;
      }

      // Admin actions: approve_<phoneOrId> or reject_<phoneOrId>
      if (data && (data.startsWith('approve_') || data.startsWith('reject_'))) {
        const allowed = ADMIN_CHAT_IDS.includes(String(from.id));
        if (!allowed) {
          await tgAnswerCallback(cbId, 'Not authorized');
          res.status(200).send('ok');
          return;
        }
        const [action, userKey] = data.split('_');
        const userDocId = String(userKey);
        // Update user doc in Firestore
        const userRef = db.collection('users').doc(userDocId);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          await tgAnswerCallback(cbId, 'User not found');
          res.status(200).send('ok');
          return;
        }
        const userData = userSnap.data();
        if (action === 'approve') {
          await userRef.update({
            isPaid: true,
            approvedBy: from.username || from.id,
            approvedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          // notify user
          if (userData && userData.telegramChatId) {
            await tgSendMessage(userData.telegramChatId, M.approved[userData.lang || 'en'] || M.approved.en);
          }
          // annotate admin message
          try {
            const newCaption = (cb.message.caption || '') + `\n\n✅ Approved by ${from.username || from.first_name}`;
            await tgEditMessageCaption(cb.message.chat.id, cb.message.message_id, newCaption);
          } catch (e) {
            console.warn('Failed to edit admin message caption', e && e.message);
          }
          await tgAnswerCallback(cbId, 'User approved');
        } else {
          // reject
          await userRef.update({
            isPaid: false,
            rejectedBy: from.username || from.id,
            rejectedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          if (userData && userData.telegramChatId) {
            await tgSendMessage(userData.telegramChatId, M.rejected[userData.lang || 'en'] || M.rejected.en);
          }
          try {
            const newCaption = (cb.message.caption || '') + `\n\n❌ Rejected by ${from.username || from.first_name}`;
            await tgEditMessageCaption(cb.message.chat.id, cb.message.message_id, newCaption);
          } catch (e) {
            console.warn('Failed to edit admin message caption', e && e.message);
          }
          await tgAnswerCallback(cbId, 'User rejected');
        }
        res.status(200).send('ok');
        return;
      }

      // default
      await tgAnswerCallback(cbId, 'Unknown action');
      res.status(200).send('ok');
      return;
    }

    // MESSAGE updates
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const from = msg.from || {};
      const text = msg.text || null;

      // Fetch registration in-progress if exists
      const regRef = db.collection('registrations').doc(String(chatId));
      const regSnap = await regRef.get();
      const reg = regSnap.exists ? regSnap.data() : null;

      // If /start command — initialize and ask language
      if (text && text.startsWith('/start')) {
        // create registration entry or merge
        await regRef.set(
          {
            step: 'ASK_LANGUAGE',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            telegramId: from.id,
            telegramUsername: from.username || null
          },
          { merge: true }
        );
        await tgSendMessage(chatId, M.chooseLang, langKeyboard());
        res.status(200).send('ok');
        return;
      }

      // If no registration entry but user sends text, prompt /start
      if (!reg) {
        // do nothing OR invite to /start
        // we won't spam; just return ok
        res.status(200).send('ok');
        return;
      }

      // If registration in progress
      const step = reg.step || 'ASK_LANGUAGE';
      const lang = reg.lang || 'en';
      const t = (obj) => (typeof obj === 'string' ? obj : obj[lang] || obj.en);

      // Steps: ASK_NAME -> ASK_PHONE -> ASK_PASSWORD -> CONFIRM_PASSWORD -> ASK_PAYMENT -> WAITING_PAYMENT
      if (step === 'ASK_NAME' && text) {
        await regRef.update({ name: text, step: 'ASK_PHONE' });
        await tgSendMessage(chatId, t(M.askPhone));
        res.status(200).send('ok');
        return;
      }

      if (step === 'ASK_PHONE' && text) {
        const phone = text.trim();
        await regRef.update({ phone, step: 'ASK_PASSWORD' });
        await tgSendMessage(chatId, t(M.askPass));
        res.status(200).send('ok');
        return;
      }

      if (step === 'ASK_PASSWORD' && text) {
        if (text.length < 4) {
          await tgSendMessage(chatId, t(M.passShort));
          res.status(200).send('ok');
          return;
        }
        await regRef.update({ tempPassword: text, step: 'CONFIRM_PASSWORD' });
        await tgSendMessage(chatId, t(M.confirmPass));
        res.status(200).send('ok');
        return;
      }

      if (step === 'CONFIRM_PASSWORD' && text) {
        if (!reg.tempPassword || text !== reg.tempPassword) {
          await tgSendMessage(chatId, t(M.passMismatch));
          res.status(200).send('ok');
          return;
        }
        // Save final password (NOTE: production: hash passwords!)
        await regRef.update({
          password: reg.tempPassword,
          tempPassword: admin.firestore.FieldValue.delete(),
          step: 'ASK_PAYMENT'
        });
        // Send payment instructions
        const payMsg = reg.lang === 'am' ? M.paymentInstructionAm : M.paymentInstructionEn;
        await tgSendMessage(chatId, payMsg);
        res.status(200).send('ok');
        return;
      }

      // If user sends a photo while in ASK_PAYMENT
      if (msg.photo && reg && reg.step === 'ASK_PAYMENT') {
        // highest res photo
        const photo = msg.photo[msg.photo.length - 1];
        const fileId = photo.file_id;
        // save user doc keyed by phone if provided else chatId
        const phoneKey = reg.phone ? String(reg.phone).replace(/\s+/g, '') : String(chatId);
        const userRef = db.collection('users').doc(phoneKey);
        await userRef.set(
          {
            telegramChatId: chatId,
            telegramId: from.id,
            telegramUsername: from.username || null,
            name: reg.name || null,
            phone: reg.phone || null,
            password: reg.password || null, // in prod: store hashed password instead
            lang: reg.lang || 'en',
            isPaid: false,
            paymentPhotoFileId: fileId,
            registeredAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        // notify user
        await tgSendMessage(chatId, t(M.thanksWait));

        // notify admins with photo and approve/reject buttons
        const caption = `🔔 New registration\nName: ${reg.name || '-'}\nPhone: ${reg.phone || '-'}\nTG: @${from.username || ''}\nChatId: ${chatId}`;
        // send photo to each admin
        for (const adminId of ADMIN_CHAT_IDS) {
          try {
            await tgSendPhoto(adminId, fileId, caption, adminKeyboardFor(phoneKey));
          } catch (e) {
            console.warn('Failed to send photo to admin', adminId, e && e.message);
          }
        }

        // update registration status
        await regRef.update({ step: 'WAITING_PAYMENT', paymentPhotoFileId: fileId });

        res.status(200).send('ok');
        return;
      }

      // If user sends photo but not in payment step - gentle reminder
      if (msg.photo) {
        await tgSendMessage(chatId, reg.lang === 'am' ? 'እባክዎ በክፍያ ሂደት መላእክት ላይ ይላኩ።' : 'Please follow the registration flow and upload payment photo when requested.');
        res.status(200).send('ok');
        return;
      }

      // For ASK_PAYMENT step if user sends text - remind
      if (step === 'ASK_PAYMENT' && text) {
        await tgSendMessage(chatId, reg.lang === 'am' ? 'እባክዎ የክፍያ ስክሪንሾት ይላኩ።' : 'Please upload payment screenshot/receipt.');
        res.status(200).send('ok');
        return;
      }

      // fallback
      res.status(200).send('ok');
      return;
    }

    // nothing else to do
    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook handler error:', err && (err.stack || err.message || err));
    // Always respond 200 to Telegram to avoid retries on non-critical errors
    res.status(200).send('ok');
  }
};
