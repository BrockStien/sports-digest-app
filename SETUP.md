# Sports Digest app: setup guide

When you're done, you and your friends will have:

- **An app on your phone's home screen.** Sign in with your email and a password, and pick your leagues and teams. Then check:
  - **Games:** yesterday's scores, today's live games and tomorrow's schedule, with ticket, calendar and **How to watch** buttons.
  - **News:** stories about your teams.
  - **Chat:** private group chats with friends, with a thread for each game.
- **The same daily email as now**, except each person controls their own settings in the app. Anyone who'd rather just use the app can turn the email off. Nobody edits `users.json` anymore.

Plan on **about 45 minutes**, one time. Everything here is free.

| Piece | What it does | Where it lives |
|---|---|---|
| The app (this folder) | The screens people use | A new **public** GitHub repo, published free with GitHub Pages |
| Supabase | Stores everyone's settings and handles sign-in | supabase.com (free plan) |
| The daily email | Your existing script, now reading settings from Supabase | Your existing **private** GitHub repo |

---

## Part 1: Create the database (Supabase)

1. Go to **supabase.com** and click **Start your project**. Sign in with your GitHub account.
2. Click **New project**.
   - **Name:** `sports-digest`
   - **Database password:** click **Generate a password** and save it somewhere. You won't need it for this guide.
   - **Region:** West US (closest to Arizona)
   - Click **Create new project** and wait about 2 minutes.
3. In the left sidebar, click **SQL Editor**, then **New query**.
4. Open `supabase-setup.sql` from this folder, copy all of it, paste it into the editor, and click **Run**.
   You should see "Success. No rows returned." This creates the settings table and the security rules that keep each person's data private.
   **Then the group chat:** click **New query** again, paste all of `chat-setup.sql`, and click **Run**. Same "Success" message. This step is optional; if you skip it, the app simply has no Chat tab.

## Part 2: Let Supabase send account emails

Supabase's built-in email only reaches you, the project owner. Point it at your Gmail so it can send confirmation and password-reset emails to your friends too. Use the same app password as the daily email.

5. Go to **Project Settings** (gear icon at the bottom left), then **Authentication**, then **SMTP Settings**, and turn on **Enable custom SMTP**:
   - **Sender email:** your Gmail address
   - **Sender name:** `Sports Digest`
   - **Host:** `smtp.gmail.com`
   - **Port:** `587`
   - **Username:** your Gmail address
   - **Password:** your 16-character Gmail app password
   - Click **Save**.

6. (Optional) Make the welcome email friendlier. Go to **Authentication**, then **Emails**, open **Confirm signup**, and replace the **Message body** with:

   ```html
   <p>Welcome to Sports Digest! <a href="{{ .ConfirmationURL }}">Tap here to confirm your email</a>, then go back to the app and sign in.</p>
   ```
   Click **Save**. The **Reset password** email works as it is.

## Part 3: Publish the app (GitHub Pages)

7. On GitHub, click **+** (top right), then **New repository**.
   - **Name:** `sports-digest-app`
   - Choose **Public**. GitHub Pages is free only for public repos. That's safe: this folder has no passwords or email addresses in it.
   - Click **Create repository**.
8. Click **uploading an existing file**. Drag in **everything in this folder**, including the `icons` folder, and click **Commit changes**.
   Check that the repo's main page lists `index.html`, `app.js`, `config.js` and an `icons` folder.
9. Go to **Settings**, then **Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, set **Branch** to `main` and `/ (root)`, and click **Save**.
   After about a minute, the page shows your app's address, something like:
   `https://YOUR-GITHUB-NAME.github.io/sports-digest-app/`
   Copy it. This is your **app address**.

## Part 4: Connect the pieces

10. **Get your Supabase keys.** In Supabase, go to **Project Settings**, then **API Keys** (or **API**).
    - Copy the **Project URL** (it looks like `https://abcdxyz.supabase.co`). If you don't see it here, it's under **Project Settings → Data API**.
    - If there's a **Legacy API Keys** tab, open it. Copy the **anon public** key and the **service_role** key (click **Reveal**).
    - If you only see new-style keys, copy the **Publishable** key in place of anon, and a **Secret** key in place of service_role.

