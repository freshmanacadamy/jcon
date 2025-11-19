// api/bot.js
// Vercel webhook handler for Confession Bot with user & admin settings (Firestore).
const axios = require('axios');
const admin = require('firebase-admin');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!BOT_TOKEN || !FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing BOT_TOKEN or FIREBASE_SERVICE_ACCOUNT env vars.');
}

function initFirebase() {
  if (admin.apps.length) return admin.app();
  let serviceAccount;
  try {
    if (FIREBASE_SERVICE_ACCOUNT.trim().startsWith('{')) serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    else serviceAccount = JSON.parse(Buffer.from(FIREBASE_SERVICE_ACCOUNT,'base64').toString('utf8'));
  } catch (err) {
    console.error('Invalid FIREBASE_SERVICE_ACCOUNT:', err.message);
    throw err;
  }
  return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

initFirebase();
const db = admin.firestore();

const CONF_COLLECTION = 'confessions';
const META_DOC = 'meta/conf_counter';
const SETTINGS_DOC = 'settings/config';
const ADMIN_SESSIONS = 'admin_sessions';

async function tg(method, data) {
  const url = `${TELEGRAM_API}/${method}`;
  return axios.post(url, data).then(r=>r.data).catch(err=>{
    console.error('Telegram API error', method, err?.response?.data || err.message);
    throw err;
  });
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✅ Approve', callback_data: JSON.stringify({action:'approve'}) }, { text: '❌ Reject', callback_data: JSON.stringify({action:'reject'}) }],
      [{ text: '⚙️ Admin Settings', callback_data: JSON.stringify({action:'admin_menu'}) }]
    ]
  };
}

function buildAdminMenu() {
  return {
    inline_keyboard: [
      [{ text: 'View Settings', callback_data: JSON.stringify({action:'view_settings'}) }],
      [{ text: 'Toggle Auto-Post', callback_data: JSON.stringify({action:'toggle_autopost'}) }],
      [{ text: 'Change Channel', callback_data: JSON.stringify({action:'change_channel'}) }],
      [{ text: 'Manage Admins', callback_data: JSON.stringify({action:'manage_admins'}) }],
      [{ text: 'Blacklist Words', callback_data: JSON.stringify({action:'blacklist'}) }]
    ]
  };
}

async function getSettings() {
  const ref = db.doc(SETTINGS_DOC);
  const snap = await ref.get();
  if (!snap.exists) {
    const defaultSettings = { admins: [], channel_id: null, auto_post: false, blacklist: [] };
    await ref.set(defaultSettings);
    return defaultSettings;
  }
  return snap.data();
}

async function updateSettings(updates) {
  const ref = db.doc(SETTINGS_DOC);
  await ref.set(updates, { merge: true });
  return (await ref.get()).data();
}

async function getNextConfessionNumber() {
  const ref = db.doc(META_DOC);
  return db.runTransaction(async tx=>{
    const snap = await tx.get(ref);
    let next = 1;
    if (!snap.exists) {
      tx.set(ref, { last: 1 });
      next = 1;
    } else {
      const last = snap.get('last') || 0;
      next = last + 1;
      tx.update(ref, { last: next });
    }
    return next;
  });
}

async function saveConfession({ number, text, userId, media }) {
  const payload = { id: number, text, user_id: userId, media: media || null, status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp() };
  await db.collection(CONF_COLLECTION).doc(String(number)).set(payload);
  return payload;
}

async function updateConfessionStatus(number, status, meta={}) {
  const ref = db.collection(CONF_COLLECTION).doc(String(number));
  await ref.update({ status, updated_at: admin.firestore.FieldValue.serverTimestamp(), ...meta });
}

async function isAllowedToPost(userId) {
  const rateRef = db.collection('rate_limits').doc(String(userId));
  const snap = await rateRef.get();
  const now = Date.now();
  if (!snap.exists) {
    await rateRef.set({ last_ts: now });
    return true;
  }
  const last = snap.get('last_ts') || 0;
  if (now - last < 60*1000) return false;
  await rateRef.update({ last_ts: now });
  return true;
}

function formatChannelPost(number, text, media) {
  return `#${number}\n${text}`;
}

