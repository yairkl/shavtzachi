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

The Schedule tab is coloured by division (10 colours, looked up from the Soldiers tab by header, so reordered columns work). Mistakes made while editing it by hand are caught in two ways:

- **Live, in the sheet - for shifts of any duration.** A helper tab, *Schedule Check*, expands every shift over all the rows it covers (using its post's shift length, because merged cells only hold the name in their first row) and flags problems with formulas. In the Schedule tab a cell turns **red** when the same person is on another post at the same time (a 24h shift and a 4h shift are compared correctly) and **amber** when they get less rest than a cooldown allows. Typing a name takes effect immediately. The helper tab is regenerated on every Save and by *Check schedule*; press that if you change a post's shift length or cooldown, or add rows or columns, by hand.
- **On demand and on every save:** *Settings -> Spreadsheet health -> Check schedule* (and every Save in the Scheduler) checks all saved assignments for double booking, cooldown, missing skills, excluded posts, unavailability and people missing from the roster. Problem cells get bold red text and a note explaining why. These marks refresh only when you save or check again.

Cooldown means the rest needed after finishing a shift of a post: the gap before the next shift must be at least the cooldown of the earlier shift's post. Both shifts of the pair are flagged. The helper formulas are checked in the unit tests with a spreadsheet engine against the app's rule engine on random schedules.

### Day View

After a schedule is saved the spreadsheet gets a **Day View** tab: pick a day in the dropdown in cell B1 and the table shows just that day, instantly, with formulas (no app needed). Shifts are repeated on every row they cover, so a night shift that started the evening before still shows at the top of the next day. In the app, **Scheduler -> Day in Sheets** builds the tab if needed and opens it on the day you are looking at. The tab is rebuilt on every save and by *Check schedule* (it keeps your selected day); if you change a post's shift length by hand, press *Check schedule*. Days are identified as `yyyy-mm-dd` so the dropdown means the same day in every spreadsheet locale.

**Getting around a long schedule (100 days and more):** the Schedule tab's frozen corner cell is a link, *Date ▸ jump to a day*, that takes you to a clickable list of every day in the Day View; one click lands on the first row of that day in the Schedule tab. The Day View also has an *Open <day> in the Schedule tab* link next to the dropdown. Every day also gets a Name Box shortcut (`Day_2025_03_10`): type it in the box left of the formula bar, or pick it from the dropdown there, to select that day's rows. In the app, **Scheduler -> Edit in Sheets** opens the Schedule tab at the day on screen. The links and shortcuts are rebuilt on every save and by *Check schedule*.

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