11. **Put the public key in the app.** In your `sports-digest-app` repo, click `config.js`, then the **pencil**, and fill in:
    ```js
    SUPABASE_URL: "https://abcdxyz.supabase.co",
    SUPABASE_ANON_KEY: "eyJhbGciOi...the anon public key...",
    ```
    Keep the quotes and commas. Click **Commit changes**.
    ⚠️ Only the **anon/publishable** key goes here. The service_role/secret key is never put in the app.

12. **Tell Supabase where the app lives.** In Supabase, go to **Authentication**, then **URL Configuration**:
    - **Site URL:** your app address
    - **Redirect URLs:** click **Add URL** and paste your app address again
    - Click **Save**.

13. **Connect the daily email.** In your **private** email repo:
    - Replace `espn_daily_email.py` with the new version (pencil, select all, paste, commit).
    - Replace `.github/workflows/daily-sports-email.yml` with the new version the same way.
    - Go to **Settings → Secrets and variables → Actions** and add three secrets:

      | Name | Value |
      |---|---|
      | `SUPABASE_URL` | the Project URL |
      | `SUPABASE_SERVICE_KEY` | the **service_role** (or Secret) key |
      | `APP_URL` | your app address |

    Once these secrets exist, the email reads people from the app and ignores `users.json`.

## Part 5: Try it

14. On your phone, open your app address in **Safari** (iPhone) or **Chrome** (Android).
15. Tap **Create an account**, enter your email and a password, then tap the link in the confirmation email (check spam the first time) and sign in.
16. Pick your leagues and teams and tap **Start my daily email**.
17. **Put it on your home screen:**
    - **iPhone:** tap the **Share** button, then **Add to Home Screen**, then **Add**.
    - **Android:** tap the **⋮** menu, then **Install app** (or **Add to Home screen**).
18. Back in your email repo, go to **Actions → Daily Sports Email → Run workflow**. Your email should arrive with a **Manage your teams** button at the bottom.
19. Send your friends the app address. Each person signs up and picks their own teams.
20. **Start a group chat:** tap **Chat**, name your group, and tap **Create**, then **Share** to send the invite link. Friends who open the link sign up (if they're new) and join. Tap **💬 Discuss** on any game to chat about it. Each person sets **Phone alerts for this group** (every message, @mentions, or off) under the **⋯** button. Phone alerts need the notifications setup.

When everyone you had in `users.json` has signed up in the app, you can delete `users.json`.

---

## Optional: phone notifications

When everything above works, you can add phone alerts: games starting, scores, big plays, finals and a morning summary. The steps are in `SETUP-NOTIFICATIONS.md`, in the separate notifications folder. It takes about 15 minutes.

---

## Good to know

- **Who can see what:** each person can only see and change their own settings. That's enforced by the database, not just the app. Nobody can point the email at someone else's inbox; it always goes to the address they signed in with.
- **Pausing and deleting:** people can pause their email or delete their settings from **My Teams**. Every email also has a **Manage your teams** link, and Gmail shows an **Unsubscribe** option.
- **Supabase free plan:** it pauses projects with no activity for a week. The daily email checks the database every morning, which counts as activity. If it ever does pause, log in to Supabase and click **Restore**.
- **Updating the app:** after editing app files, open `sw.js` and change `VERSION = "sd-v1"` to `"sd-v2"` (then v3, and so on) so phones pick up the new version.
- **Growing beyond friends:** Gmail allows about 500 emails a day. If you get close, switch the email to a sending service like SendGrid. Only the email settings in the script change. The app and database already handle thousands of users.

## Troubleshooting

| Problem | Fix |
|---|---|
| App says **"Almost there"** | `config.js` still has the placeholder text. Do step 11. |
| No code email arrives | Check spam. Then check step 5: the SMTP password must be the Gmail **app password**. In Supabase, **Authentication → Logs** shows send errors. |
| Code email has a link but no number | Step 6: both templates need `{{ .Token }}`. |
| "That code didn't work" | Codes expire after an hour and only the newest one works. Tap **Use a different email** and send a fresh one. |
| "Too many tries" | Supabase limits how many codes it sends per hour. Wait a few minutes. |
| Team search finds nothing | ESPN didn't respond. Type the full team name, like `Minnesota Vikings`, and tap **Add**. |
| Daily email run fails with **HTTP 401** | The `SUPABASE_SERVICE_KEY` secret is wrong. Use the **service_role** key, not the anon key. |
| App changes don't show on your phone | Bump `VERSION` in `sw.js` (see Good to know), then close and reopen the app. |
