import { describe, it, expect } from 'vitest';
import { generateShifts } from '../lib/schedulerCore';
import { parseISO } from 'date-fns';

describe('Shift Generation', () => {
  const samplePost = {
    name: "Gate_Sample",
    shift_length_hours: 4,
    start_time: "00:00",
    end_time: "23:59",
    cooldown_hours: 4,
    intensity_weight: 1.0,
    slots: [{ role_index: 0, skill: "guard_sample" }],
    is_active: true
  };

  it('generates correct number of shifts for a 12h window', () => {
    const start = new Date(2025, 0, 1, 0, 0);
    const end = new Date(2025, 0, 1, 12, 0);
    const shifts = generateShifts([samplePost], start, end);
    // 00:00-04:00, 04:00-08:00, 08:00-12:00
    expect(shifts.length).toBe(3);
  });

  it('respects active_from constraint', () => {
    const postWithLimit = {
      ...samplePost,
      active_from: "2025-01-01T08:00:00"
    };
    const start = new Date(2025, 0, 1, 0, 0);
    const end = new Date(2025, 0, 1, 12, 0);
    const shifts = generateShifts([postWithLimit], start, end);
    // Only 08:00-12:00 should be included
    expect(shifts.length).toBe(1);
    expect(shifts[0].start.getHours()).toBe(8);
  });

  it('handles multiday shifts correctly (stability test)', () => {
    const multidayPost = {
      ...samplePost,
      name: "LongMission",
      shift_length_hours: 48,
      start_time: "06:00",
      end_time: "06:00"
    };

    // Day 1: 2025-01-01 06:00 to 2025-01-02 06:00 — should see exactly 1 shift overlapping
    const start1 = new Date(2025, 0, 1, 6, 0);
    const end1 = new Date(2025, 0, 2, 6, 0);
    const shifts1 = generateShifts([multidayPost], start1, end1, true);
    expect(shifts1.length).toBe(1);
    expect(shifts1[0].start.getHours()).toBe(6); // always starts at the post's start_time

    // Day 2: 2025-01-02 06:00 to 2025-01-03 06:00 — should also see exactly 1 shift
    const start2 = new Date(2025, 0, 2, 6, 0);
    const end2 = new Date(2025, 0, 3, 6, 0);
    const shifts2 = generateShifts([multidayPost], start2, end2, true);
    expect(shifts2.length).toBe(1);
    expect(shifts2[0].start.getHours()).toBe(6); // always starts at the post's start_time
  });
});
