import { describe, it, expect } from 'vitest';
import { solveShiftAssignmentGreedy } from '../lib/schedulerCore';
import { addHours, differenceInSeconds } from 'date-fns';

describe('Fairness and Distribution', () => {
  const skillFair = "guard_fair";
  const post = {
    name: "Fair_Gate",
    shift_length_hours: 4,
    start_time: "00:00",
    end_time: "23:59",
    cooldown_hours: 4,
    intensity_weight: 1.0,
    slots: [{ role_index: 0, skill: skillFair }]
  };

  const getSoldiers = (count) => {
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      name: `Soldier_${i}`,
      skills: [skillFair]
    }));
  };

  const countAssignments = (results) => {
    const counts = {};
    results.forEach(r => {
      counts[r.soldier_id] = (counts[r.soldier_id] || 0) + 1;
    });
    return counts;
  };

  it('distributes shifts evenly among 5 soldiers', () => {
    const soldiers = getSoldiers(5);
    const start = new Date(2025, 0, 1, 0, 0);
    
    // 20 hours = 5 shifts
    const shifts = Array.from({ length: 5 }, (_, i) => ({
      post_name: post.name,
      start: addHours(start, i * 4),
      end: addHours(start, (i + 1) * 4),
      post: post
    }));

    const results = solveShiftAssignmentGreedy(shifts, soldiers);
    const counts = countAssignments(results);

    expect(results.length).toBe(5);
    soldiers.forEach(s => {
      expect(counts[s.id]).toBe(1);
    });
  });

  it('prefers soldiers with lower history scores', () => {
    const s1 = { id: 1, name: "HighHistory", skills: [skillFair] };
    const s2 = { id: 2, name: "LowHistory", skills: [skillFair] };
    const start = new Date(2025, 0, 1, 0, 0);
    const shift = { post_name: post.name, start, end: addHours(start, 4), post };

    const history = { [s1.id]: 100, [s2.id]: 10 };
    const results = solveShiftAssignmentGreedy([shift], [s1, s2], history);

    expect(results.length).toBe(1);
    expect(results[0].soldier_id).toBe(s2.id);
  });

  it('maximizes rest by spacing shifts apart', () => {
    // 2 soldiers, 4 shifts (16h)
    // Should ideally alternate: A, B, A, B
    const soldiers = getSoldiers(2);
    const start = new Date(2025, 0, 1, 0, 0);
    const shifts = Array.from({ length: 4 }, (_, i) => ({
      post_name: post.name,
      start: addHours(start, i * 4),
      end: addHours(start, (i + 1) * 4),
      post: post
    }));

    const results = solveShiftAssignmentGreedy(shifts, soldiers);
    const counts = countAssignments(results);

    expect(results.length).toBe(4);
    soldiers.forEach(s => expect(counts[s.id]).toBe(2));

    // Check rest gap for soldier 1
    const s1Assignments = results.filter(r => r.soldier_id === 1).sort((a, b) => a.start - b.start);
    const gapSeconds = differenceInSeconds(s1Assignments[1].start, s1Assignments[0].end);
    expect(gapSeconds / 3600).toBeGreaterThanOrEqual(4);
  });
});
