# Award Voting System

A responsive six-award ballot and administrator dashboard backed by Cloud Firestore. Voters submit one nominee for each award in a single ballot. The Node server uses Firebase Admin SDK with Application Default Credentials (ADC); browser code does not access Firestore directly. Voter identifiers are normalized and HMAC-hashed before storage, and voter choices are kept separate from voter records.

## Requirements

- Node.js 22 or newer
- A Firebase project with Cloud Firestore enabled
- Firebase Authentication with Google sign-in enabled
- Application Default Credentials authorized for that project

The supplied Firebase web configuration identifies project `votings-a4db3`. The server uses the project ID and ADC; the web API key is not a server credential.

## Setup on Windows

1. Copy the environment template and set distinct random values for `SESSION_SECRET` and `VOTER_HASH_SECRET`. Keep `.env` private:

   ```powershell
   Copy-Item .env.example .env
   ```

   Confirm `FIREBASE_PROJECT_ID=votings-a4db3`. Ensure ADC is available to the Node process (for example, through `GOOGLE_APPLICATION_CREDENTIALS` or an existing Google Cloud runtime identity). The identity needs permission to read and write Firestore.

2. In Firebase Console, open **Authentication → Get started → Sign-in method → Google**, enable the provider, and set a project support email. Under **Authentication → Settings → Authorized domains**, ensure `localhost` and your production domain are listed. Create the project's default Cloud Firestore database if it does not exist. Deploy the included deny-all client rules so database access stays on this authenticated server:

   ```powershell
   firebase use votings-a4db3
   firebase deploy --only firestore:rules
   ```

   The Firebase CLI must be installed and logged into an account authorized for the project. Admin SDK requests from this server use ADC and bypass Firestore client rules.

3. Install dependencies and initialize the election documents:

   ```powershell
   npm install
   npm run initialize-db
   ```

   Initialization is safe to rerun: existing election configuration, award titles, and candidate names are preserved. A new project is seeded with six editable award titles, three nominee names, and a closed election.

4. Create or update the administrator account (password must be at least 12 characters):

   ```powershell
   $env:ADMIN_USERNAME = "award-admin"
   $env:ADMIN_PASSWORD = "use-a-unique-password-of-at-least-12-characters"
   npm run create-admin
   Remove-Item Env:ADMIN_USERNAME
   Remove-Item Env:ADMIN_PASSWORD
   ```

5. Start the server and open `http://localhost:3000`:

   ```powershell
   npm start
   ```

## Firestore data

- `electionConfig/main`: schedule, open/closed state, election epoch, and submitted ballot count.
- `awards`: six award titles, ordering, and per-candidate aggregate results.
- `candidates`: the three nominee names shared across all six awards.
- `admins`: bcrypt password hashes keyed by normalized username.
- `voters`: one HMAC-derived document per verified Google email and election; no raw email or candidate choice.
- `votes`: anonymous six-award selections with random document IDs.
- `sessions`: expiring server-side administrator sessions.

The server validates every vote and writes the voter record, anonymous vote, and candidate count in a Firestore transaction. Reset closes voting, clears aggregate counts, increments the election epoch, and deletes vote and voter documents. Sessions expire after eight hours; configure Firestore TTL on `sessions.expiresAt` to automatically remove expired session documents.

## Voting and administration

- Administrators sign in from the public page's **Administrator sign in** link.
- Rename the six default awards and replace the three nominee names before starting. Award and candidate management become locked after voting starts; reset the election to edit them again.
- Optionally schedule a start date while the election is closed. Every start or reopen creates a 10-minute voting window; the server automatically closes voting at the deadline and rejects any later submissions.
- Exactly six awards and three candidates are required to start voting. All three nominees appear under each award.
- Voters sign in with Google, choose one nominee per award, and submit all six choices together. The server verifies the Firebase ID token, requires a verified Google email, stores only an HMAC hash of the email, and rejects repeat ballots from that account.
- The responsive website works in desktop and mobile browsers. Google sign-in uses a redirect in mobile browsers and a popup on desktop. The Firebase project's linked Google OAuth web client must allow `https://votings-1.onrender.com/__/auth/handler` as an authorized redirect URI for the mobile redirect flow.
- The administrator can rename awards from **Awards** and finish voting early from **Overview** or **Voting management**. Otherwise it closes automatically after 10 minutes. The overview and **Winner announcement** views then show the winner or tie for each award; while voting is open, they show current leaders only.
- The voter page and administrator pages display a live countdown based on the election deadline saved by the server.
- Google sign-in prevents reuse of the same account, but does not restrict voting to a pre-approved roster of Google accounts.
- Results refresh every 10 seconds in the administrator dashboard. CSV export includes each award, nominee, vote total, and percentage.
- The final winner or tie is determined independently for each award only after voting closes. Live detailed results remain administrator-only.

For production, serve the app only over HTTPS, use a least-privilege Google service identity, keep application secrets out of source control, and back up the Firestore database.
