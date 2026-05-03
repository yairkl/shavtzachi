import { describe, it, expect } from 'vitest';
import { solveShiftAssignmentGreedy } from '../lib/schedulerCore';
import { addHours } from 'date-fns';

describe('Greedy Solver', () => {
  const commonSkill = "common";
  const rareSkill = "rare";

  const sRare = { id: 1, name: "Rare Soldier", skills: [rareSkill] };
  const sCommon1 = { id: 2, name: "Common 1", skills: [commonSkill] };
  const sCommon2 = { id: 3, name: "Common 2", skills: [commonSkill] };

  const pRare = {
    name: "Rare Post",
    shift_length_hours: 4,
    start_time: "00:00",
    end_time: "23:59",
    cooldown_hours: 4,
    intensity_weight: 1.0,
    slots: [{ role_index: 0, skill: rareSkill }]
  };

  const pCommon = {
    name: "Common Post",
    shift_length_hours: 4,
    start_time: "00:00",
    end_time: "23:59",
    cooldown_hours: 4,
    intensity_weight: 1.0,
    slots: [{ role_index: 0, skill: commonSkill }]
  };

  it('prioritizes critical shifts (high demand/supply)', () => {
    // Setup high demand for common, low demand for rare
    // Common: 2 soldiers. Post is 24/7. Demand = (4+4)/4 * 24/24 = 2.0. Criticality = 2.0 / 2 = 1.0
    // Rare: 1 soldier. Post is active 1h. Demand = (1+0)/1 * 1/24 = 0.04. Criticality = 0.04 / 1 = 0.04
    
    const pRareLow = { ...pRare, shift_length_hours: 1, start_time: "12:00", end_time: "13:00", cooldown_hours: 0 };
    
    const start = new Date(2026, 0, 1, 0, 0);
    const end = new Date(2026, 0, 1, 23, 0);

    const shifts = [
      { post_name: pRareLow.name, start: new Date(2026, 0, 1, 12, 0), end: new Date(2026, 0, 1, 13, 0), post: pRareLow },
      { post_name: pCommon.name, start: new Date(2026, 0, 1, 0, 0), end: new Date(2026, 0, 1, 4, 0), post: pCommon },
      { post_name: pCommon.name, start: new Date(2026, 0, 1, 4, 0), end: new Date(2026, 0, 1, 8, 0), post: pCommon }
    ];

    const results = solveShiftAssignmentGreedy(shifts, [sRare, sCommon1, sCommon2]);

    // The first shift in results should be the one with higher rarity (Common Post in this setup)
    // Wait, the logic sorts by rarity.
    expect(results[0].post_name).toBe("Common Post");
  });

  it('prioritizes longer shifts when rarity is equal', () => {
    const pShort = { ...pCommon, name: "Short Post", shift_length_hours: 4 };
    const pLong = { ...pCommon, name: "Long Post", shift_length_hours: 8 };

    const start = new Date(2026, 0, 1, 0, 0);
    const shifts = [
      { post_name: pShort.name, start, end: addHours(start, 4), post: pShort },
      { post_name: pLong.name, start, end: addHours(start, 8), post: pLong }
    ];

    // Only 1 soldier available for both overlapping shifts
    const results = solveShiftAssignmentGreedy(shifts, [sCommon1]);

    expect(results.length).toBe(1);
    expect(results[0].post_name).toBe("Long Post");
  });
});
