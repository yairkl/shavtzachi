/**
 * Reproduction test for: "save erases all days except the current one"
 *
 * Root cause: clearValues() was called BEFORE getAssignmentsInRange(),
 * so the sheet was always empty when we tried to read existing data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildScheduleRequests, parseGrid } from './gsheetsUtils';
import { parseISO, format } from 'date-fns';

// ---------------------------------------------------------------------------
// Minimal mock of GsheetsService to simulate the save/load lifecycle
// without hitting a real Google Sheet.
// ---------------------------------------------------------------------------
class MockSheet {
  constructor() {
    this._rows = []; // Flat array of { row: string[] } — the raw grid values
    this._merges = [];
    this._gridRows = [];
    this.sheetId = 999;
    this.GRANULARITY = 4; // hours
  }

  // Simulate getAssignmentsInRange by parsing whatever is currently in the sheet
  readAssignments() {
    if (this._gridRows.length === 0) return [];
    return parseGrid(this._gridRows, [], this._merges, this.GRANULARITY);
  }

  // Simulate the fixed saveAssignments: fetch → clear → merge → write
  saveAssignments_FIXED(startDate, endDate, newAssignments) {
    // STEP 1: Read BEFORE clearing
    const existing = this.readAssignments();

    // STEP 2: Clear (simulated)
    this._gridRows = [];
    this._merges = [];

    // STEP 3: Filter out assignments that overlap the save window
    const saveStart = typeof startDate === 'string' ? parseISO(startDate) : startDate;
    const saveEnd   = typeof endDate   === 'string' ? parseISO(endDate)   : endDate;

    const otherDays = existing.filter(a => {
      const aStart = a.start instanceof Date ? a.start : parseISO(a.start);
      const aEnd   = a.end   instanceof Date ? a.end   : parseISO(a.end);
      const overlaps = aStart.getTime() < saveEnd.getTime() && aEnd.getTime() > saveStart.getTime();
      return !overlaps;
    });

    const combined = [...otherDays, ...newAssignments];
    if (combined.length === 0) return;

    combined.sort((a, b) => {
      const da = a.start instanceof Date ? a.start : parseISO(a.start);
      const db = b.start instanceof Date ? b.start : parseISO(b.start);
      return da - db;
    });

    const firstStart = combined[0].start instanceof Date ? combined[0].start : parseISO(combined[0].start);
    const lastEnd    = combined[combined.length - 1].end instanceof Date
      ? combined[combined.length - 1].end
      : parseISO(combined[combined.length - 1].end);

    const fullStart = format(firstStart, "yyyy-MM-dd'T'HH:mm:ss");
    const fullEnd   = format(lastEnd,    "yyyy-MM-dd'T'HH:mm:ss");

    // STEP 4: Build the new grid
    const requests = buildScheduleRequests(this.sheetId, combined, fullStart, fullEnd, 1);
    const updateCells = requests.find(r => r.updateCells);
    this._gridRows = updateCells.updateCells.rows.map(row =>
      row.values.map(cell => cell.userEnteredValue?.stringValue || '')
    );
    this._merges = requests.filter(r => r.mergeCells).map(r => r.mergeCells.range);
  }

  // Simulate the BUGGY saveAssignments: clear BEFORE fetch (what was happening)
  saveAssignments_BUGGY(startDate, endDate, newAssignments) {
    // STEP 1 (bug): Clear FIRST — this wipes the data we need to read
    this._gridRows = [];
    this._merges = [];

    // STEP 2 (bug): Now reading returns nothing because we just cleared it
    const existing = this.readAssignments(); // always []

    const saveStart = typeof startDate === 'string' ? parseISO(startDate) : startDate;
    const saveEnd   = typeof endDate   === 'string' ? parseISO(endDate)   : endDate;
    const otherDays = existing.filter(a => {
      const aStart = a.start instanceof Date ? a.start : parseISO(a.start);
      const aEnd   = a.end   instanceof Date ? a.end   : parseISO(a.end);
      return !(aStart.getTime() < saveEnd.getTime() && aEnd.getTime() > saveStart.getTime());
    });

    const combined = [...otherDays, ...newAssignments]; // otherDays is always []!
    if (combined.length === 0) return;

    combined.sort((a, b) => {
      const da = a.start instanceof Date ? a.start : parseISO(a.start);
      const db = b.start instanceof Date ? b.start : parseISO(b.start);
      return da - db;
    });

    const firstStart = combined[0].start instanceof Date ? combined[0].start : parseISO(combined[0].start);
    const lastEnd    = combined[combined.length - 1].end instanceof Date
      ? combined[combined.length - 1].end
      : parseISO(combined[combined.length - 1].end);

    const fullStart = format(firstStart, "yyyy-MM-dd'T'HH:mm:ss");
    const fullEnd   = format(lastEnd,    "yyyy-MM-dd'T'HH:mm:ss");

    const requests = buildScheduleRequests(this.sheetId, combined, fullStart, fullEnd, 1);
    const updateCells = requests.find(r => r.updateCells);
    this._gridRows = updateCells.updateCells.rows.map(row =>
      row.values.map(cell => cell.userEnteredValue?.stringValue || '')
    );
    this._merges = requests.filter(r => r.mergeCells).map(r => r.mergeCells.range);
  }
}

// ---------------------------------------------------------------------------
// Sample data: Day 1 and Day 2 assignments
// ---------------------------------------------------------------------------
const day1Assignments = [
  { post_name: 'Guard', start: '2024-05-01T06:00:00', end: '2024-05-01T10:00:00', role_id: 0, soldier_name: 'Alice' },
  { post_name: 'Guard', start: '2024-05-01T10:00:00', end: '2024-05-01T14:00:00', role_id: 0, soldier_name: 'Bob'   },
];

const day2Assignments = [
  { post_name: 'Guard', start: '2024-05-02T06:00:00', end: '2024-05-02T10:00:00', role_id: 0, soldier_name: 'Charlie' },
];

describe('Multi-day save: previous days must survive a partial save', () => {

  it('REPRODUCES BUG: buggy save (clear before fetch) erases day 1 when saving day 2', () => {
    const sheet = new MockSheet();

    // Save day 1
    sheet.saveAssignments_BUGGY('2024-05-01T00:00:00', '2024-05-02T00:00:00', day1Assignments);
    expect(sheet.readAssignments().length).toBe(2); // Day 1 is there

    // Save day 2 — with the bug, day 1 vanishes
    sheet.saveAssignments_BUGGY('2024-05-02T00:00:00', '2024-05-03T00:00:00', day2Assignments);
    const all = sheet.readAssignments();

    // BUG: only day2 survives, day1 is gone
    const day1Survivors = all.filter(a => {
      const s = a.start instanceof Date ? a.start : parseISO(a.start);
      return s.getDate() === 1;
    });
    // This assertion documents the bug — it SHOULD fail with the buggy impl
    expect(day1Survivors.length).toBe(0); // ← Bug confirmed: day 1 was wiped
  });

  it('FIXES BUG: correct save (fetch before clear) preserves day 1 when saving day 2', () => {
    const sheet = new MockSheet();

    // Save day 1
    sheet.saveAssignments_FIXED('2024-05-01T00:00:00', '2024-05-02T00:00:00', day1Assignments);
    expect(sheet.readAssignments().length).toBe(2);

    // Save day 2 — with the fix, day 1 survives
    sheet.saveAssignments_FIXED('2024-05-02T00:00:00', '2024-05-03T00:00:00', day2Assignments);
    const all = sheet.readAssignments();

    const day1Survivors = all.filter(a => {
      const s = a.start instanceof Date ? a.start : parseISO(a.start);
      return s.getDate() === 1;
    });
    const day2Survivors = all.filter(a => {
      const s = a.start instanceof Date ? a.start : parseISO(a.start);
      return s.getDate() === 2;
    });

    expect(day1Survivors.length).toBe(2);   // Both day-1 assignments survived
    expect(day2Survivors.length).toBe(1);   // Day-2 assignment was written
    expect(all.length).toBe(3);
  });
});
