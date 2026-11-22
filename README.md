# YardDex

A nature field guide for families. Anyone can sign in, create a family, and share an invite link so everyone in that family collects finds together. Snap a photo of something you find outside, and Claude identifies it and turns it into a collectible card. Cards include rarity stars, a fun fact, read-aloud, badges, streaks, a map of finds, and 3D-printable lithophanes of favorite photos.

Built as a static web app (Firebase Hosting) plus one Cloud Function that calls the Claude API. Works best on iPhone as a home-screen app from Safari.

```
public/            the app (no build step)
  index.html, styles.css, app.js
  firebase-config.js   ← paste your Firebase web config here
functions/         Cloud Functions: `identify` (sends the photo to Claude) and `family` (create, join, invite, leave)
firestore.rules    each family's finds are visible only to its members
storage.rules      each family's photos are visible only to its members
cors.json          lets the app read photos back for lithophanes
```

## One-time setup (about 20 minutes)

You need: a Google account, an Anthropic API key (console.anthropic.com), and Node 22.

1. **Create the Firebase project**
   - Go to console.firebase.google.com → Add project → name it `yarddex` (or anything).
   - Upgrade to the **Blaze** plan (pay-as-you-go; Cloud Functions require it. Family use stays within the free tier for Firebase itself. The Claude API is billed separately by Anthropic, a small fraction of a cent per photo with the default Haiku model).
   - **Build → Authentication** → Get started → enable **Google**.
   - **Build → Firestore Database** → Create database (production mode, region `us-east1`).
   - **Build → Storage** → Get started (same region).
   - **Project settings → Your apps → Web (</>)** → register an app → copy the `firebaseConfig` values into `public/firebase-config.js`.
   - Put the project id in `.firebaserc`.

2. **Deploy.** Easiest: let GitHub do it. `.github/workflows/deploy.yml` deploys on every push once two repository secrets exist (Settings → Secrets and variables → Actions): `FIREBASE_SERVICE_ACCOUNT` (the JSON key of a Google Cloud service account with the Owner role) and `ANTHROPIC_API_KEY`. It also does step 3 for you. Or deploy by hand:
   ```bash
   npm install -g firebase-tools
   firebase login
   cd functions && npm install && cd ..
   firebase functions:secrets:set ANTHROPIC_API_KEY     # paste your Anthropic key
   firebase deploy
   ```

3. **Let the app read photos back for lithophanes** (one command; use your bucket name from the Storage page):
   ```bash
   gcloud storage buckets update gs://YOUR_BUCKET --cors-file=cors.json
   ```

4. **Allow sign-in from your site.** Authentication → Settings → Authorized domains. `YOUR_PROJECT.web.app` is already there; add any custom domain you use.

5. **On the iPhone:** open `https://YOUR_PROJECT.web.app` in Safari → sign in with Google → **Create family** → Share → **Add to Home Screen**.

6. **Invite people:** tap **Family** (top right) → **Share link**. Whoever opens the link and signs in with Google joins your family. The family's creator can remove people or make a new link (the old one stops working).

## Admin dashboard

Open **https://YOUR_PROJECT.web.app/admin** to manage budgets and watch usage. Only Google accounts listed in the `ADMIN_EMAILS` GitHub secret (Settings → Secrets and variables → Actions; separate several with commas) can open it, and every change is checked again on the server. It shows:

- photos and Claude cost today, this month and last month, and a 30-day chart
- **budget and limits**, which apply within 30 seconds with no redeploy: Claude model and effort, a monthly dollar cap, photos per family per day, photos per day for everyone, sign-ups on or off, and a pause switch for photo naming
- every family with its members, finds and usage, where you can give a family its own daily limit, block it, or delete it
- the last 60 photo-naming attempts, with result, tokens and cost

Admins also see an **Open admin dashboard** button in the app's Family sheet.

## Families and your Claude bill

Anyone with a Google account can sign up and make a family, and every photo they identify is billed to **your** Anthropic account. Several limits protect you. Change them in the admin dashboard; the values in `functions/.env` are only the starting defaults:

- `DAILY_LIMIT`: photos one family can identify per day (default 60).
- `GLOBAL_DAILY_LIMIT`: photos the whole app can identify per day, all families together (default 300; with Haiku that's well under $1/day at most).
- **Monthly budget**: photo naming stops for the month once Claude costs reach it (default $10).

Also set a monthly spend limit on your Anthropic account (console.anthropic.com → Billing → Limits).

## Settings

| Setting | Where | Default |
|---|---|---|
| Claude model | `CLAUDE_MODEL` in `functions/.env` | `claude-haiku-5-5` (about 0.05¢ per photo). `claude-sonnet-5-5` is better at rare species, at roughly 20× the cost. If the model is retired, the function falls back to the newest Haiku. |
| Photo limit per family | `DAILY_LIMIT` in `functions/.env` | 60 identifications per family per day |
| Photo limit for everyone | `GLOBAL_DAILY_LIMIT` in `functions/.env` | 300 identifications per day across all families (protects your API bill) |
| Region | `functions/index.js` and `public/firebase-config.js` | `us-east1` |

## Updating

Edit files, then `firebase deploy --only hosting` for app changes, or `firebase deploy --only functions` for the Claude function. Tests for the prompt and response parsing are in `cd functions && npm test`.

To try changes on your computer without touching the real project: set `useEmulators = true` in `public/firebase-config.js`, run `firebase emulators:start --project demo-yarddex`, and open http://127.0.0.1:5000. Set it back to `false` before deploying.

## How it works

1. The **Snap** button opens the iPhone camera. The photo is shrunk on the phone and uploaded to Firebase Storage. Location comes from the phone if you allow it.
2. The app calls the `identify` function, which checks that you're in a family and under the daily limits, then sends the photo to Claude with a rough location (about 10 km), never the exact spot.
3. Claude replies with a card: name, kind, a fun fact, what to look for, rarity for your area this month, and a safety note. The family can fix the name before saving.
4. Cards are saved under your family in Firestore and show up live on every phone in the family. Other families can't see them.
5. **Print:** star a find as a Print pick, choose a size, and download a watertight STL lithophane. It's 0.8–3.0 mm thick with a 3 mm frame. Print it in white PLA at 100% infill, standing upright.
