import { 
  addDays, 
  addHours, 
  addSeconds, 
  differenceInHours, 
  differenceInSeconds, 
  isAfter, 
  isBefore, 
  isEqual, 
  parseISO, 
  setHours, 
  setMinutes, 
  setSeconds, 
  startOfDay,
  format
} from 'date-fns';

/**
 * Port of Python's generate_shifts
 */
export function generateShifts(posts, startDate, endDate, includeOverflow = false) {
  let shifts = [];
  const start = typeof startDate === 'string' ? parseISO(startDate) : startDate;
  const end = typeof endDate === 'string' ? parseISO(endDate) : endDate;

  // Clean microsecond precision
  const startClean = start;
  const endClean = end;

  for (const post of posts) {
    if (post.active_from && isAfter(parseISO(post.active_from), endClean)) continue;
    if (post.active_until && isBefore(parseISO(post.active_until), startClean)) continue;

    // Stable anchor relative to start date to avoid DST-induced hour shifts.
    // We anchor at the start of the requested window (at the post's start_time),
    // then walk backwards by complete shift-lengths to find the lookback origin.
    const [startH, startM] = post.start_time.split(':').map(Number);
    // Anchor at the post's start_time on the same calendar day as startClean
    const anchor = setHours(setMinutes(setSeconds(startClean, 0), startM), startH);

    const shiftLengthSeconds = post.shift_length_hours * 3600;
    // Walk back far enough to ensure we cover any shift that might overlap the window start
    const lookbackDays = Math.floor(shiftLengthSeconds / 86400) + 2;
    const lookbackTarget = addDays(anchor, -lookbackDays);

    // Calculate how many complete shift-lengths fit between lookbackTarget and anchor
    const deltaSeconds = (lookbackTarget.getTime() - anchor.getTime()) / 1000;
    const shiftsToSkip = Math.floor(deltaSeconds / shiftLengthSeconds);

    // Start from a point before the window, aligned to the shift sequence
    let currentShiftStart = addSeconds(anchor, shiftsToSkip * shiftLengthSeconds);
    let currentDay = startOfDay(currentShiftStart);

    while (isBefore(currentDay, endClean)) {
      const [postStartH, postStartM] = post.start_time.split(':').map(Number);
      const [postEndH, postEndM] = post.end_time.split(':').map(Number);

      let activeStart = setHours(setMinutes(setSeconds(currentDay, 0), postStartM), postStartH);
      let activeEnd;

      if (postStartH >= postEndH) {
        activeEnd = setHours(setMinutes(setSeconds(addDays(currentDay, 1), 0), postEndM), postEndH);
      } else {
        activeEnd = setHours(setMinutes(setSeconds(currentDay, 0), postEndM), postEndH);
      }

      if (isBefore(currentShiftStart, activeStart)) {
        currentShiftStart = activeStart;
      }

      while (isBefore(currentShiftStart, activeEnd)) {
        if (shiftLengthSeconds <= 0) break;

        const currentShiftEnd = addSeconds(currentShiftStart, shiftLengthSeconds);

        const isOverlap = currentShiftStart.getTime() < endClean.getTime() && currentShiftEnd.getTime() > startClean.getTime();
        const isStartingInWindow = currentShiftStart.getTime() >= startClean.getTime() && currentShiftStart.getTime() < endClean.getTime();

        let shouldInclude = includeOverflow ? isOverlap : isStartingInWindow;
        
        if (shouldInclude) {
          if (post.active_from) {
            const af = parseISO(post.active_from);
            if (isBefore(currentShiftStart, af)) shouldInclude = false;
          }
          if (post.active_until) {
            const au = parseISO(post.active_until);
            if (isAfter(currentShiftEnd, au)) shouldInclude = false;
          }
        }

        if (shouldInclude) {
          if (!shifts.some(s => s.post_name === post.name && isEqual(s.start, currentShiftStart))) {
            shifts.push({
              post_name: post.name,
              start: currentShiftStart,
              end: currentShiftEnd,
              post: post
            });
          }
        }

        currentShiftStart = currentShiftEnd;
      }

      if (isAfter(currentShiftStart, activeEnd)) {
        const newDay = startOfDay(currentShiftStart);
        currentDay = isAfter(addDays(currentDay, 1), newDay) ? addDays(currentDay, 1) : newDay;
      } else {
        currentDay = addDays(currentDay, 1);
      }
    }
  }

  shifts.sort((a, b) => a.start.getTime() - b.start.getTime() || a.post_name.localeCompare(b.post_name));
  return shifts;
}

