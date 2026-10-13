# Reminders

A simple to-do and reminder app that's all yours. Add tasks from your PC, your phone, or by messaging a Telegram bot, and get reminders on your phone through Telegram, even when your PC is off.

It's free and runs on your own free Cloudflare account, so nobody else (including whoever shared this with you) can see your tasks.

---

## Set it up (about 5 minutes, no installing anything)

### 1. Make a Telegram bot (2 min)

1. In Telegram, search for **@BotFather** and open it.
2. Send `/newbot`.
3. Pick a name (for example *My Reminders*) and a username that ends in `bot` (for example `sara_reminders_bot`).
4. BotFather replies with a **token** like `123456789:AAH...`. Copy it, because you'll need it in the next step.

### 2. Click the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ALTyouzv/reminder-app/tree/main/worker)

1. Sign in to Cloudflare, or make a free account.
2. Connect your GitHub account when it asks. It saves a copy of the app there for you.
3. Fill in the form:
   - **APP_KEY**: choose a password for your app (8+ characters).
   - **TELEGRAM_TOKEN**: paste the bot token from step 1.
   - **TZ**: your time zone, for example `Asia/Riyadh`.
   - Leave everything else as it is.
4. Click **Deploy** and wait about a minute.
5. Open the address it gives you, something like `https://reminders.<your-name>.workers.dev`. That's your app. Bookmark it.

### 3. Connect your phone

1. Open your app and sign in with your password.
2. Click the **gear** (Settings), then **Connect Telegram**. Open that link on your phone and tap **Start**.
3. Back in the app, click **I tapped Start**, then **Send test**. Your phone should buzz.

That's it. You're done.

---

## Optional: make it pop up on your PC

Skip this if you're happy just opening the app from a bookmark.

If you want the Reminders window to **pop up automatically every time you turn on or unlock your Windows PC**:

1. On this page, click the green **Code** button, then **Download ZIP**.
2. Unzip it somewhere permanent, for example `Documents\reminder-app`.
3. Open the `windows` folder and double-click **`install-startup.cmd`**.
   - If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**.
4. Paste your app address when it asks, and press Enter.
5. Sign in once with your password when the window opens.

From now on it pops up every time you sign in or unlock your PC, and you also get a **Reminders** shortcut on your Desktop and Start Menu. Do the same on any other PC you use.

To turn the popup off, double-click **`windows\uninstall-startup.cmd`**. Your tasks stay saved.

> If your PC wakes from sleep **without** asking for your PIN or password, the popup won't show (Windows doesn't count it as an "unlock"). To fix it: Settings → Accounts → Sign-in options → "If you've been away, when should Windows require you to sign in again?" → **When PC wakes up from sleep**.

## Optional: put it on your iPhone home screen

Open your app address in Safari, tap **Share**, then **Add to Home Screen**. It looks and works like an app.

---

## Using it

**In the app**

- Type a task and press **Enter**. You can add details, pick a reminder time (or a quick option like *Tomorrow 9 am*), get a heads-up before it's due (10 min, 30 min, 1 hour or 1 day early), and make it repeat daily or weekly.
- Click a task to edit or delete it. Click the circle to mark it done.
- While the app is open, a due reminder shows a banner with a sound, plus a Windows notification if you allow it in Settings.

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

- **Free:** Cloudflare's free plan covers this easily.
- **Private:** your bot only answers your phone. Anyone else who messages it gets ignored.
- **Your name in the app:** to make it say "Good morning, Sara", open `worker/src/ui.html` in your GitHub copy, find `var NAME = ''`, and put your name between the quotes. Cloudflare updates your app automatically after you save.
- **Change your password or bot token:** Cloudflare dashboard → Workers & Pages → *reminders* → Settings → Variables and Secrets.

---

<details>
<summary>Other way to install: setup script on Windows (for advanced users)</summary>

If you'd rather not use the button, you can set it up from a Windows PC with Node.js:

1. Download the ZIP (green **Code** button → **Download ZIP**) and unzip it.
2. Double-click **`setup.cmd`** and follow the prompts. It signs you in to Cloudflare, creates the database, publishes the app, and asks for your password and bot token.
3. Continue from **step 3** above.

After changing the code, double-click **`update.cmd`** to publish the new version.

</details>

## Files

```
worker/                       the app (runs on Cloudflare)
  src/index.js                server: storage, reminders, Telegram bot
  src/ui.html                 the app screen
  wrangler.toml               Cloudflare settings
  package.json                settings for the Deploy button
windows/
  install-startup.cmd         optional: popup at sign-in/unlock + shortcuts
  uninstall-startup.cmd       remove the popup
setup.cmd / update.cmd        optional: install/update from Windows instead of the button
```
