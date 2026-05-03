import { describe, it, expect } from 'vitest';
import { buildScheduleRequests, parseGrid } from './gsheetsUtils';
import { parseISO, format } from 'date-fns';

describe('gsheetsUtils - Reproduction of Empty Cells', () => {
  it('should reproduce data loss when using 4h granularity with a 06:00 shift', () => {
    const sheetId = 123;
    const startDate = "2024-05-01T00:00:00Z";
    const endDate = "2024-05-02T00:00:00Z";
    const granularity = 4;
    
    // Assignment starts at 06:00
    const assignments = [
      {
        post_name: "Guard",
        start: "2024-05-01T06:00:00Z",
        end: "2024-05-01T10:00:00Z",
        role_id: 0,
        soldier_name: "John Doe"
      }
    ];

    // 1. Save to Grid
    const requests = buildScheduleRequests(sheetId, assignments, assignments[0].start, endDate, granularity);
    const updateCells = requests.find(r => r.updateCells);
    const gridRows = updateCells.updateCells.rows.map(row => 
      row.values.map(cell => cell.userEnteredValue?.stringValue || "")
    );
    const merges = requests.filter(r => r.mergeCells).map(r => r.mergeCells.range);

    // 2. Load from Grid
    const loaded = parseGrid(gridRows, [], merges, granularity);

    // 3. Compare
    console.log("Original start:", assignments[0].start);
    console.log("Loaded start:", loaded[0].start.toISOString());

    // In a 4h grid anchored at 00:00, 06:00 will be snapped to 04:00
    expect(loaded[0].start.toISOString()).not.toBe(assignments[0].start);
    console.log("REPRODUCED: Data was mutated by granularity snapping!");
  });
});
