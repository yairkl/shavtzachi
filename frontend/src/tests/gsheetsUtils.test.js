import { describe, it, expect } from 'vitest';
import { parseGrid, buildScheduleRequests } from '../services/gsheetsUtils';
import { addHours, format, parseISO } from 'date-fns';

describe('GSheets Utils - Grid Logic', () => {
  const activePosts = [
    {
      name: "Post A",
      slots: [{ role_index: 0, skill: "Guard" }],
      shift_length_hours: 4
    }
  ];

  it('builds schedule requests correctly', () => {
    const startDate = "2025-01-01T00:00:00";
    const endDate = "2025-01-01T08:00:00";
    const assignments = [
      {
        soldier_name: "John",
        post_name: "Post A",
        start: "2025-01-01T00:00:00",
        end: "2025-01-01T04:00:00",
        role_id: 0
      }
    ];

    const sheetId = 123;
    const requests = buildScheduleRequests(sheetId, assignments, startDate, endDate, 4);

    expect(requests.length).toBeGreaterThan(0);
    // Should have updateCells for rowData and mergeCells for the assignment
    const updateCells = requests.find(r => r.updateCells);
    expect(updateCells).toBeDefined();
    
    // Check if John is in the grid
    const rows = updateCells.updateCells.rows;
    // Row 2 is data start. Col 2 is Post A.
    expect(rows[2].values[2].userEnteredValue.stringValue).toBe("John");
  });

  it('parses grid back into assignments correctly', () => {
    // Mock grid data
    // Row 0: Headers (Date, Time, Post A)
    // Row 1: Subheaders (Role 1)
    // Row 2: Data (2025-01-01, 00:00-04:00, John)
    const gridRows = [
      ["Date", "Time", "Post A"],
      ["", "", "Role 1"],
      ["01/01/2025", "00:00 - 04:00", "John"],
      ["01/01/2025", "04:00 - 08:00", "Doe"]
    ];

    const assignments = parseGrid(gridRows, activePosts, [], 4);

    expect(assignments.length).toBe(2);
    expect(assignments[0].soldier_name).toBe("John");
    expect(assignments[0].post_name).toBe("Post A");
    expect(assignments[1].soldier_name).toBe("Doe");
  });

  it('handles merged cells in grid parsing', () => {
    const gridRows = [
      ["Date", "Time", "Post A"],
      ["", "", "Role 1"],
      ["01/01/2025", "00:00 - 04:00", "John"],
      ["01/01/2025", "04:00 - 08:00", ""], // Merged with John above
    ];

    const merges = [
      { startRowIndex: 2, endRowIndex: 4, startColumnIndex: 2, endColumnIndex: 3 }
    ];

    const assignments = parseGrid(gridRows, activePosts, merges, 4);

    expect(assignments.length).toBe(1);
    expect(assignments[0].soldier_name).toBe("John");
    // End time should be 08:00 (since it spans 2 rows of 4h each)
    expect(format(assignments[0].end, 'HH:mm')).toBe("08:00");
  });
});
