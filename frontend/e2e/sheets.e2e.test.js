import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/harness.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const HEAD = {
  Soldiers: ['Name', 'Division', 'Skills', 'Excluded Posts'],
  Posts: ['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active', 'Active From', 'Active Until'],
  Unavailabilities: ['Soldier', 'Start', 'End', 'Reason'],
};

/** A hand-edited spreadsheet: odd header names/order, loose time formats, TRUE/blank flags, no Unavailabilities or Schedule tab. */
const messySheet = () => ({
  Soldiers: [['שם', 'Division', 'Skills'], ['Dan', '1', 'guard'], ['Eli', '2', 'Guard, medic'], ['Avi', '1', 'guard'], ['Ben', '2', 'guard']],
  posts: [
    ['Name', 'Shift length', 'Start', 'End', 'Slots', 'Active'],
    ['Gate', '8h', '6:00', '6 PM', 'guard, guard', 'TRUE'],
    ['Clinic', '12', '', '', 'medic', ''],
    ['Off', '4', '', '', 'guard', 'no'],
  ],
});

test('messy imported sheet: auto-assign, save, and everything is really persisted', async () => {
  const s = await app.open(messySheet());
  await s.go('/scheduler');
  await s.page.getByRole('button', { name: /Auto Assign/ }).click();
  const assigned = await s.toast(/Assigned all (\d+) slots/);
  const total = Number(assigned.match(/(\d+) slots/)[1]);
  assert.ok(total >= 5, `expected shifts for Gate and Clinic, got ${total}`);

  await s.page.getByRole('button', { name: /Save/ }).first().click();
  await s.toast(/Saved \d+ assignment/);

  // Read it back through the app's own "Spreadsheet health" check (the same read path as every page).
  await s.go('/settings');
  const text = await s.page.getByText(/scheduled assignment/).first().textContent();
  const persisted = Number(text.match(/(\d+) scheduled assignment/)[1]);
  assert.equal(persisted, total, 'every assignment shown must be in the spreadsheet (nothing silently dropped)');
  const sheetText = JSON.stringify(s.fake.rows('Schedule'));
  assert.ok(sheetText.includes('Gate'), 'Gate (8h shifts from 06:00) must be saved');
  assert.deepEqual(s.problems, []);
  await s.context.close();
});

test('dashboard reports spreadsheet problems and Settings can repair the structure', async () => {
  const s = await app.open(messySheet());
  await s.go('/');
  await s.page.getByText(/Your spreadsheet has \d+ warning/).waitFor();
  await s.go('/settings');
  await s.page.getByText(/Found 4 soldier/).waitFor();
  await s.page.getByRole('button', { name: /Repair sheet structure/ }).click();
  await s.toast(/Repaired/);
  assert.ok(s.fake.tab('Unavailabilities'), 'missing tab is created');
  assert.deepEqual(s.fake.rows('Soldiers')[1].slice(0, 3), ['Dan', '1', 'guard'], 'existing data is untouched');
  assert.deepEqual(s.problems, []);
  await s.context.close();
});

test('an empty spreadsheet explains why nothing can be scheduled instead of failing silently', async () => {
  const s = await app.open({ Soldiers: [HEAD.Soldiers], Posts: [HEAD.Posts], Unavailabilities: [HEAD.Unavailabilities] });
  await s.go('/scheduler');
  await s.page.getByText('Why is nothing being scheduled?').waitFor();
  await s.page.getByText(/There are no soldiers/).waitFor();
  assert.deepEqual(s.problems, []);
  await s.context.close();
});

test('all posts inactive -> clear explanation', async () => {
  const s = await app.open({
    Soldiers: [HEAD.Soldiers, ['Dan', '', 'guard', '']],
    Posts: [HEAD.Posts, ['Gate', '4', '00:00', '00:00', '0', '1', 'guard', 'FALSE', '', '']],
    Unavailabilities: [HEAD.Unavailabilities],
  });
  await s.go('/scheduler');
  await s.page.getByText(/All 1 post\(s\) are inactive/).waitFor();
  await s.context.close();
});

test('CSV import through the UI reports skipped rows and writes the rest', async () => {
  const s = await app.open({ Soldiers: [HEAD.Soldiers, ['Existing', '', 'guard', '']], Posts: [HEAD.Posts], Unavailabilities: [HEAD.Unavailabilities] });
  await s.go('/soldiers');
  await s.page.getByText('Existing').first().waitFor();
  const csv = 'Name;Division;Skills\nDan;1;guard\nexisting;2;guard\n;3;guard\nEli;x;medic\n';
  await s.page.locator('input[type=file]').first().setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await s.page.getByText('Import finished').waitFor();
  await s.page.getByText(/Division "x" is not a number/).waitFor();
  await s.page.getByRole('button', { name: 'Close' }).click();
  assert.deepEqual(s.fake.rows('Soldiers').map((r) => r[0]), ['Name', 'Existing', 'Dan', 'Eli']);
  assert.deepEqual(s.problems, []);
  await s.context.close();
});

test('a permission error while saving shows a clear message and leaves the sheet unchanged', async () => {
  const s = await app.open(messySheet());
  await s.go('/scheduler');
  await s.page.getByRole('button', { name: /Auto Assign/ }).click();
  await s.toast(/Assigned/);
  s.fake.failNextBatch = Object.assign(new Error('forbidden'), {
    response: { status: 403, data: { error: { message: 'The caller does not have permission' } } },
  });
  await s.page.getByRole('button', { name: /Save/ }).first().click();
  await s.toast(/permission|denied/i);
  assert.equal(s.fake.tab('Schedule'), undefined, 'nothing was written');
  await s.context.close();
});

test('signed-out visitors see the login page, not a broken app', async () => {
  const s = await app.open({}, { signedIn: false });
  await s.go('/');
  await s.page.getByRole('button', { name: /Sign in with Google/ }).waitFor();
  await s.context.close();
});

test('Excel export of a saved schedule downloads a real file, and the soldiers CSV round-trips', async () => {
  const XLSX = (await import('xlsx')).default;
  const { readFileSync } = await import('node:fs');
  const s = await app.open(messySheet());
  await s.go('/scheduler');
  await s.page.getByRole('button', { name: /Auto Assign/ }).click();
  await s.toast(/Assigned all/);
  await s.page.getByRole('button', { name: /Save/ }).first().click();
  await s.toast(/Saved \d+ assignment/);

  const [download] = await Promise.all([s.page.waitForEvent('download'), s.page.getByRole('button', { name: /Excel/ }).click()]);
  assert.match(download.suggestedFilename(), /^schedule_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const wb = XLSX.read(readFileSync(await download.path()));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  assert.ok(rows.length >= 5, `expected the saved assignments, got ${rows.length}`);
  assert.deepEqual(Object.keys(rows[0]), ['Start', 'End', 'Post', 'Role', 'Soldier']);

  await s.go('/soldiers');
  await s.page.getByText('Dan').first().waitFor();
  const [csv] = await Promise.all([s.page.waitForEvent('download'), s.page.getByRole('button', { name: /Export/ }).click()]);
  assert.equal(csv.suggestedFilename(), 'soldiers.csv');
  const text = readFileSync(await csv.path(), 'utf8');
  assert.match(text, /Name,Division,Skills,Excluded Posts/);
  assert.match(text, /Eli,2,"Guard, medic"|Eli,2,"guard, medic"/i);
  assert.deepEqual(s.problems, []);
  await s.context.close();
});
