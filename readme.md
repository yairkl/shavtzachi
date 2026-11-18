# Shavtzachi (שבצחי) - Shift Scheduler

Shavtzachi is a fully serverless, constraints-based shift scheduler. It runs entirely in your browser and stores all data in **your own Google Spreadsheet** - there is no backend and no database to host.

Live app: https://yairkl.github.io/shavtzachi/

## Features

- Automated greedy scheduling that respects skills, cooldowns, post exclusions, unavailability and a fairness history score.
- Real-time conflict detection while editing a draft schedule.
- Soldiers, posts and unavailability management, with CSV/XLSX import and export.
- Excel export of the final schedule.
- Your data stays in your Google Sheet; sign in with Google to connect.

## Tech stack

React 19, Vite, Tailwind CSS, Radix/shadcn UI, Google Identity Services + Google Sheets API. Deployed to GitHub Pages.

## Development

```bash
cd frontend
npm install
npm run dev      # local dev server
npm test         # unit tests (Vitest)
npm run build    # production build
```

### Tests

- `npm test` - unit tests, including an in-memory fake of the Google Sheets API (`src/tests/helpers/fakeSheets.js`) used to test hand-edited and imported spreadsheets end to end.
- `npm run test:e2e` - real-browser tests (Playwright + Chromium) of the built app against that same fake, in `frontend/e2e/`. First time: `npx playwright install chromium`. Add new scenarios to `e2e/*.e2e.test.js` using the helpers in `e2e/helpers/harness.js` (`startApp`, `open(tabs)`, `toast`).

- `npm run test:contract` - validates every request the app sends against Google's published Sheets v4 API schema (needs network, no credentials).
- `GOOGLE_ACCESS_TOKEN=... npm run test:live` - smoke test against the **real** Google Sheets API using a throw-away spreadsheet. Copy the token from DevTools -> Application -> Local Storage -> `google_access_token` while signed in to the app. `LIVE_DRYRUN=1 npm run test:live` runs the same test against the fake.
- `npm run lint` - must be clean.

### Running the live test in CI

Google access tokens always expire after about an hour, so a permanent token does not exist. CI uses a **service account** instead: a robot Google identity whose key is stored once as a GitHub secret and exchanged for a fresh token on every run. The test creates its own throw-away spreadsheet in that account and deletes it afterwards, so none of your real spreadsheets are touched and nothing needs to be shared with it.

One-time setup (about 5 minutes):

1. In the [Google Cloud console](https://console.cloud.google.com/) pick a project (the one that holds the app's OAuth client is fine) and enable the **Google Sheets API** and the **Google Drive API** (APIs & Services -> Library).
2. IAM & Admin -> Service Accounts -> **Create service account** (for example `shavtzachi-ci`). It needs no roles.
3. Open it -> Keys -> **Add key -> Create new key -> JSON**. A file downloads.
4. In the GitHub repository: Settings -> Secrets and variables -> Actions -> **New repository secret** named `GOOGLE_SA_KEY`, value = the whole contents of that JSON file. Then delete the downloaded file.
5. If the run stops with `PERMISSION_DENIED` when creating the spreadsheet (service accounts often may not create files): create an empty spreadsheet in your own Drive, share it with the service account's e-mail (`client_email` in the JSON) as **Editor**, and add a repository *variable* `GOOGLE_TEST_SPREADSHEET_ID` = the long id from its URL. The test then resets that spreadsheet at the start of every run instead of creating one (do not use a spreadsheet with real data).
6. Run it: Actions -> **Live Google test** -> Run workflow. To also run it every Monday, add a repository *variable* `GOOGLE_LIVE_TESTS` = `true`.

Notes: the workflow does not run on pull requests (forks cannot read secrets, and it writes to a real Google account). The workflow signs its own token request with the key (`frontend/scripts/service-account-token.mjs`), so only the Sheets and Drive APIs need to be enabled: no IAM Credentials API and no extra permission on the service account. To run it from your own machine, use the one-hour token from the browser as described above.

Pull requests run lint, the unit and contract tests, and the browser tests (`.github/workflows/ci.yml`).

Pushes to `master` run the tests, build the app and deploy it to GitHub Pages (`.github/workflows/deploy.yml`).

## Google sign-in

The app uses the OAuth client configured in `frontend/src/services/auth.js`. Google deletes OAuth clients that are unused for about six months, so sign in to the app now and then to keep it active. See the open issues for planned OAuth hardening.

## Roadmap

See the [issue tracker](https://github.com/yairkl/shavtzachi/issues).
