/**
 * Who to offer in the dropdown of each shift slot of the Schedule tab, best fit first.
 *
 * It uses the same engine as the app's candidate list (evaluateSoldierFitness): skill, post exclusion, being busy,
 * unavailability, cooldown and fairness (fewest accumulated hours first). Everyone is offered, so an admin can still
 * assign an unsuitable person when there is no choice - they are simply listed after the people who fit, and the note
 * on the slot says why.
 *
 * A dropdown can only write the chosen item's text into the cell, so the list holds plain names; the "how does this
 * person fit" information lives in the order and in the slot's note.
 */
import { differenceInSeconds } from 'date-fns';
import { evaluateSoldierFitness } from '../lib/schedulerCore';

/** Marks the dropdowns created by the app (so a dropdown someone made by hand is recognised and left alone). */
export const LIST_MESSAGE = 'Pick a soldier (best fit first)';
export const isOurDropdown = (rule) => String(rule?.inputMessage || '').startsWith('Pick a soldier');
export const MAX_LIST_BLOCKS = 400; // most recent slots that get their own ordered list
export const MAX_LIST_NAMES = 450; // Google's limit for a list is 500 items

// Problems that make someone a poor choice for a slot (cooldown is softer: it only lowers the ranking).
const HARD = ['skill_mismatch', 'excluded_post', 'occupied', 'unavailable'];

/** Accumulated workload per soldier id (hours x post intensity) over the given assignments. */
export function workload(assignments, posts) {
  const intensity = new Map(posts.map((p) => [p.name.toLowerCase(), p.intensity_weight || 1]));
  const out = {};
  for (const a of assignments) {
    if (a.soldier_id == null) continue;
    const hours = differenceInSeconds(new Date(a.end), new Date(a.start)) / 3600;
    out[a.soldier_id] = (out[a.soldier_id] || 0) + hours * (intensity.get(String(a.post_name).toLowerCase()) || 1);
  }
  return out;
}

/**
 * Rank every soldier for one slot, best first.
 * ctx = { soldiers (with .unavailabilities), assignmentsBySoldier: Map(id -> assignments), history }
 */
export function rankForSlot(slot, post, ctx) {
  const skill = post.slots.find((s) => s.role_index === slot.role_id)?.skill;
  const ranked = ctx.soldiers.map((soldier) => {
    const { score, conflicts } = evaluateSoldierFitness(
      soldier, slot.start, slot.end, post, slot.role_id, ctx.history, ctx.assignmentsBySoldier.get(soldier.id) || [], [],
    );
    const hard = conflicts.filter((c) => HARD.includes(c));
    return { soldier, score, conflicts, hard, load: ctx.history[soldier.id] || 0, skill };
  });
  ranked.sort((a, b) => (a.hard.length - b.hard.length) || (b.score - a.score) || a.soldier.name.localeCompare(b.soldier.name));
  return ranked;
}

const why = (r) => r.conflicts.map((c) => ({
  skill_mismatch: `lacks "${r.skill}"`,
  excluded_post: 'excluded from this post',
  occupied: 'already on another shift then',
  unavailable: 'unavailable',
  cooldown: 'would not get enough rest',
}[c] || c));

/** The note shown when hovering an empty slot: who fits best and why the others do not. */
export function suggestionNote(ranked) {
  const fits = ranked.filter((r) => r.hard.length === 0);
  const poor = ranked.filter((r) => r.hard.length > 0);
  const lines = [];
  if (fits.length) {
    lines.push('Best fits (fewest hours first):');
    fits.slice(0, 6).forEach((r, i) => {
      const rest = r.conflicts.includes('cooldown') ? ', but rest would be short' : '';
      lines.push(`${i + 1}. ${r.soldier.name} - load ${r.load.toFixed(1)}h${rest}`);
    });
    if (fits.length > 6) lines.push(`... and ${fits.length - 6} more who fit`);
  } else {
    lines.push('Nobody fits this slot cleanly. The dropdown lists everyone, least problematic first.');
  }
  if (poor.length) {
    lines.push('', 'Not suitable:');
    poor.slice(0, 6).forEach((r) => lines.push(`- ${r.soldier.name}: ${why(r).join(', ')}`));
    if (poor.length > 6) lines.push(`... and ${poor.length - 6} more`);
  }
  return lines.join('\n');
}

/** The dropdown rule for a slot: everyone, best fit first. */
export function listRule(ranked) {
  return {
    condition: { type: 'ONE_OF_LIST', values: ranked.slice(0, MAX_LIST_NAMES).map((r) => ({ userEnteredValue: r.soldier.name })) },
    inputMessage: LIST_MESSAGE,
    strict: false,
    showCustomUi: true,
  };
}
