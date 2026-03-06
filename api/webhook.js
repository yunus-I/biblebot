// api/webhook.js
// Serverless webhook handler for Telegram + Firestore registration flow.
// Designed for Vercel serverless functions (node). Uses FIREBASE service account JSON stored in env var.

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const admin = require('firebase-admin');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean); // e.g. "123,456"
const SERVICE_ACCOUNT_JSON = process.env.SERVICE_ACCOUNT_JSON; // stringified JSON
const BASE_TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Initialize Firebase Admin only once (serverless friendly)
function initFirebase() {
  if (admin.apps && admin.apps.length) return;
  if (!SERVICE_ACCOUNT_JSON) {
    console.error('SERVICE_ACCOUNT_JSON missing');
    throw new Error('SERVICE_ACCOUNT_JSON missing');
  }
  const sa = JSON.parse(SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
}
let db;
try {
  initFirebase();
  db = admin.firestore();
} catch (err) {
  console.error('Firebase init error', err);
}

// Helpers to call Telegram API
async function tgSendMessage(chatId, text, opts = {}) {
  const body = { chat_id: chatId, text, ...opts, parse_mode: opts.parse_mode || 'Markdown' };
  const res = await fetch(`${BASE_TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function tgSendPhoto(chatId, photoFileIdOrUrl, caption = '', opts = {}) {
  const body = { chat_id: chatId, photo: photoFileIdOrUrl, caption, ...opts, parse_mode: opts.parse_mode || 'Markdown' };
  const res = await fetch(`${BASE_TELEGRAM_API}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function tgAnswerCallback(cbQueryId, text) {
  await fetch(`${BASE_TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cbQueryId, text }),
  });
}

// Simple registration state machine stored in Firestore
// Collection: "registrations" documents keyed by chatId (string)
async function startRegistration(chatId, from) {
  await db.collection('registrations').doc(String(chatId)).set({
    step: 'ASK_LANGUAGE',
    telegramId: from.id,
    telegramUsername: from.username || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'አማርኛ', callback_data: 'lang_am' }, { text: 'English', callback_data: 'lang_en' }]
      ]
    }
  };
  await tgSendMessage(chatId,
    '*Welcome / እንኳን ደህና መጡ!*\n\nPlease choose a language / ቋንቋ ይምረጡ።',
    keyboard
  );
}

async function handleLanguageChoice(chatId, lang) {
  const docRef = db.collection('registrations').doc(String(chatId));
  await docRef.update({ lang, step: 'ASK_NAME' });
  const prompt = lang === 'am' ? 'እባክዎ ሙሉ ስምዎን ያስገቡ።' : 'Please enter your full name:';
  await tgSendMessage(chatId, prompt);
}

// --- main handler
module.exports = async function handler(req, res) {
  // Vercel uses GET for verification sometimes; we only accept POST updates
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  const update = req.body;
  try {
    // Two main types: message/edited_message and callback_query
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data;
      const chatId = cb.from.id;
      const cbId = cb.id;

      // language selection
      if (data === 'lang_am' || data === 'lang_en') {
        const lang = data === 'lang_am' ? 'am' : 'en';
        await handleLanguageChoice(chatId, lang);
        await tgAnswerCallback(cbId, lang === 'am' ? 'አማርኛ ተመርጧል' : 'English selected');
        res.status(200).send('ok');
        return;
      }

      // admin approve/reject -> callback_data = approve_<phone> or reject_<phone>
      if (data.startsWith('approve_') || data.startsWith('reject_')) {
        // verify admin
        const adminIdStr = String(cb.from.id);
        if (!ADMIN_CHAT_IDS.includes(adminIdStr)) {
          await tgAnswerCallback(cbId, 'Not authorized');
          res.status(200).send('ok');
          return;
        }
        const [action, userPhone] = data.split('_');
        const userRef = db.collection('users').doc(String(userPhone));
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
          await tgAnswerCallback(cbId, 'User not found');
          res.status(200).send('ok');
          return;
        }
        if (action === 'approve') {
          await userRef.update({ isPaid: true, approvedAt: admin.firestore.FieldValue.serverTimestamp() });
          // notify user
          const userData = userDoc.data();
          if (userData && userData.telegramChatId) {
            await tgSendMessage(userData.telegramChatId, '*Your registration has been approved!* 🎉\nYou can now login to the app.');
          }
          // update admin caption (best-effort)
          try {
            await fetch(`${BASE_TELEGRAM_API}/editMessageCaption`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
                caption: (cb.message.caption || '') + `\n\n✅ Approved by @${cb.from.username || cb.from.first_name}`
              })
            });
          } catch(e) { console.warn('edit caption failed', e.message); }
          await tgAnswerCallback(cbId, 'User approved');
        } else {
          // reject
          await userRef.update({ isPaid: false, rejectedAt: admin.firestore.FieldValue.serverTimestamp() });
          const userData = userDoc.data();
          if (userData && userData.telegramChatId) {
            await tgSendMessage(userData.telegramChatId, '*Payment rejected.* Please contact support.');
          }
          await tgAnswerCallback(cbId, 'User rejected');
        }
        res.status(200).send('ok');
        return;
      }

      // unknown callback
      await tgAnswerCallback(cbId, 'Unknown action');
      res.status(200).send('ok');
      return;
    }

    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text || null;

      // fetch existing registration (if any)
      const regRef = db.collection('registrations').doc(String(chatId));
      const regSnap = await regRef.get();
      const reg = regSnap.exists ? regSnap.data() : null;

      // If /start and no registration => start flow
      if (text && text.startsWith('/start')) {
        await startRegistration(chatId, msg.from);
        res.status(200).send('ok');
        return;
      }

      // If there is a reg in progress:
      if (reg && reg.step) {
        const step = reg.step;
        const lang = reg.lang || 'en';
        const t = (am, en) => (lang === 'am' ? am : en);

        if (step === 'ASK_NAME') {
          await regRef.update({ name: msg.text || '', step: 'ASK_PHONE' });
          await tgSendMessage(chatId, t('እባክዎ ስልክ ቁጥርዎን ያስገቡ።', 'Please enter your phone number:'));
          res.status(200).send('ok');
          return;
        }

        if (step === 'ASK_PHONE') {
          const phone = msg.text || '';
          await regRef.update({ phone, step: 'ASK_PASSWORD' });
          await tgSendMessage(chatId, t('እባክዎ የይለፍ ቃል ይፍጠሩ (ቢያንስ 4 አሃዞች):', 'Please create a password (min 4 chars):'));
          res.status(200).send('ok');
          return;
        }

        if (step === 'ASK_PASSWORD') {
          const pass = msg.text || '';
          if ((pass || '').length < 4) {
            await tgSendMessage(chatId, t('የይለፍ ቃሉ ሀሳብ አትደርስ። እባክዎ 4 የሚገባ አቁጥር ያስገቡ።', 'Password too short, please send at least 4 chars'));
            res.status(200).send('ok');
            return;
          }
          await regRef.update({ tempPassword: pass, step: 'CONFIRM_PASSWORD' });
          await tgSendMessage(chatId, t('እባክዎ የይለፍ ቃልዎን ያረጋግጡ።', 'Please confirm your password:'));
          res.status(200).send('ok');
          return;
        }

        if (step === 'CONFIRM_PASSWORD') {
          const pass = msg.text || '';
          if (pass !== reg.tempPassword) {
            await tgSendMessage(chatId, t('የይለፍ ቃሉ አይመሳሰልም። እንደገና ይሞክሩ።', 'Passwords do not match. Try again.'));
            res.status(200).send('ok');
            return;
          }
          // move to ask payment
          await regRef.update({
            password: pass,
            tempPassword: admin.firestore.FieldValue.delete(),
            step: 'ASK_PAYMENT'
          });
          const paymentMsg = t(
            `እባክዎ የክፍያውን 150 ብር ይክፈሉ።\nCBE: 1000651098347 (yunus)\nTelebirr: 0985711861 (yenus)\nከዚያም የክፍያ ስክሪንሾት ይላኩ።`,
            `Please pay 150 ETB to:\nCBE: 1000651098347 (yunus)\nTelebirr: 0985711861 (yenus)\nThen upload the payment screenshot here.`
          );
          await tgSendMessage(chatId, paymentMsg);
          res.status(200).send('ok');
          return;
        }

        if (step === 'ASK_PAYMENT') {
          // If user sent photo it will be handled below (message.photo)
          // otherwise just remind them
          await tgSendMessage(chatId, t('እባክዎ የክፍያ ስክሪንሾት ይላኩ።', 'Please upload payment screenshot/receipt.'));
          res.status(200).send('ok');
          return;
        }
      }

      // If message contains photo (and we have reg in ASK_PAYMENT)
      if (msg.photo && reg && reg.step === 'ASK_PAYMENT') {
        const photo = msg.photo[msg.photo.length - 1]; // highest res
        const fileId = photo.file_id;

        // Save user (users collection) with isPaid=false
        const usersRef = db.collection('users').doc(String(reg.phone || String(chatId)));
        await usersRef.set({
          telegramChatId: chatId,
          telegramId: reg.telegramId || msg.from.id,
          telegramUsername: reg.telegramUsername || msg.from.username || null,
          name: reg.name || null,
          phone: reg.phone || null,
          password: reg.password || null, // consider hashing in production
          isPaid: false,
          paymentPhotoFileId: fileId,
          registeredAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Notify user
        await tgSendMessage(chatId, (reg.lang === 'am') ? 'መረጃዎት ተቀብሏል። እባክዎ 6-24 ሰዓታት ይጠብቁ።' : 'Thanks! Your payment has been sent for review. Please wait 6-24 hours.');

        // Notify admins with photo + approve/reject buttons
        const caption = `🔔 New registration\nName: ${reg.name || '-'}\nPhone: ${reg.phone || '-'}\nTG: @${msg.from.username || ''}\nChatId: ${chatId}`;
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `approve_${reg.phone || chatId}` },
                { text: '❌ Reject', callback_data: `reject_${reg.phone || chatId}` }
              ]
            ]
          },
          parse_mode: 'Markdown'
        };
        // send photo to each admin
        for (const aid of ADMIN_CHAT_IDS) {
          try {
            await tgSendPhoto(aid, fileId, caption, keyboard);
          } catch (e) {
            console.error('sendPhoto to admin failed', aid, e.message);
          }
        }

        // finalize reg doc => move to WAITING_PAYMENT
        await db.collection('registrations').doc(String(chatId)).update({ step: 'WAITING_PAYMENT', paymentPhotoFileId: fileId });

        res.status(200).send('ok');
        return;
      }

      // default reply for unknown messages
      // optional: prompt them to /start
      res.status(200).send('ok');
      return;
    }

    // otherwise
    res.status(200).send('ok');
  } catch (err) {
    console.error('Handler error', err);
    res.status(200).send('ok');
  }
};