/**
 * Port of evaluate_soldier_fitness
 */
export function evaluateSoldierFitness(
  soldier, 
  shiftStart, 
  shiftEnd, 
  post, 
  roleId, 
  historyScores, 
  existingAssignments, 
  draftAssignments = []
) {
  let score = 0;
  let conflicts = [];
  let draftLoad = 0;

  const start = typeof shiftStart === 'string' ? parseISO(shiftStart) : shiftStart;
  const end = typeof shiftEnd === 'string' ? parseISO(shiftEnd) : shiftEnd;

  // 1. Skill mismatch
  const requiredSkill = post.slots.find(s => s.role_index === roleId)?.skill;
  const soldierSkills = new Set(soldier.skills || []);
  
  if (requiredSkill && !soldierSkills.has(requiredSkill)) {
    score -= 1000;
    conflicts.push("skill_mismatch");
  } else {
    score += 100;
  }

  // 1.5 Post exclusion
  const excludedPosts = new Set(soldier.excluded_posts || []);
  if (excludedPosts.has(post.name)) {
    score -= 2000;
    conflicts.push("excluded_post");
  }

  // 2. Overlap, Cooldown & Diversity
  const windowStart = addDays(start, -30);
  const windowEnd = addDays(end, 30);

  let combinedAssignments = [];

  // Filter existing assignments for this soldier in window
  for (const a of existingAssignments) {
    if (a.soldier_id === soldier.id) {
      const aStart = typeof a.start === 'string' ? parseISO(a.start) : a.start;
      const aEnd = typeof a.end === 'string' ? parseISO(a.end) : a.end;
      
      if (isBefore(aStart, windowEnd) && isAfter(aEnd, windowStart)) {
        combinedAssignments.push({
          start: aStart,
          end: aEnd,
          post_name: a.post_name,
          role_id: a.role_id,
          intensity_weight: a.intensity_weight || 1.0
        });
      }
    }
  }

  // Add draft assignments
  for (const a of draftAssignments) {
    if (a.soldier_id === soldier.id) {
      const aStart = typeof a.start === 'string' ? parseISO(a.start) : a.start;
      const aEnd = typeof a.end === 'string' ? parseISO(a.end) : a.end;

      if (isBefore(aStart, windowEnd) && isAfter(aEnd, windowStart)) {
        combinedAssignments.push({
          start: aStart,
          end: aEnd,
          post_name: a.post_name,
          role_id: a.role_id,
          intensity_weight: a.intensity_weight || 1.0
        });
        const intensity = a.intensity_weight || 1.0;
        draftLoad += (differenceInSeconds(aEnd, aStart) / 3600) * intensity;
      }
    }
  }

  let lastShift = null;
  let nextShift = null;

  for (const a of combinedAssignments) {
    // Exact overlap
    if (isBefore(start, a.end) && isAfter(end, a.start)) {
      if (a.post_name === post.name && isEqual(a.start, start) && a.role_id === roleId) {
        continue;
      }
      score -= 2000;
      conflicts.push("occupied");
    }

    // Cooldown Before
    if (isBefore(a.end, start) || isEqual(a.end, start)) {
      const gap = differenceInSeconds(start, a.end) / 3600;
      const cooldownNeeded = post.cooldown_hours || 0; // Simplified: usually cooldown is post property
      if (gap < cooldownNeeded) {
        score -= 500;
        conflicts.push("cooldown");
      }

      // Mission Diversity
      if (a.post_name === post.name) {
        const daysSince = differenceInSeconds(start, a.end) / (24 * 3600);
        if (daysSince < 30) {
          const decayWeight = 1.0 - (daysSince / 30.0);
          score -= 30 * decayWeight;
        }
      }

      if (!lastShift || isAfter(a.end, lastShift.end)) {
        lastShift = a;
      }
    }

    // Cooldown After
    if (isAfter(a.start, end) || isEqual(a.start, end)) {
      const gap = differenceInSeconds(a.start, end) / 3600;
      const cooldownNeeded = post.cooldown_hours || 0;
      if (gap < cooldownNeeded) {
        score -= 500;
        conflicts.push("cooldown");
      }

      if (a.post_name === post.name) {
        const daysUntil = differenceInSeconds(a.start, end) / (24 * 3600);
        if (daysUntil < 30) {
          const decayWeight = 1.0 - (daysUntil / 30.0);
          score -= 30 * decayWeight;
        }
      }

      if (!nextShift || isBefore(a.start, nextShift.start)) {
        nextShift = a;
      }
    }
  }

  // 3. Unavailability
  if (soldier.unavailabilities) {
    for (const u of soldier.unavailabilities) {
      const uStart = typeof u.start_datetime === 'string' ? parseISO(u.start_datetime) : u.start_datetime;
      const uEnd = typeof u.end_datetime === 'string' ? parseISO(u.end_datetime) : u.end_datetime;
      if (isBefore(start, uEnd) && isAfter(end, uStart)) {
        score -= 2000;
        conflicts.push("unavailable");
      }
    }
  }

  // 4. Fairness
  const hScore = historyScores[soldier.id] || 0;
  const totalLoad = hScore + draftLoad;
  score -= totalLoad * 5;

  // 5. Rest bonus
  if (lastShift) {
    const intensity = lastShift.intensity_weight || 1.0;
    const restHours = differenceInSeconds(start, lastShift.end) / 3600;
    score += Math.min(restHours, 168) * (5 / intensity);
  } else {
    score += 168 * 2.5;
  }

  if (nextShift) {
    const intensity = post.intensity_weight || 1.0;
    const restHours = differenceInSeconds(nextShift.start, end) / 3600;
    score += Math.min(restHours, 168) * (5 / intensity);
  } else {
    score += 168 * 2.5;
  }

  return {
    score,
    conflicts: [...new Set(conflicts)],
    lastShift: lastShift ? { end: lastShift.end, post_name: lastShift.post_name } : null,
    nextShift: nextShift ? { start: nextShift.start, post_name: nextShift.post_name } : null
  };
}