module.exports = async (req, res) => {
  try {
    const update = req.body;
    if (!update) { res.status(400).send('no update'); return; }

    const settings = await getSettings();
    const defaultAdmins = settings.admins || [];
    const CHANNEL_ID = settings.channel_id || process.env.CHANNEL_ID || null;

    // Handle callback_query
    if (update.callback_query) {
      const cb = update.callback_query;
      const fromId = cb.from?.id;
      const dataRaw = cb.data;

      // simple /start inline buttons handling
      if (dataRaw === 'send_confession') {
        await tg('sendMessage', { chat_id: cb.from.id, text: 'Please type your confession and send it — it will remain anonymous.' });
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
        res.status(200).send('ok'); return;
      }

      // parse JSON payload
      let payload;
      try { payload = JSON.parse(dataRaw); } catch (e) { payload = { action: dataRaw }; }

      // Admin menu actions - ensure caller is admin
      if (['admin_menu','view_settings','toggle_autopost','change_channel','manage_admins','blacklist'].includes(payload.action)) {
        if (!defaultAdmins.map(String).includes(String(fromId))) {
          await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not authorized.' });
          res.status(200).send('ok'); return;
        }
        if (payload.action === 'admin_menu') {
          await tg('sendMessage', { chat_id: fromId, text: 'Admin Settings:', reply_markup: buildAdminMenu() });
          await tg('answerCallbackQuery', { callback_query_id: cb.id });
          res.status(200).send('ok'); return;
        }
        if (payload.action === 'view_settings') {
          await tg('answerCallbackQuery', { callback_query_id: cb.id });
          const s = await getSettings();
          const txt = `Settings:\nChannel: ${s.channel_id || 'Not set'}\nAuto-post: ${s.auto_post}\nAdmins: ${ (s.admins||[]).join(', ') }\nBlacklist: ${(s.blacklist||[]).join(', ')}`;
          await tg('sendMessage', { chat_id: fromId, text: txt });
          res.status(200).send('ok'); return;
        }
        if (payload.action === 'toggle_autopost') {
          const newS = await updateSettings({ auto_post: !settings.auto_post });
          await tg('answerCallbackQuery', { callback_query_id: cb.id, text: `Auto-post set to ${newS.auto_post}` });
          res.status(200).send('ok'); return;
        }
        if (payload.action === 'change_channel') {
          // set admin session to receive next message as channel id
          await db.collection(ADMIN_SESSIONS).doc(String(fromId)).set({ action: 'change_channel', created_at: admin.firestore.FieldValue.serverTimestamp() });
          await tg('sendMessage', { chat_id: fromId, text: 'Send the new channel username (e.g. @channel) or numeric chat id (-100...) now.' });
          await tg('answerCallbackQuery', { callback_query_id: cb.id });
          res.status(200).send('ok'); return;
        }
        if (payload.action === 'manage_admins') {
          await db.collection(ADMIN_SESSIONS).doc(String(fromId)).set({ action: 'manage_admins', created_at: admin.firestore.FieldValue.serverTimestamp() });
          await tg('sendMessage', { chat_id: fromId, text: 'Send commands to manage admins:\nadd <telegram_id>\nremove <telegram_id>' });
          await tg('answerCallbackQuery', { callback_query_id: cb.id });
          res.status(200).send('ok'); return;
        }
        if (payload.action === 'blacklist') {
          await db.collection(ADMIN_SESSIONS).doc(String(fromId)).set({ action: 'blacklist', created_at: admin.firestore.FieldValue.serverTimestamp() });
          await tg('sendMessage', { chat_id: fromId, text: 'Send commands:\nadd <word>\nremove <word>\nlist' });
          await tg('answerCallbackQuery', { callback_query_id: cb.id });
          res.status(200).send('ok'); return;
        }
      }

      // Approve / Reject actions for confessions (payload may include id)
      if (payload.action === 'approve' || payload.action === 'reject') {
        // ensure admin
        if (!defaultAdmins.map(String).includes(String(fromId))) {
          await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not authorized' });
          res.status(200).send('ok'); return;
        }
        const confId = payload.id;
        if (!confId) {
          await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Missing id' });
          res.status(200).send('ok'); return;
        }
        const doc = await db.collection(CONF_COLLECTION).doc(String(confId)).get();
        if (!doc.exists) {
          await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Confession not found' });
          res.status(200).send('ok'); return;
        }
        const conf = doc.data();
        if (payload.action === 'approve') {
          // post to channel if set
          if (!CHANNEL_ID) {
            await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Channel not configured.' });
            res.status(200).send('ok'); return;
          }
          const text = formatChannelPost(confId, conf.text, conf.media);
          await tg('sendMessage', { chat_id: CHANNEL_ID, text });
          await updateConfessionStatus(confId, 'approved', { approved_by: fromId });
          // edit admin message if present
          try {
            if (cb.message && cb.message.message_id) {
              const edited = `✅ Approved — Confession #${confId}\n"${conf.text}"`;
              await tg('editMessageText', { chat_id: fromId, message_id: cb.message.message_id, text: edited });
            }
          } catch(e){}
          await tg('answerCallbackQuery', { callback_query_id: cb.id, text: `Approved #${confId}` });
          res.status(200).send('ok'); return;
        } else {
          await updateConfessionStatus(confId, 'rejected', { rejected_by: fromId });
          try {
            if (cb.message && cb.message.message_id) {
              const edited = `❌ Rejected — Confession #${confId}\n"${conf.text}"`;
              await tg('editMessageText', { chat_id: fromId, message_id: cb.message.message_id, text: edited });
            }
          } catch(e){}
          await tg('answerCallbackQuery', { callback_query_id: cb.id, text: `Rejected #${confId}` });
          res.status(200).send('ok'); return;
        }
      }

      // fallback for callbacks
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Action received.' });
      res.status(200).send('ok'); return;
    }

    // Handle normal messages
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const from = msg.from;
      const fromId = from?.id;
      const text = (msg.text || '').trim();
      const settings = await getSettings();
      const admins = settings.admins || [];

      // check admin session first
      if (String(fromId) && String(fromId) !== 'undefined') {
        const sessionDoc = await db.collection(ADMIN_SESSIONS).doc(String(fromId)).get();
        if (sessionDoc.exists) {
          const session = sessionDoc.data();
          if (session.action === 'change_channel') {
            const newChannel = text;
            await updateSettings({ channel_id: newChannel });
            await db.collection(ADMIN_SESSIONS).doc(String(fromId)).delete();
            await tg('sendMessage', { chat_id: fromId, text: `Channel changed to ${newChannel}` });
            res.status(200).send('ok'); return;
          }
          if (session.action === 'manage_admins') {
            const parts = text.split(/\s+/);
            if (parts[0] === 'add' && parts[1]) {
              const id = parts[1];
              const s = settings;
              const arr = new Set((s.admins||[]).map(String));
              arr.add(String(id));
              await updateSettings({ admins: Array.from(arr) });
              await db.collection(ADMIN_SESSIONS).doc(String(fromId)).delete();
              await tg('sendMessage', { chat_id: fromId, text: `Added admin ${id}` });
              res.status(200).send('ok'); return;
            }
            if (parts[0] === 'remove' && parts[1]) {
              const id = parts[1];
              const arr = (settings.admins||[]).filter(a=>String(a)!==String(id));
              await updateSettings({ admins: arr });
              await db.collection(ADMIN_SESSIONS).doc(String(fromId)).delete();
              await tg('sendMessage', { chat_id: fromId, text: `Removed admin ${id}` });
              res.status(200).send('ok'); return;
            }
            await tg('sendMessage', { chat_id: fromId, text: 'Invalid command. Use add <id> or remove <id>.' });
            res.status(200).send('ok'); return;
          }
          if (session.action === 'blacklist') {
            const parts = text.split(/\s+/);
            const cmd = parts[0];
            if (cmd === 'list') {
              await tg('sendMessage', { chat_id: fromId, text: `Blacklisted words: ${(settings.blacklist||[]).join(', ')}` });
              await db.collection(ADMIN_SESSIONS).doc(String(fromId)).delete();
              res.status(200).send('ok'); return;
            }
            if (cmd === 'add' && parts[1]) {
              const word = parts[1].toLowerCase();
              const arr = new Set((settings.blacklist||[]).map(String));
              arr.add(word);
              await updateSettings({ blacklist: Array.from(arr) });
              await db.collection(ADMIN_SESSIONS).doc(String(fromId)).delete();
              await tg('sendMessage', { chat_id: fromId, text: `Added to blacklist: ${word}` });
              res.status(200).send('ok'); return;
            }
            if (cmd === 'remove' && parts[1]) {
              const word = parts[1].toLowerCase();
              const arr = (settings.blacklist||[]).filter(w=>w!==word);
              await updateSettings({ blacklist: arr });
              await db.collection(ADMIN_SESSIONS).doc(String(fromId)).delete();
              await tg('sendMessage', { chat_id: fromId, text: `Removed from blacklist: ${word}` });
              res.status(200).send('ok'); return;
            }
            await tg('sendMessage', { chat_id: fromId, text: 'Invalid blacklist command.' });
            res.status(200).send('ok'); return;
          }
        }
      }

      // handle /start
      if (text && text.startsWith('/start')) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'Welcome to Confession Bot!\nSend your confession anonymously. Use buttons or just send a message.',
          reply_markup: { inline_keyboard: [[{ text: '✍️ Send Confession', callback_data: 'send_confession' }], [{ text: '📌 Rules', callback_data: 'rules' }, { text: '⚙️ Settings', callback_data: 'user_settings' }]] }
        });
        res.status(200).send('ok'); return;
      }

      // user settings callback placeholder (show options)
      if (msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes('User Settings')) {
        // not used
      }

      // handle /myconfessions
      if (text === '/myconfessions') {
        const snaps = await db.collection(CONF_COLLECTION).where('user_id','==',fromId).orderBy('created_at','desc').limit(50).get();
        if (snaps.empty) {
          await tg('sendMessage', { chat_id: chatId, text: 'You have no confessions.' });
          res.status(200).send('ok'); return;
        }
        let out = 'Your confessions:\n';
        snaps.forEach(s=>{ const d=s.data(); out += `#${d.id} - ${d.status} - ${d.text.slice(0,120)}\n`; });
        await tg('sendMessage', { chat_id: chatId, text: out });
        res.status(200).send('ok'); return;
      }

      // handle user deletion request
      if (text === '/deletedata') {
        // remove user's confessions and data
        const snaps = await db.collection(CONF_COLLECTION).where('user_id','==',fromId).get();
        const batch = db.batch();
        snaps.forEach(s=> batch.delete(s.ref));
        await batch.commit();
        await tg('sendMessage', { chat_id: chatId, text: 'Your data has been deleted.' });
        res.status(200).send('ok'); return;
      }

      // If message is from admin and not in session, allow admin message commands
      if (String(fromId) && (settings.admins||[]).map(String).includes(String(fromId))) {
        // basic admin text commands
        if (text.startsWith('/setchannel')) {
          const parts = text.split(/\s+/);
          if (parts[1]) {
            await updateSettings({ channel_id: parts[1] });
            await tg('sendMessage', { chat_id: chatId, text: `Channel set to ${parts[1]}` });
            res.status(200).send('ok'); return;
          }
        }
      }

      // Normal user submission: treat as confession if not admin session
      // Skip if message from admin (admins may also submit confessions)
      // rate limiting
      const allowed = await isAllowedToPost(fromId);
      if (!allowed) {
        await tg('sendMessage', { chat_id: chatId, text: 'You are sending confessions too quickly. Please wait.' });
        res.status(200).send('ok'); return;
      }

      // content validation
      if (!text && !msg.photo && !msg.caption) {
        await tg('sendMessage', { chat_id: chatId, text: 'Please send a non-empty confession.' });
        res.status(200).send('ok'); return;
      }

      const contentText = (text || msg.caption || '') .trim();
      const black = settings.blacklist || [];
      const lowered = contentText.toLowerCase();
      for (const w of black) if (lowered.includes(String(w))) {
        await tg('sendMessage', { chat_id: chatId, text: 'Your confession contains disallowed words and was rejected.' });
        res.status(200).send('ok'); return;
      }

      // create confession
      const number = await getNextConfessionNumber();
      const media = msg.photo ? 'photo' : null;
      await saveConfession({ number, text: contentText, userId: fromId, media });

      // notify user
      await tg('sendMessage', { chat_id: chatId, text: `Received anonymously. Pending approval (ID #${number}).` });

      // notify all admins with inline buttons
      const adminText = `New Confession #${number}\nAnonymous:\n"${contentText}"`;
      const adminsList = settings.admins && settings.admins.length ? settings.admins : (process.env.ADMIN_ID ? [process.env.ADMIN_ID] : []);
      for (const a of adminsList) {
        try {
          await tg('sendMessage', { chat_id: a, text: adminText, reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: JSON.stringify({ action: 'approve', id: number }) }, { text: '❌ Reject', callback_data: JSON.stringify({ action: 'reject', id: number }) } ] , [{ text: '⚙️ Settings', callback_data: JSON.stringify({ action: 'admin_menu' }) }] ] } });
        } catch(e){ console.error('notify admin error', e?.message || e); }
      }

      // if auto_post enabled, directly post
      if (settings.auto_post && CHANNEL_ID) {
        try {
          await tg('sendMessage', { chat_id: CHANNEL_ID, text: formatChannelPost(number, contentText) });
          await updateConfessionStatus(number, 'approved', { approved_by: 'auto' });
        } catch(e){ console.error('auto post failed', e?.message || e); }
      }

      res.status(200).send('ok'); return;
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook error', err?.message || err);
    res.status(500).send('error');
  }
};
