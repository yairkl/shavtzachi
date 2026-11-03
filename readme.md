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

### Editing the spreadsheet by hand

The Soldiers, Posts and Unavailabilities tabs are meant to be edited directly in Google Sheets. New spreadsheets (and newly created tabs) are formatted automatically; for an existing one use **Settings -> Spreadsheet health -> Format sheets for editing**. It adds a styled, frozen header with explanatory notes, dropdowns (TRUE/FALSE, soldier names), input checks that warn but never block, `yyyy-mm-dd hh:mm` / `hh:mm` formats (so dates read back unambiguously in any locale), and red/amber highlighting of cells the app cannot read (duplicate names, bad times, end before start, unknown soldiers...). Cell contents are never changed, and running it again refreshes only the app's own highlight rules.

### Schedule rules in the sheet

The Schedule tab is coloured by division (10 colours, looked up from the Soldiers tab by header, so reordered columns work). Two things protect against mistakes made while editing it by hand:

- **Live:** typing a name that already appears in the same time row turns the cell red immediately (a common double booking).
- **On demand and on every save:** *Settings -> Spreadsheet health -> Check schedule* (and every Save in the Scheduler) checks all saved assignments for double booking across any overlap, cooldown (the rest between shifts must respect both posts' cooldowns), missing skills, excluded posts, unavailability and people missing from the roster. Problem cells get bold red text and a note explaining why. Marks refresh only when you save or run the check again; they are not live formulas.

### Tests

- `npm test` - unit tests, including an in-memory fake of the Google Sheets API (`src/tests/helpers/fakeSheets.js`) used to test hand-edited and imported spreadsheets end to end.
- `npm run test:e2e` - real-browser tests (Playwright + Chromium) of the built app against that same fake, in `frontend/e2e/`. First time: `npx playwright install chromium`. Add new scenarios to `e2e/*.e2e.test.js` using the helpers in `e2e/helpers/harness.js` (`startApp`, `open(tabs)`, `toast`).

- `npm run test:contract` - validates every request the app sends against Google's published Sheets v4 API schema (needs network, no credentials).
- `GOOGLE_ACCESS_TOKEN=... npm run test:live` - smoke test against the **real** Google Sheets API using a throw-away spreadsheet. Copy the token from DevTools -> Application -> Local Storage -> `google_access_token` while signed in to the app. `LIVE_DRYRUN=1 npm run test:live` runs the same test against the fake.
- `npm run lint` - must be clean.

Pull requests run lint, the unit and contract tests, and the browser tests (`.github/workflows/ci.yml`).

Pushes to `master` run the tests, build the app and deploy it to GitHub Pages (`.github/workflows/deploy.yml`).

## Google sign-in

The app uses the OAuth client configured in `frontend/src/services/auth.js`. Google deletes OAuth clients that are unused for about six months, so sign in to the app now and then to keep it active. See the open issues for planned OAuth hardening.

## Roadmap

See the [issue tracker](https://github.com/yairkl/shavtzachi/issues).
