# Award Voting System

A responsive six-award ballot and administrator dashboard backed by Cloud Firestore. Voters enter their full name and submit one nominee for each award in a single ballot. The server stores the voter name with each ballot and enforces a 55-ballot maximum.

## Requirements

- Node.js 22 or newer
- A Firebase project with Cloud Firestore enabled
- Application Default Credentials authorized for that project

The supplied Firebase web configuration identifies project `votings-a4db3`. The server uses the project ID and ADC; the web API key is not a server credential.

## Setup on Windows

1. Copy the environment template and set a random value for `SESSION_SECRET`. Keep `.env` private:

   ```powershell
   Copy-Item .env.example .env
   ```

   Confirm `FIREBASE_PROJECT_ID=votings-a4db3`. Ensure ADC is available to the Node process (for example, through `GOOGLE_APPLICATION_CREDENTIALS` or an existing Google Cloud runtime identity). The identity needs permission to read and write Firestore.

2. Create the project's default Cloud Firestore database if it does not exist. Deploy the included deny-all client rules so database access stays on this authenticated server:

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

- `electionConfig/main`: schedule, open/closed state, and submitted ballot count.
- `awards`: six award titles, ordering, and per-candidate aggregate results.
- `candidates`: the three nominee names shared across all six awards.
- `admins`: bcrypt password hashes keyed by normalized username.
- `voters`: normalized full-name voter identifiers used to prevent duplicate ballots; these are removed by an election reset.
- `votes`: voter names and six-award selections with random document IDs.
- `sessions`: expiring server-side administrator sessions.

The server validates each ballot and full name and writes the voter identifier, selections, per-award counts, and ballot count in one Firestore transaction. Reset closes voting, clears aggregate counts, and deletes ballot and voter documents. Sessions expire after eight hours; configure Firestore TTL on `sessions.expiresAt` to automatically remove expired session documents.

## Voting and administration

- Administrators sign in from the public page's **Administrator sign in** link.
- Rename the six default awards and replace the three nominee names before starting. Award and candidate management become locked after voting starts; reset the election to edit them again.
- Optionally schedule a start date while the election is closed. Choose a 5-, 10-, 15-, or 20-minute voting window each time voting starts or reopens; the server automatically closes voting at the deadline and rejects any later submissions.
- Exactly six awards and three candidates are required to start voting. All three nominees appear under each award.
- Voters enter a first and last name, choose one nominee for each award, and submit one complete ballot. The normalized full name may submit only one ballot.
- The server accepts no more than 55 complete ballots. Because each ballot contains one choice per award, this caps each award at 55 votes; the server closes voting as soon as the limit is reached.
- If an award is tied after voting closes, the administrator can start a timed runoff for the tied awards only. Voters choose among the nominees tied for each award; the 55-vote cap applies to each tied award, and each full name may vote once in the runoff, including voters who participated in the main election. A unique runoff leader becomes the winner. If a runoff remains tied or gets no votes, the administrator selects one of the tied nominees.
- The administrator can rename awards from **Awards** and finish voting early from **Overview** or **Voting management**. Otherwise voting closes automatically when the selected duration expires. The overview and **Winner announcement** views show the winner or the pending tie-break state; while voting is open, they show current leaders only.
- The voter page and administrator pages display a live countdown based on the election deadline saved by the server.
- Results refresh every 10 seconds in the administrator dashboard. CSV export includes main and tie-break vote totals, percentages, and any final winner.
- Each award is finalized independently after voting closes and any required tie-break is resolved. Live detailed results remain administrator-only.

For production, serve the app only over HTTPS, use a least-privilege Google service identity, keep application secrets out of source control, and back up the Firestore database.
