/**
 * Rules a finished schedule must satisfy. Used by the Scheduler page (live warnings while editing)
 * and by the spreadsheet check (conflicts marked in the Schedule tab).
 *
 * `shifts` are slots: { soldier_id, soldier_name?, post_name, role_id, skill, start, end } where start/end
 * are Dates or ISO strings. Empty slots (no soldier) are ignored.
 *
 * Returns warnings: { slotIndex, type, message } with type one of
 *   overlap | cooldown | skill | unavailability | excluded | unknown
 */
import { format } from 'date-fns';

const t = (v) => (v instanceof Date ? v : new Date(v));
const hhmm = (d) => format(d, 'HH:mm');

export function validateAssignments(shifts, posts, soldiers, unavailabilities = []) {
  if (!Array.isArray(shifts)) {
    console.error("validateAssignments error: 'shifts' is not an array", shifts);
    return [];
  }
  const warnings = [];
  const soldierMap = {};
  for (const s of soldiers) soldierMap[s.id] = s;
  const postMap = {};
  for (const p of posts) postMap[p.name] = p;

  // Assigned slots grouped by soldier
  const bySoldier = {};
  shifts.forEach((slot, idx) => {
    if (slot.soldier_id != null) {
      (bySoldier[slot.soldier_id] ||= []).push({ idx, slot });
    }
  });

  shifts.forEach((slot, idx) => {
    if (slot.soldier_id == null) return;
    const soldier = soldierMap[slot.soldier_id];
    const post = postMap[slot.post_name];
    const slotStart = t(slot.start);
    const slotEnd = t(slot.end);

    if (!soldier) {
      warnings.push({ slotIndex: idx, type: 'unknown', message: `"${slot.soldier_name ?? slot.soldier_id}" is not in the Soldiers sheet, so this assignment cannot be checked` });
      return;
    }

    // 0. Unavailability
    for (const u of unavailabilities) {
      if (u.soldier_id === soldier.id) {
        const uStart = t(u.start_datetime);
        const uEnd = t(u.end_datetime);
        if (slotStart < uEnd && uStart < slotEnd) {
          warnings.push({ slotIndex: idx, type: 'unavailability', message: `${soldier.name} is unavailable: ${u.reason || 'No specific reason given'}` });
        }
      }
    }

    // 1. Skill mismatch
    if (slot.skill && !(soldier.skills && soldier.skills.includes(slot.skill))) {
      warnings.push({ slotIndex: idx, type: 'skill', message: `${soldier.name} lacks required skill "${slot.skill}"` });
    }

    // 1.5 Post exclusion
    if (soldier.excluded_posts && soldier.excluded_posts.includes(slot.post_name)) {
      warnings.push({ slotIndex: idx, type: 'excluded', message: `${soldier.name} is excluded from post "${slot.post_name}"` });
    }

    // 2. Overlapping shifts & 3. Cooldown (against the same soldier's other shifts)
    const cooldownHours = post ? post.cooldown_hours : 0;
    for (const other of bySoldier[slot.soldier_id] || []) {
      if (other.idx === idx) continue;
      const otherStart = t(other.slot.start);
      const otherEnd = t(other.slot.end);
      const otherPost = postMap[other.slot.post_name];
      const otherCooldownHours = otherPost ? otherPost.cooldown_hours : 0;

      if (slotStart < otherEnd && otherStart < slotEnd) {
        if (idx < other.idx) { // report each pair once, on both slots
          warnings.push({ slotIndex: idx, type: 'overlap', message: `${soldier.name} is double-booked (overlaps with ${other.slot.post_name} ${hhmm(otherStart)}-${hhmm(otherEnd)})` });
          warnings.push({ slotIndex: other.idx, type: 'overlap', message: `${soldier.name} is double-booked (overlaps with ${slot.post_name} ${hhmm(slotStart)}-${hhmm(slotEnd)})` });
        }
        continue;
      }

      // Cooldown is the rest needed after finishing a shift of a post: the gap between two consecutive shifts
      // must be at least the cooldown of the EARLIER shift's post. Both shifts of the pair are reported.
      const gap = (otherStart - slotEnd) / 36e5;          // this shift, then other
      const reverseGap = (slotStart - otherEnd) / 36e5;   // other shift, then this
      if (gap >= 0 && gap < cooldownHours && idx < other.idx) {
        warnings.push({ slotIndex: idx, type: 'cooldown', message: `Only ${gap.toFixed(1)}h rest before ${other.slot.post_name} (needs ${cooldownHours}h cooldown)` });
        warnings.push({ slotIndex: other.idx, type: 'cooldown', message: `Only ${gap.toFixed(1)}h rest after ${slot.post_name} (needs ${cooldownHours}h cooldown)` });
      }
      if (reverseGap >= 0 && reverseGap < otherCooldownHours && idx < other.idx) {
        warnings.push({ slotIndex: other.idx, type: 'cooldown', message: `Only ${reverseGap.toFixed(1)}h rest before ${slot.post_name} (needs ${otherCooldownHours}h cooldown)` });
        warnings.push({ slotIndex: idx, type: 'cooldown', message: `Only ${reverseGap.toFixed(1)}h rest after ${other.slot.post_name} (needs ${otherCooldownHours}h cooldown)` });
      }
    }
  });

  return warnings;
}

/** slotIndex -> warnings[] */
export function buildWarningMap(warnings) {
  const map = {};
  for (const w of warnings) (map[w.slotIndex] ||= []).push(w);
  return map;
}
