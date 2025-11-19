# Confession Bot (Vercel + Firebase)

This project implements a Telegram Confession Bot that supports:
- Anonymous confessions
- Admin approval/rejection
- User & Admin settings (change channel, manage admins, blacklist)
- Firestore persistence
- Vercel serverless webhook

## Files
- `api/bot.js` - main webhook handler
- `package.json` - dependencies
- `vercel.json` - Vercel config
- `firebase.rules` - example security rules
- `.env.example` - environment variable examples

## Setup

1. Create a Telegram bot with @BotFather and get `BOT_TOKEN`.
2. Create a Firebase project and Firestore database. Generate a service account JSON key.
3. In Vercel project settings, set environment variables:
   - `BOT_TOKEN` - your telegram bot token
   - `FIREBASE_SERVICE_ACCOUNT` - copy service account JSON (or base64 encoded)
   - Optionally `ADMIN_ID` and `CHANNEL_ID` for initial values
4. Deploy to Vercel (connect Git repo or use vercel CLI).
5. Set webhook:
   ```
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_VERCEL_URL>/api/bot"
   ```
6. Add bot as admin to the channel (if using channel posting).

## Admin notes
- Use the admin inline menu sent with each confession to open settings.
- Admin management commands: `add <id>`, `remove <id>` via the Manage Admins flow.
- Change channel via the Change Channel flow.
- Blacklist words via the Blacklist flow.
- Users can run `/myconfessions` to view their confessions, and `/deletedata` to remove their data.

## Security
- Keep `FIREBASE_SERVICE_ACCOUNT` and `BOT_TOKEN` secret.
- Use Firestore rules to limit access (example in `firebase.rules`).

## Extending
- Add image/file storage using Firebase Storage.
- Add web admin dashboard (React) using Firestore as backend.