/**
 * Port of solve_shift_assignment_greedy
 */
export function solveShiftAssignmentGreedy(
  shifts, 
  soldiers, 
  historyScores = {}, 
  existingAssignments = []
) {
  if (!shifts.length || !soldiers.length) return [];

  // 1. Calculate Criticality
  const demandBySkill = {};
  const activePosts = [...new Set(shifts.map(s => s.post))];

  for (const post of activePosts) {
    const l = post.shift_length_hours;
    const c = post.cooldown_hours;
    const sustainRatio = l === 0 ? 1 : (l + c) / l;

    // Simplified active hours calculation
    const [startH, startM] = post.start_time.split(':').map(Number);
    const [endH, endM] = post.end_time.split(':').map(Number);
    let activeHours = endH - startH + (endM - startM) / 60;
    if (activeHours <= 0) activeHours += 24;
    const activeRatio = activeHours / 24;

    const postDemand = sustainRatio * activeRatio;
    for (const slot of post.slots) {
      demandBySkill[slot.skill] = (demandBySkill[slot.skill] || 0) + postDemand;
    }
  }

  const supplyBySkill = {};
  for (const s of soldiers) {
    for (const sk of s.skills || []) {
      supplyBySkill[sk] = (supplyBySkill[sk] || 0) + 1;
    }
  }

  const criticality = {};
  for (const sk in demandBySkill) {
    const supply = supplyBySkill[sk] || 0;
    criticality[sk] = supply === 0 ? 9999 : demandBySkill[sk] / supply;
  }

  const getShiftRarity = (shift) => {
    if (!shift.post.slots.length) return 0;
    return Math.max(...shift.post.slots.map(s => criticality[s.skill] || 0));
  };

  // 2. Sort Shifts
  const sortedShifts = [...shifts].sort((a, b) => {
    const rarityA = getShiftRarity(a);
    const rarityB = getShiftRarity(b);
    if (rarityA !== rarityB) return rarityB - rarityA;
    
    const durA = a.post.shift_length_hours;
    const durB = b.post.shift_length_hours;
    if (durA !== durB) return durB - durA;

    return a.start.getTime() - b.start.getTime();
  });

  const draftAssignments = [];
  const results = [];

  for (const shift of sortedShifts) {
    const slots = [...shift.post.slots].sort((a, b) => a.role_index - b.role_index);
    for (const slot of slots) {
      const roleId = slot.role_index;
      let bestSoldier = null;
      let bestScore = -Infinity;

      for (const soldier of soldiers) {
        const { score, conflicts } = evaluateSoldierFitness(
          soldier,
          shift.start,
          shift.end,
          shift.post,
          roleId,
          historyScores,
          existingAssignments,
          draftAssignments
        );

        if (conflicts.some(c => ["occupied", "unavailable", "skill_mismatch"].includes(c))) {
          continue;
        }

        if (score > bestScore) {
          bestScore = score;
          bestSoldier = soldier;
        }
      }

      if (bestSoldier) {
        const result = {
          soldier_id: bestSoldier.id,
          soldier_name: bestSoldier.name,
          post_name: shift.post_name,
          start: shift.start,
          end: shift.end,
          role_id: roleId,
          intensity_weight: shift.post.intensity_weight
        };
        results.push(result);
        draftAssignments.push(result);
      }
    }
  }

  return results;
}

