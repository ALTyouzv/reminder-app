# Reminders: setup guide

Your own to-do and reminder app. It pops up when you sign in to or unlock either PC, keeps both PCs in sync, and sends due reminders to your iPhone through Telegram, even when both PCs are off.

Setup takes about 15 minutes, and everything is free.

## What you need

- A free **Cloudflare** account. Sign up at https://dash.cloudflare.com/sign-up
- **Telegram** on your iPhone
- **Node.js LTS** on the PC you set up from. The setup script tries to install it for you.

---

## Step 1: Create your Telegram bot (2 min)

1. In Telegram, search for **@BotFather** and open it.
2. Send `/newbot`.
3. Pick a display name (for example *My Reminders*) and a username ending in `bot` (for example `sara_reminders_bot`).
4. BotFather replies with a **token** like `123456789:AAH...`. Keep that message open, because you'll paste the token in Step 2.

## Step 2: Put the app online (run once, on ONE PC)

1. Unzip this folder somewhere permanent, for example `Documents\reminder-app`.
2. Double-click **`setup.cmd`**.
3. Follow the prompts:
   - A browser tab opens. Sign in to Cloudflare and click **Allow**.
   - If it asks for a *workers.dev subdomain*, type any name (for example `sara`).
   - Copy the address it prints (`https://reminders.<name>.workers.dev`) and paste it back into the window.
   - Choose an **app password** (8+ characters).
   - Paste the **bot token** from Step 1.
4. When it finishes, your app opens in the browser.

## Step 3: Connect your phone

1. Sign in to the app with your password.
2. Click the **gear** (Settings), then **Connect Telegram**. Open that link on your iPhone (Copy link and send it to yourself, or click it if Telegram Desktop is installed) and tap **Start**.
3. Back in the app, click **I tapped Start**, then **Send test**. Your phone should buzz.

## Step 4: Make it pop up on startup (run on EACH PC)

1. On this PC: double-click **`windows\install-startup.cmd`** and press Enter to accept the address.
2. On your laptop: copy the whole folder over (USB, OneDrive, etc.) and run **`windows\install-startup.cmd`** there too. Your laptop doesn't need Node.js or Step 2.
3. Sign in once with your password on each PC.

From then on, the Reminders window opens every time you sign in or unlock (including waking from sleep). It also adds a **Reminders** shortcut to your Start Menu and Desktop.

> If your PC wakes from sleep **without** asking for a PIN/password, there's no "unlock", so the popup won't fire. To fix it, go to Settings → Accounts → Sign-in options → "If you've been away, when should Windows require you to sign in again?" and choose **When PC wakes up from sleep**.

## Optional: iPhone home screen

Open your app address in Safari, tap **Share**, then **Add to Home Screen**. You get the same list as an app icon.

---

## Using it

**In the app**

- Type a task and press **Enter**. Add details or context, pick a reminder time (or a quick option like *Tomorrow 9 am*), and set it to repeat daily or weekly if you want.
- Click a task to edit or delete it. Click the circle to mark it done.
- Ticking a repeating task moves it to its next date.
- While the window is open, a due reminder shows a banner with a sound, and a Windows notification if you allow it in Settings.

**In Telegram** (message your bot)

| You send | What happens |
|---|---|
| `Call mom at 18:30` | Adds a task with a reminder at 18:30 |
| `Submit report tomorrow 9am` | Reminder tomorrow at 9:00 |
| `Check oven in 20m` | Reminder in 20 minutes |
| `Buy milk` | Adds it with no reminder |
| `/list` | Shows your open tasks with numbers |
| `/done 12` | Completes task #12 |

Each reminder comes with **Done / 10 min / 1 hour** buttons.

## Good to know

- **Time zone:** set to Riyadh (`TZ` in `worker/wrangler.toml`).
- **Free limits:** Cloudflare's free plan covers this easily (100k requests a day).
- **Remove the popup:** run `windows\uninstall-startup.cmd`. Your tasks stay saved.
- **Forgot your password:** in the `worker` folder, run `npx wrangler secret put APP_KEY` and choose a new one.
- **Privacy:** the bot only answers your phone. Other people who message it get ignored.

## Files

```
setup.cmd / setup.ps1         one-time cloud setup
worker/                       the app (runs on Cloudflare)
  src/index.js                server: storage, reminders, Telegram bot
  src/ui.html                 the app screen
  schema.sql                  database tables
  wrangler.toml               Cloudflare settings
windows/
  install-startup.cmd         popup at sign-in/unlock + shortcuts
  uninstall-startup.cmd       remove it
```
