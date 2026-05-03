import { describe, it, expect } from 'vitest';
import { buildScheduleRequests } from './gsheetsUtils.js';

describe('buildScheduleRequests', () => {
  it('should render soldier names when role_id is passed as a string', () => {
    const sheetId = "12345";
    const startDate = new Date("2026-05-03T06:00:00.000Z"); 
    const endDate = new Date("2026-05-03T21:00:00.000Z");

    const assignments = [
      {
        post_name: "Post A",
        role_id: "0", // Passed as string
        soldier_name: "Alice",
        start: new Date("2026-05-03T06:00:00.000Z"),
        end: new Date("2026-05-03T10:00:00.000Z")
      }
    ];

    const requests = buildScheduleRequests(sheetId, assignments, startDate, endDate, 4);
    const updateReq = requests.find(r => r.updateCells);
    const rows = updateReq.updateCells.rows;
    const names = [];
    for (const row of rows) {
      for (const cell of row.values || []) {
        if (cell.userEnteredValue?.stringValue) {
           names.push(cell.userEnteredValue.stringValue);
        }
      }
    }
    
    console.log("Names with string role_id:", names);
    expect(names).toContain("Alice");
  });
});