/**
 * Port of check_manpower
 */
export function checkManpower(startDate, endDate, soldiers, posts) {
  const start = startOfDay(typeof startDate === 'string' ? parseISO(startDate) : startDate);
  let end = startOfDay(typeof endDate === 'string' ? parseISO(endDate) : endDate);
  if (isEqual(start, end)) {
    end = addDays(start, 1);
  }

  const allSkills = [...new Set(soldiers.flatMap(s => s.skills || []))];
  const results = [];
  let currentDate = start;

  while (isBefore(currentDate, end)) {
    const dayStart = startOfDay(currentDate);
    const dayEnd = addDays(dayStart, 1);

    const dailyPosts = posts.filter(p => {
      if (p.active_from && isAfter(parseISO(p.active_from), dayEnd)) return false;
      if (p.active_until && isBefore(parseISO(p.active_until), dayStart)) return false;
      return p.is_active;
    });

    const requiredBySkill = {};
    for (const post of dailyPosts) {
      const l = post.shift_length_hours;
      const c = post.cooldown_hours;
      const ratio = l > 0 ? (l + c) / l : 1.0;

      const [startH, startM] = post.start_time.split(':').map(Number);
      const [endH, endM] = post.end_time.split(':').map(Number);
      let activeHours = endH - startH + (endM - startM) / 60;
      if (activeHours <= 0) activeHours += 24;
      const activeRatio = activeHours / 24;

      const sustenanceNeeded = ratio * activeRatio;
      for (const slot of post.slots) {
        requiredBySkill[slot.skill] = (requiredBySkill[slot.skill] || 0) + sustenanceNeeded;
      }
    }

    const totalPoolBySkill = {};
    for (const s of soldiers) {
      for (const sk of s.skills || []) {
        totalPoolBySkill[sk] = (totalPoolBySkill[sk] || 0) + 1;
      }
    }

    const events = new Set([dayStart.getTime(), dayEnd.getTime()]);
    for (const s of soldiers) {
      for (const u of s.unavailabilities || []) {
        const uStart = parseISO(u.start_datetime);
        const uEnd = parseISO(u.end_datetime);
        if (isBefore(uStart, dayEnd) && isAfter(uEnd, dayStart)) {
          events.add(Math.max(uStart.getTime(), dayStart.getTime()));
          events.add(Math.min(uEnd.getTime(), dayEnd.getTime()));
        }
      }
    }

    const sortedEvents = Array.from(events).sort((a, b) => a - b);
    const minAvailableBySkill = { ...totalPoolBySkill };

    for (let i = 0; i < sortedEvents.length - 1; i++) {
      const startInt = new Date(sortedEvents[i]);
      const endInt = new Date(sortedEvents[i + 1]);
      if (isEqual(startInt, endInt)) continue;

      const mid = new Date((startInt.getTime() + endInt.getTime()) / 2);
      const currentAvail = {};

      for (const s of soldiers) {
        let isUnavailable = false;
        for (const u of s.unavailabilities || []) {
          const uStart = parseISO(u.start_datetime);
          const uEnd = parseISO(u.end_datetime);
          if ((isBefore(uStart, mid) || isEqual(uStart, mid)) && isAfter(uEnd, mid)) {
            isUnavailable = true;
            break;
          }
        }
        if (!isUnavailable) {
          for (const sk of s.skills || []) {
            currentAvail[sk] = (currentAvail[sk] || 0) + 1;
          }
        }
      }

      for (const sk of allSkills) {
        minAvailableBySkill[sk] = Math.min(minAvailableBySkill[sk] || 0, currentAvail[sk] || 0);
      }
    }

    const dayReport = allSkills.map(sk => {
      const needed = requiredBySkill[sk] || 0;
      const available = minAvailableBySkill[sk] || 0;
      const total = totalPoolBySkill[sk] || 0;
      return {
        skill: sk,
        needed: Math.round(needed * 100) / 100,
        available: Math.floor(available),
        total_pool: total,
        status: available < needed ? "danger" : (available < needed * 1.5 ? "warning" : "success")
      };
    });

    results.push({
      date: format(currentDate, 'yyyy-MM-dd'),
      report: dayReport
    });

    currentDate = addDays(currentDate, 1);
  }

  return results;
}
