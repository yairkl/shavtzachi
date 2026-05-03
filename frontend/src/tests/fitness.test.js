import { describe, it, expect } from 'vitest';
import { evaluateSoldierFitness } from '../lib/schedulerCore';
import { addHours, addDays } from 'date-fns';

describe('Soldier Fitness Evaluation', () => {
  const sampleSkill = "commander";
  const sampleSoldier = {
    id: 1,
    name: "John Doe",
    skills: [sampleSkill],
    excluded_posts: []
  };

  const samplePost = {
    name: "Main Gate",
    shift_length_hours: 4,
    cooldown_hours: 8,
    intensity_weight: 1.0,
    slots: [{ role_index: 0, skill: sampleSkill }]
  };

  it('evaluates a perfect candidate correctly', () => {
    const start = new Date(2026, 0, 1, 12, 0);
    const end = addHours(start, 4);

    const { score, conflicts } = evaluateSoldierFitness(
      sampleSoldier, start, end, samplePost, 0, {}, []
    );

    expect(score).toBeGreaterThan(0);
    expect(conflicts.length).toBe(0);
  });

  it('detects skill mismatch', () => {
    const start = new Date(2026, 0, 1, 12, 0);
    const end = addHours(start, 4);
    const otherPost = {
      ...samplePost,
      slots: [{ role_index: 0, skill: "driver" }]
    };

    const { score, conflicts } = evaluateSoldierFitness(
      sampleSoldier, start, end, otherPost, 0, {}, []
    );

    expect(conflicts).toContain("skill_mismatch");
    expect(score).toBeLessThan(0);
  });

  it('detects occupied overlap', () => {
    const start = new Date(2026, 0, 1, 12, 0);
    const end = addHours(start, 4);

    const existingAssignments = [{
      soldier_id: sampleSoldier.id,
      post_name: "Main Gate",
      start: new Date(2026, 0, 1, 10, 0),
      end: new Date(2026, 0, 1, 14, 0),
      role_id: 0
    }];

    const { conflicts } = evaluateSoldierFitness(
      sampleSoldier, start, end, samplePost, 0, {}, existingAssignments
    );

    expect(conflicts).toContain("occupied");
  });

  it('detects unavailability conflict', () => {
    const start = new Date(2026, 0, 1, 12, 0);
    const end = addHours(start, 4);
    const soldierWithUnavailability = {
      ...sampleSoldier,
      unavailabilities: [{
        start_datetime: new Date(2026, 0, 1, 8, 0),
        end_datetime: new Date(2026, 0, 1, 16, 0)
      }]
    };

    const { conflicts } = evaluateSoldierFitness(
      soldierWithUnavailability, start, end, samplePost, 0, {}, []
    );

    expect(conflicts).toContain("unavailable");
  });

  it('detects cooldown violation', () => {
    const start = new Date(2026, 0, 1, 12, 0);
    const end = addHours(start, 4);

    // Gap of 2h < 8h cooldown
    const existingAssignments = [{
      soldier_id: sampleSoldier.id,
      post_name: "Main Gate",
      start: new Date(2026, 0, 1, 6, 0),
      end: new Date(2026, 0, 1, 10, 0),
      role_id: 0
    }];

    const { conflicts, lastShift } = evaluateSoldierFitness(
      sampleSoldier, start, end, samplePost, 0, {}, existingAssignments
    );

    expect(conflicts).toContain("cooldown");
    expect(lastShift).not.toBeNull();
    expect(lastShift.post_name).toBe("Main Gate");
  });

  it('respects history scores and rest bonus', () => {
    const start = new Date(2026, 0, 1, 12, 0);
    const end = addHours(start, 4);

    const { score: scoreFresh } = evaluateSoldierFitness(
      sampleSoldier, start, end, samplePost, 0, { [sampleSoldier.id]: 0 }, []
    );
    const { score: scoreBusy } = evaluateSoldierFitness(
      sampleSoldier, start, end, samplePost, 0, { [sampleSoldier.id]: 100 }, []
    );

    expect(scoreFresh).toBeGreaterThan(scoreBusy);
  });
});
