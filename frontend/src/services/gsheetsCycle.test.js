import { describe, it, expect } from 'vitest';
import { buildScheduleRequests, parseGrid } from './gsheetsUtils';
import { parseISO, format } from 'date-fns';

describe('gsheetsUtils - Save/Load Cycle', () => {
  it('should correctly round-trip assignments (Save then Load)', () => {
    const sheetId = 123;
    const startDate = "2024-05-01T00:00:00Z";
    const endDate = "2024-05-02T00:00:00Z";
    
    // Define assignments (The "Save" payload)
    const originalAssignments = [
      {
        post_name: "Guard",
        start: "2024-05-01T06:00:00Z",
        end: "2024-05-01T10:00:00Z",
        role_id: 0,
        soldier_name: "John Doe"
      },
      {
        post_name: "Patrol",
        start: "2024-05-01T10:00:00Z",
        end: "2024-05-01T14:00:00Z",
        role_id: 1, // Second role of Patrol
        soldier_name: "Jane Smith"
      }
    ];

    // 1. GENERATE GRID (SIMULATE SAVE)
    const requests = buildScheduleRequests(sheetId, originalAssignments, startDate, endDate, 1);
    const updateCells = requests.find(r => r.updateCells);
    const merges = requests.filter(r => r.mergeCells).map(r => r.mergeCells.range);
    
    // Convert rowData to simple gridRows for parseGrid
    const gridRows = updateCells.updateCells.rows.map(row => 
      row.values.map(cell => cell.userEnteredValue?.stringValue || "")
    );

    // 2. PARSE GRID (SIMULATE LOAD)
    // activePosts isn't actually used for structure in current parseGrid, 
    // it just needs it to exist.
    const loadedAssignments = parseGrid(gridRows, [], merges, 4);

    console.log("Original:", originalAssignments.length);
    console.log("Loaded:", loadedAssignments.length);
    loadedAssignments.forEach(a => console.log(`Loaded: ${a.soldier_name} at ${a.post_name} role ${a.role_id}`));

    // 3. VERIFY
    expect(loadedAssignments.length).toBe(originalAssignments.length);
    
    originalAssignments.forEach(original => {
      const oDt = parseISO(original.start);
      const oKey = format(oDt, 'yyyyMMddHHmm');
      
      const found = loadedAssignments.find(loaded => {
        const lKey = format(loaded.start, 'yyyyMMddHHmm');
        const match = loaded.soldier_name === original.soldier_name &&
                      loaded.post_name === original.post_name &&
                      loaded.role_id === original.role_id &&
                      lKey === oKey;
        
        if (loaded.soldier_name === original.soldier_name) {
            console.log(`Comparing ${original.soldier_name}:`);
            console.log(`  Orig: ${original.post_name} R${original.role_id} Key:${oKey}`);
            console.log(`  Load: ${loaded.post_name} R${loaded.role_id} Key:${lKey}`);
            console.log(`  Match: ${match}`);
        }
        return match;
      });
      expect(found).toBeDefined();
    });
  });
});
