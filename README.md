# AuPair Matching (Firebase MVP)

Privacy-first rematch platform starter.

## What this starter includes

- Google login (Firebase Auth)
- Anonymous profile onboarding
- Candidate discovery by role and region
- Like and mutual match creation
- Consent-based reveal state
- In-platform chat after reveal
- Deletion request and purge workflow

## Architecture

- Hosting: static web app in `public/`
- Backend: Firebase Cloud Functions in `functions/`
- Database: Cloud Firestore with secure rules in `firestore.rules`

## 1. Prerequisites

- Node.js 20+
- Firebase CLI
- A Firebase project

Install CLI:

```powershell
npm install -g firebase-tools
firebase login
```

## 2. Configure project

This repository is preconfigured for project id `aupair-matching`.

If you need to switch project:

```powershell
firebase use --add
```

Update Firebase web config in `public/app.js`:

- `apiKey`
- `authDomain`
- `projectId`
- `storageBucket`
- `messagingSenderId`
- `appId`

You can copy these values from Firebase Console -> Project settings -> Your apps -> Web app.

In Firebase Console enable:

- Authentication -> Google provider
- Firestore database
- Functions (Blaze plan required)

## 3. Install functions dependencies

```powershell
Set-Location functions
npm install
Set-Location ..
```

## 4. Run locally with emulators

```powershell
firebase emulators:start
```

Open the local Hosting URL shown in terminal.

## 5. Deploy

Deploy all:

```powershell
firebase deploy
```

Or deploy in steps:

```powershell
firebase deploy --only firestore:rules
firebase deploy --only functions
firebase deploy --only hosting
```

## 6. Git init and push

If this folder is not yet a git repository:

```powershell
git init
git add .
git commit -m "Initial Firebase MVP"
git branch -M main
git remote add origin <your-git-repo-url>
git push -u origin main
```

If git is already initialized:

```powershell
git add .
git commit -m "Update Firebase project and deployment setup"
git push
```

## 7. Test flow

1. Sign in with Google
2. Save anonymous profile
3. Load candidates
4. Like candidate from each side to create mutual match
5. Both users click reveal consent
6. Send chat messages
7. Request deletion and run deletion job

## Important notes

- This is an MVP starter and should be hardened before production.
- Keep personal data minimal.
- Add App Check, rate limiting, moderation, and legal policy pages before launch.
