# YardDex

Our family field guide. Snap a photo of something you find outside, and Claude identifies it and turns it into a collectible card. Cards include rarity stars, a fun fact, read-aloud, badges, streaks, a map of finds, and 3D-printable lithophanes of favorite photos.

Built as a static web app (Firebase Hosting) plus one Cloud Function that calls the Claude API. Works best on iPhone as a home-screen app from Safari.

```
public/            the app (no build step)
  index.html, styles.css, app.js
  firebase-config.js   ← paste your Firebase web config here
functions/         Cloud Function `identify` (sends the photo to Claude)
firestore.rules    only family members can read/write
storage.rules      only family members can read/upload photos
cors.json          lets the app read photos back for lithophanes
```

## One-time setup (about 20 minutes)

You need: a Google account, an Anthropic API key (console.anthropic.com), and Node 22.

1. **Create the Firebase project**
   - Go to console.firebase.google.com → Add project → name it `yarddex` (or anything).
   - Upgrade to the **Blaze** plan (pay-as-you-go; Cloud Functions require it. Family use stays within the free tier for Firebase itself. The Claude API is billed separately by Anthropic, roughly a cent or two per photo).
   - **Build → Authentication** → Get started → enable **Google**.
   - **Build → Firestore Database** → Create database (production mode, region `us-east1`).
   - **Build → Storage** → Get started (same region).
   - **Project settings → Your apps → Web (</>)** → register an app → copy the `firebaseConfig` values into `public/firebase-config.js`.
   - Put the project id in `.firebaserc`.

2. **Add the family list.** In Firestore, create the collection `config` with document id `family` and one field:
   - `members` (array): each family member's Google email, **all lowercase**.

   Only these accounts can open the dex or use Claude.

3. **Install the tools and deploy**
   ```bash
   npm install -g firebase-tools
   firebase login
   cd functions && npm install && cd ..
   firebase functions:secrets:set ANTHROPIC_API_KEY     # paste your Anthropic key
   firebase deploy
   ```

4. **Let the app read photos back for lithophanes** (one command; use your bucket name from the Storage page):
   ```bash
   gcloud storage buckets update gs://YOUR_BUCKET --cors-file=cors.json
   ```

5. **Allow sign-in from your site.** Authentication → Settings → Authorized domains. `YOUR_PROJECT.web.app` is already there; add any custom domain you use.

6. **On the iPhone:** open `https://YOUR_PROJECT.web.app` in Safari → sign in with Google → Share → **Add to Home Screen**.

## Settings

| Setting | Where | Default |
|---|---|---|
| Claude model | `CLAUDE_MODEL` in `functions/.env` | `claude-sonnet-4-5`. If that model is retired, the function automatically uses the newest Sonnet. |
| Daily photo limit | `DAILY_LIMIT` in `functions/.env` | 60 identifications per day (protects your API bill) |
| Region | `functions/index.js` and `public/firebase-config.js` | `us-east1` |

## Updating

Edit files, then `firebase deploy --only hosting` for app changes, or `firebase deploy --only functions` for the Claude function. Tests for the prompt and response parsing are in `cd functions && npm test`.

## How it works

1. The **Snap** button opens the iPhone camera. The photo is shrunk on the phone and uploaded to Firebase Storage. Location comes from the phone if you allow it.
2. The app calls the `identify` function, which checks that you're on the family list and under the daily limit, then sends the photo to Claude.
3. Claude replies with a card: name, kind, a fun fact, what to look for, rarity for Gwinnett County this month, and a safety note. The family can fix the name before saving.
4. Cards are saved to Firestore and show up live on every family phone.
5. **Print:** star a find as a Print pick, choose a size, and download a watertight STL lithophane. It's 0.8–3.0 mm thick with a 3 mm frame. Print it in white PLA at 100% infill, standing upright.
