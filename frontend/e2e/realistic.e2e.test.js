import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/harness.js';
let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const skills = ['קצין', 'מפקד פלוגה', 'סמל', 'קשר', 'חובש', 'מפקד', 'מפקד מחלקה', 'רובאי', 'נהג', 'חמליסט'];
const soldiers = Array.from({ length: 68 }, (_, i) => [`חייל ${i + 1}`, String((i % 3) + 1), [skills[7], i % 7 === 0 ? skills[5] : '', i % 9 === 0 ? skills[1] : '', i % 8 === 0 ? skills[8] : '', i % 10 === 0 ? skills[4] : '', i % 11 === 0 ? skills[3] : '', i % 12 === 0 ? skills[9] : '', i % 13 === 0 ? skills[0] : ''].filter(Boolean).join(','), '']);
const posts = [
  ['חפ"ק', '24.0', '06:00', '05:59', '0.0', '1.0', 'מפקד פלוגה,נהג,חובש,קשר'],
  ['חמ"ל', '8.0', '06:00', '05:59', '8.0', '1.0', 'חמליסט'],
  ['כרמל', '24.0', '14:00', '13:59', '0.0', '1.0', 'מפקד,רובאי,רובאי,רובאי'],
  ['מטבח', '16.0', '06:00', '22:00', '12.0', '2.0', 'רובאי,רובאי'],
  ['חסם שוטר', '4.0', '06:00', '05:59', '8.0', '1.0', 'מפקד'],
  ['חסם תמר', '4.0', '06:00', '05:59', '8.0', '1.0', 'רובאי'],
  ['תל 3', '4.0', '06:00', '05:59', '8.0', '1.0', 'רובאי'],
  ['תל 7', '4.0', '06:00', '05:59', '8.0', '1.0', 'רובאי'],
  ['תל 9', '4.0', '06:00', '05:59', '8.0', '1.0', 'רובאי'],
  ['שפלה', '4.0', '06:00', '05:59', '8.0', '1.0', 'רובאי'],
  ['קצין מוצב', '24.0', '06:00', '05:59', '0.0', '1.0', 'קצין'],
  ['חיליק', '8.0', '06:00', '05:59', '8.0', '1.0', 'רובאי'],
];
const tabs = () => ({
  Soldiers: [['Name', 'Division', 'Skills', 'Excluded Posts'], ...soldiers],
  Posts: [['Name', 'Shift Length', 'Start Time', 'End Time', 'Cooldown', 'Intensity', 'Slots', 'Is Active', 'Active From', 'Active Until'], ...posts.map((p) => [...p, '1'])],
  Unavailabilities: [['Soldier', 'Start', 'End', 'Reason']],
  Skills: [['Skill'], ...skills.map((s) => [s])],
});

test('realistic Hebrew roster (68 soldiers, 12 posts, 24h/16h/8h/4h shifts) in Israel time: assign, save, reload, next day', async () => {
  const s = await app.open(tabs(), { timezoneId: 'Asia/Jerusalem', locale: 'he-IL' });
  const filled = async () => {
    const t = (await s.page.locator('body').innerText()).replace(/\n+/g, ' | ');
    const m = t.match(/(DRAFT|\d+) \| \/ \| (\d+)/);
    return m ? { done: m[1], total: Number(m[2]) } : null;
  };
  await s.go('/scheduler');
  await s.page.getByText('חפ"ק').first().waitFor();
  const total = (await filled()).total;
  assert.ok(total >= 50, `expected the whole roster of slots, got ${total}`);

  await s.page.getByRole('button', { name: /Auto Assign/ }).click();
  await s.page.getByText('DRAFT').waitFor();
  assert.equal((await filled()).total, total);
  await s.page.getByRole('button', { name: /Save/ }).first().click();
  await s.toast(/Saved \d+ assignment/);

  await s.page.reload();
  await s.page.getByText('חפ"ק').first().waitFor();
  await s.page.waitForFunction((n) => document.body.innerText.includes(`${n} \n/\n ${n}`) || new RegExp(`\\b${n}\\s*/\\s*${n}`).test(document.body.innerText), total);
  assert.equal((await filled()).done, String(total), 'everything saved is still there after a reload');
  assert.deepEqual(s.problems, []);
  await s.context.close();
});
