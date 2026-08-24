# Forge Digital — Firebase setup

Both tools now share one live Firestore database, so you and your teammate see
the same leads and call history as they change.

```
claude/
├─ public/                  <-- ONLY this folder gets published to the web
│  ├─ index.html            (Forge Digital Workspace — the homepage)
│  ├─ client-hub.html
│  ├─ script-generator.html
│  └─ forge-shared.js       (Firebase config, sign-in gate, app nav, shared rules)
├─ firebase.json
├─ .firebaserc
├─ firestore.rules          <-- the real access lock
├─ firestore.indexes.json
└─ migrate-local-data.html  (one-off rescue tool, never published)
```

> **Double-clicking the HTML files no longer works.** The Firebase modular SDK
> loads as an ES module, and browsers refuse to load modules over `file://`.
> The pages must be served over http/https — that's what Hosting is for.

---

## Step 1 — Who has access ✅ already done

Two accounts are approved:

- `liam.coughlin1@gmail.com`
- `thomas.chkuaseli06@gmail.com`

They are listed in **two** places, which must always stay identical:

1. `public/forge-shared.js` → `ALLOWED_EMAILS`
2. `firestore.rules` → the list inside `isApproved()`

The list in `forge-shared.js` only controls what the page displays — anyone can
edit their own copy of that in devtools. `firestore.rules` is enforced by
Google's servers and is what actually protects the data.

To add or remove someone later, change both lists and redeploy:

```bash
firebase deploy --only hosting,firestore:rules
```

---

## Step 2 — Firebase Console (one time)

Go to <https://console.firebase.google.com> → **forge-digital-hub**.

1. **Build → Firestore Database → Create database.**
   Choose **Production mode** (the rules you deploy in step 4 replace whatever
   it starts with) and pick a region near you, e.g. `us-east1`. Nothing works
   until this database exists.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
   Set a support email, then Save.

---

## Step 3 — Install the Firebase CLI

You don't have Node installed, so use the standalone Windows binary:

<https://firebase.tools/bin/win/instant/latest>

Download it, then run it from the folder it lands in. (If you'd rather use npm,
install Node.js first and then `npm install -g firebase-tools`.)

---

## Step 4 — Log in and deploy

From `C:\Users\Liam\OneDrive\folder\claude`:

```bash
firebase login
```

```bash
firebase deploy
```

That publishes the site **and** the security rules together. To push just one:

```bash
firebase deploy --only hosting
```

```bash
firebase deploy --only firestore:rules
```

---

## Step 5 — Open it

- **Workspace (homepage): `https://forge-digital-hub.web.app/`** ← bookmark this one
- Client Hub: `https://forge-digital-hub.web.app/client-hub.html`
- Script Generator: `https://forge-digital-hub.web.app/script-generator.html`

The FD logo in the top-left of every page opens a side menu to switch between
the three. An old bookmark to `/index.html?leadId=…` still works — the
Workspace forwards that hand-off straight to the Script Generator.

Both of you sign in with Google once; the session persists. Send your teammate
the Client Hub link — they don't need any files.

`web.app` and `firebaseapp.com` are authorised for sign-in automatically. If you
ever use a custom domain, add it under **Authentication → Settings → Authorised
domains** or the Google popup will refuse it.

---

## How the data is laid out

**`leads` collection** — one document per lead. All three views live in this
one collection; which bucket a lead appears in is **derived**, never stored:

| bucket | rule |
|---|---|
| **History** | `status` is `Not Interested` or `Closed` |
| **Follow-ups** | `lastCallAt` is set (a call has been logged) |
| **Active** | neither — never called yet |

Because Follow-ups keys off `lastCallAt`, every lead created before the
follow-up system simply doesn't have that field and stays exactly where it
was. Nothing was migrated or rewritten.

| field | meaning |
|---|---|
| `status` | New, Called, Sent Portfolio, Follow-up, Not Interested, Booked Call, Closed |
| `lastCallAt` | ms timestamp of the most recent logged call — also what moves a lead into Follow-ups |
| `lastCallOutcomes` | the outcome(s) ticked on that call |
| `followUpDueDate` | `YYYY-MM-DD` the next follow-up is due; `null` once the lead goes terminal |
| `callCount` | how many calls have been logged |
| `archivedAt` | date it first hit a terminal status (`Not Interested` / `Closed`), else `null` |
| `createdAt` / `updatedAt` | server timestamps |
| `createdBy` | email of whoever added it |

**`callHistory` collection** — one document per business, holding the generated
script data plus the full `outcomeLog` of every call attempt.

---

## Things worth knowing

- **Deletes are shared and permanent.** Deleting a lead removes it for both of
  you. The confirmation dialogs say so.
- **Only `public/` is published.** Anything you drop in the parent folder stays
  private — that's why the web files live in a subfolder.
- **Offline:** Firestore keeps an in-memory cache, so a brief network blip won't
  lose your work, but a full page reload while offline will show an empty list.
  The header chip shows `Live`, `Offline — cached`, or `Sync error`.
- **If the list stays empty and the chip says `Sync error`,** the rules almost
  certainly aren't deployed yet, or the signed-in email isn't in
  `firestore.rules`. Check the browser console for `permission-denied`.
