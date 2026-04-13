import React, { useState, useEffect, useMemo } from 'react';
import { getSoldiers, getPosts, getShiftsWithAssignments, draftSchedule, saveSchedule, getCandidates, getUnavailabilities } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Save, RefreshCw, ChevronLeft, ChevronRight, User, LayoutGrid, CheckCircle2, GripVertical, Wand2, X, PanelRightClose, PanelRight, AlertTriangle, ShieldAlert, Filter, Ban, CalendarX, Clock4 } from 'lucide-react';
import { addDays, addHours, format, startOfToday, startOfDay, parseISO, isBefore, differenceInMinutes } from 'date-fns';
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const ConflictTooltip = ({ icon: Icon, color, message, warnings }) => {
  const [open, setOpen] = useState(false);
  
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div 
          onMouseEnter={() => setOpen(true)} 
          onMouseLeave={() => setOpen(false)}
          className="inline-block cursor-help"
        >
          <Icon className={cn("w-3.5 h-3.5", color)} />
        </div>
      </PopoverTrigger>
      <PopoverContent 
        side="top" 
        align="center" 
        sideOffset={8}
        className="z-[100] w-max max-w-[250px] p-2.5 bg-slate-900/95 backdrop-blur-md border border-white/20 rounded-lg shadow-2xl text-[10px] text-white pointer-events-none border-none animate-in fade-in zoom-in duration-200"
      >
        {warnings ? (
          <>
            <p className="font-bold text-rose-400 mb-1.5 flex items-center gap-1.5 border-b border-white/10 pb-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              Constraint Violations
            </p>
            <div className="space-y-1">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="w-1 h-1 rounded-full bg-rose-500 mt-1.5 shrink-0" />
                  <span className="leading-tight opacity-90">{w.message}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-1.5 font-semibold">
            <Icon className={cn("w-3 h-3", color)} />
            {message}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

// ---------------------------------------------------------------------------
// Constraint validation engine
// ---------------------------------------------------------------------------

function validateAssignments(shifts, posts, soldiers) {
  const warnings = []; // { slotIndex, type, message }

  // Build lookups
  const soldierMap = {};
  for (const s of soldiers) {
    soldierMap[s.id] = s;
  }
  const postMap = {};
  for (const p of posts) {
    postMap[p.name] = p;
  }

  // Gather assigned slots grouped by soldier
  const bySoldier = {}; // soldier_id -> [{ idx, slot }]
  shifts.forEach((slot, idx) => {
    if (slot.soldier_id != null) {
      if (!bySoldier[slot.soldier_id]) bySoldier[slot.soldier_id] = [];
      bySoldier[slot.soldier_id].push({ idx, slot });
    }
  });

  shifts.forEach((slot, idx) => {
    if (slot.soldier_id == null) return;

    const soldier = soldierMap[slot.soldier_id];
    const post = postMap[slot.post_name];
    const requiredSkill = slot.skill;

    // 1. Skill mismatch
    if (soldier && requiredSkill) {
      const hasSkill = soldier.skills && soldier.skills.includes(requiredSkill);
      if (!hasSkill) {
        warnings.push({
          slotIndex: idx,
          type: 'skill',
          message: `${soldier.name} lacks required skill "${requiredSkill}"`,
        });
      }
    }

    // 2. Overlapping shifts & 3. Cooldown violation (check against same soldier's other shifts)
    if (soldier && bySoldier[slot.soldier_id]) {
      const slotStart = new Date(slot.start);
      const slotEnd = new Date(slot.end);
      const cooldownHours = post ? post.cooldown_hours : 0;

      for (const other of bySoldier[slot.soldier_id]) {
        if (other.idx === idx) continue;
        const otherStart = new Date(other.slot.start);
        const otherEnd = new Date(other.slot.end);
        const otherPost = postMap[other.slot.post_name];
        const otherCooldownHours = otherPost ? otherPost.cooldown_hours : 0;

        // Overlap check
        if (slotStart < otherEnd && otherStart < slotEnd) {
          // Only add once per pair (smaller index reports)
          if (idx < other.idx) {
            warnings.push({
              slotIndex: idx,
              type: 'overlap',
              message: `${soldier.name} is double-booked (overlaps with ${other.slot.post_name} ${format(otherStart, 'HH:mm')}-${format(otherEnd, 'HH:mm')})`,
            });
            warnings.push({
              slotIndex: other.idx,
              type: 'overlap',
              message: `${soldier.name} is double-booked (overlaps with ${slot.post_name} ${format(slotStart, 'HH:mm')}-${format(slotEnd, 'HH:mm')})`,
            });
          }
          continue; // Skip cooldown check if already overlapping
        }

        // Cooldown check: the gap between consecutive shifts must respect both posts' cooldowns
        const gap = (otherStart - slotEnd) / (1000 * 60 * 60); // hours
        const reverseGap = (slotStart - otherEnd) / (1000 * 60 * 60);

        if (gap > 0 && gap < cooldownHours && idx < other.idx) {
          warnings.push({
            slotIndex: idx,
            type: 'cooldown',
            message: `Only ${gap.toFixed(1)}h rest before ${other.slot.post_name} (needs ${cooldownHours}h cooldown)`,
          });
          warnings.push({
            slotIndex: other.idx,
            type: 'cooldown',
            message: `Only ${gap.toFixed(1)}h rest after ${slot.post_name} (needs ${cooldownHours}h cooldown)`,
          });
        }
        if (reverseGap > 0 && reverseGap < otherCooldownHours && idx < other.idx) {
          warnings.push({
            slotIndex: other.idx,
            type: 'cooldown',
            message: `Only ${reverseGap.toFixed(1)}h rest before ${slot.post_name} (needs ${otherCooldownHours}h cooldown)`,
          });
          warnings.push({
            slotIndex: idx,
            type: 'cooldown',
            message: `Only ${reverseGap.toFixed(1)}h rest after ${other.slot.post_name} (needs ${otherCooldownHours}h cooldown)`,
          });
        }
      }
    }
  });

  return warnings;
}

// Build a per-slot warning lookup: slotIndex -> warnings[]
function buildWarningMap(warnings) {
  const map = {};
  for (const w of warnings) {
    if (!map[w.slotIndex]) map[w.slotIndex] = [];
    map[w.slotIndex].push(w);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Scheduler() {
  const [soldiers, setSoldiers] = useState([]);
  const [posts, setPosts] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [unavailabilities, setUnavailabilities] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isDraft, setIsDraft] = useState(false);
  const [currentDate, setCurrentDate] = useState(startOfToday());
  const [viewMode, setViewMode] = useState('post');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dragOverSlotKey, setDragOverSlotKey] = useState(null);
  const [soldierFilter, setSoldierFilter] = useState('');
  const [skillFilter, setSkillFilter] = useState(''); // Filter by skill/role

  // Reassignment dialog (fallback)
  const [selectedShift, setSelectedShift] = useState(null);
  const [selectedShiftIndex, setSelectedShiftIndex] = useState(null);
  const [isReassignOpen, setIsReassignOpen] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);

  const fetchInitialData = async () => {
    try {
      const [sRes, pRes] = await Promise.all([getSoldiers(), getPosts()]);
      setSoldiers(sRes.data);
      setPosts(pRes.data);
    } catch (e) { console.error(e); }
  };

  const fetchDaySlots = async () => {
    setLoading(true);
    try {
      const { dayStart, dayEnd } = getDayBounds();
      const start = format(dayStart, "yyyy-MM-dd'T'HH:mm:ss");
      const endStr = format(dayEnd, "yyyy-MM-dd'T'HH:mm:ss");
      const [shiftsRes, unavailRes] = await Promise.all([
        getShiftsWithAssignments(start, endStr),
        getUnavailabilities(start, endStr)
      ]);
      setShifts(shiftsRes.data);
      setUnavailabilities(unavailRes.data);
      setIsDraft(false);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchInitialData(); }, []);
  useEffect(() => { fetchDaySlots(); }, [currentDate]);

  const getDayBounds = () => {
     const dayStart = startOfDay(currentDate);
     const dayStartAt6 = addHours(dayStart, 6);
     const dayEnd = addDays(dayStartAt6, 1);
     return { dayStart: dayStartAt6, dayEnd };
  };

  // --- Constraint validation ---
  const warnings = useMemo(() => validateAssignments(shifts, posts, soldiers), [shifts, posts, soldiers]);
  const warningMap = useMemo(() => buildWarningMap(warnings), [warnings]);

  // Fetch candidates when dialog opens
  useEffect(() => {
    if (isReassignOpen && selectedShift) {
      const fetchCandidates = async () => {
        setLoadingCandidates(true);
        try {
          // Collect all current assignments in UI state to consider for fitness (Draft mode)
          const draftAssignments = shifts
            .filter(sh => sh.soldier_id != null)
            .map(sh => ({
               soldier_id: sh.soldier_id,
               post_name: sh.post_name,
               start: sh.start,
               end: sh.end,
               role_id: sh.role_id
            }));

          const { data } = await getCandidates(
            selectedShift.post_name,
            selectedShift.start,
            selectedShift.end,
            selectedShift.role_id,
            draftAssignments
          );
          setCandidates(data);
        } catch (e) {
          console.error("Error fetching candidates:", e);
        } finally {
          setLoadingCandidates(false);
        }
      };
      fetchCandidates();
    } else {
      setCandidates([]);
    }
  }, [isReassignOpen, selectedShift]);

  // Unique skills across all slots for the filter dropdown
  const allSkills = useMemo(() => {
    const skills = new Set();
    shifts.forEach(s => { if (s.skill) skills.add(s.skill); });
    return Array.from(skills).sort();
  }, [shifts]);

  // --- Draft (auto-assign) ---
  const handleDraft = async () => {
    setLoading(true);
    try {
      const { dayStart, dayEnd } = getDayBounds();
      const start = format(dayStart, "yyyy-MM-dd'T'HH:mm:ss");
      const endStr = format(dayEnd, "yyyy-MM-dd'T'HH:mm:ss");

      const manualAssignments = shifts.filter(s => s.soldier_id != null);
      if (manualAssignments.length > 0) {
        const payload = manualAssignments.map(s => ({
          soldier_id: s.soldier_id,
          post_name: s.post_name,
          start: s.start,
          end: s.end,
          role_id: s.role_id
        }));
        await saveSchedule(start, endStr, payload);
      }

      const { data } = await draftSchedule(start, endStr);
      
      const solverLookup = {};
      for (const a of data) {
        const key = `${a.post_name}|${a.start}|${a.role_id}`;
        solverLookup[key] = a;
      }

      setShifts(prev => prev.map(slot => {
        const key = `${slot.post_name}|${slot.start}|${slot.role_id}`;
        const solved = solverLookup[key];
        if (solved) {
          return { ...slot, soldier_id: solved.soldier_id, soldier_name: solved.soldier_name };
        }
        return slot;
      }));
      setIsDraft(true);
    } catch (error) {
      console.error("Error drafting:", error);
    } finally { setLoading(false); }
  };

  // --- Save ---
  const handleSave = async () => {
    setLoading(true);
    try {
      const { dayStart, dayEnd } = getDayBounds();
      const start = format(dayStart, "yyyy-MM-dd'T'HH:mm:ss");
      const endStr = format(dayEnd, "yyyy-MM-dd'T'HH:mm:ss");
      
      const assigned = shifts.filter(s => s.soldier_id != null);
      const payload = assigned.map(s => ({
        soldier_id: s.soldier_id,
        post_name: s.post_name,
        start: s.start,
        end: s.end,
        role_id: s.role_id
      }));

      await saveSchedule(start, endStr, payload);
      setIsDraft(false);
    } catch (error) {
      console.error("Error saving:", error);
    } finally { setLoading(false); }
  };

  // --- Drag and Drop ---
  const handleDragStart = (e, soldier) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ soldier_id: soldier.id, soldier_name: soldier.name }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleDragOver = (e, slotKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOverSlotKey(slotKey);
  };

  const handleDragLeave = () => {
    setDragOverSlotKey(null);
  };

  const handleDrop = (e, slotIndex) => {
    e.preventDefault();
    setDragOverSlotKey(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      setShifts(prev => {
        const newShifts = [...prev];
        newShifts[slotIndex] = { ...newShifts[slotIndex], soldier_id: data.soldier_id, soldier_name: data.soldier_name };
        return newShifts;
      });
      setIsDraft(true);
    } catch (err) { console.error('Drop error:', err); }
  };

  const handleUnassign = (slotIndex) => {
    setShifts(prev => {
      const newShifts = [...prev];
      newShifts[slotIndex] = { ...newShifts[slotIndex], soldier_id: null, soldier_name: null };
      return newShifts;
    });
    setIsDraft(true);
  };

  // --- Click to reassign (dialog fallback) ---
  const handleShiftClick = (shift, idx) => {
    setSelectedShift(shift);
    setSelectedShiftIndex(idx);
    setIsReassignOpen(true);
  };

  const handleReassign = (soldier) => {
    if (selectedShiftIndex === null) return;
    setShifts(prev => {
      const newShifts = [...prev];
      newShifts[selectedShiftIndex] = { ...newShifts[selectedShiftIndex], soldier_id: soldier.id, soldier_name: soldier.name };
      return newShifts;
    });
    setIsDraft(true);
    setIsReassignOpen(false);
  };

  // --- Build resource rows ---
  const resources = useMemo(() => {
    if (viewMode === 'soldier') {
      return soldiers.map(s => {
        const soldierShifts = shifts
          .map((sh, i) => ({ ...sh, originalIndex: i }))
          .filter(sh => sh.soldier_id === s.id);
        
        const soldierUnavail = unavailabilities
          .filter(u => u.soldier_id === s.id)
          .map(u => ({
             ...u,
             type: 'unavailability',
             start: u.start_datetime,
             end: u.end_datetime,
             post_name: 'Unavailable',
             originalIndex: -1 // Not a shift slot
          }));

        return {
           id: s.id.toString(),
           name: s.name,
           shifts: [...soldierShifts, ...soldierUnavail]
        };
      });
    } else {
      const groupMap = new Map();
      shifts.forEach((slot, idx) => {
        const resId = `${slot.post_name}-role-${slot.role_id}`;
        if (!groupMap.has(resId)) {
          const postMeta = posts.find(p => p.name === slot.post_name);
          const slotMeta = postMeta?.slots?.find(s => s.role_index === slot.role_id);
          const skillLabel = slotMeta?.skill || slot.skill || '';
          groupMap.set(resId, {
            id: resId,
            name: `${slot.post_name}`,
            subtitle: `S${slot.role_id + 1} · ${skillLabel}`,
            skill: skillLabel,
            shifts: []
          });
        }
        groupMap.get(resId).shifts.push({ ...slot, originalIndex: idx });
      });
      return Array.from(groupMap.values());
    }
  }, [viewMode, soldiers, posts, shifts]);

  const hours = Array.from({ length: 24 }).map((_, i) => (i + 6) % 24);

  const calculateShiftStyle = (startStr, endStr) => {
     const { dayStart, dayEnd } = getDayBounds();
     let start = parseISO(startStr);
     let end = parseISO(endStr);

     if (isBefore(end, dayStart) || !isBefore(start, dayEnd)) return null;

     let clippedStart = false;
     let clippedEnd = false;

     if (isBefore(start, dayStart)) { start = dayStart; clippedStart = true; }
     if (!isBefore(end, dayEnd)) { end = dayEnd; clippedEnd = true; }

     const totalMinutes = differenceInMinutes(dayEnd, dayStart) || 1440;
     const offsetMinutes = differenceInMinutes(start, dayStart);
     const durationMinutes = differenceInMinutes(end, start);

     if (durationMinutes <= 0) return null;

     return {
         left: `${(offsetMinutes / totalMinutes) * 100}%`,
         width: `${(durationMinutes / totalMinutes) * 100}%`,
         clippedStart,
         clippedEnd
     };
  };

  // Filter soldiers in sidebar by name and optionally by skill
  const filteredSoldiers = useMemo(() => {
    let result = soldiers;
    if (soldierFilter) {
      const lower = soldierFilter.toLowerCase();
      result = result.filter(s => s.name.toLowerCase().includes(lower));
    }
    if (skillFilter) {
      result = result.filter(s => s.skills && s.skills.includes(skillFilter));
    }
    return result;
  }, [soldiers, soldierFilter, skillFilter]);

  // Stats
  const totalSlots = shifts.length;
  const filledSlots = shifts.filter(s => s.soldier_id != null).length;
  const emptySlots = totalSlots - filledSlots;
  const warningCount = new Set(warnings.map(w => w.slotIndex)).size;

  return (
    <div className="flex h-[calc(100vh-100px)] gap-0">
      {/* ===== Main Content ===== */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header Bar */}
        <div className="flex justify-between items-end shrink-0 pb-4 px-1">
          <div className="flex items-center gap-4">
            <h2 className="text-3xl font-black tracking-tight text-white flex items-center gap-4">
               Shift Scheduler {isDraft && <Badge variant="secondary" className="bg-amber-500/20 text-amber-300 border-amber-500/50 animate-pulse px-3 py-1 text-xs">UNSAVED DRAFT</Badge>}
               {!isDraft && filledSlots > 0 && <Badge variant="secondary" className="bg-emerald-500/20 text-emerald-300 border-emerald-500/50 gap-1 px-3 py-1 text-xs"><CheckCircle2 className="w-3 h-3"/> SAVED</Badge>}
            </h2>
            {totalSlots > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-emerald-400 font-semibold">{filledSlots} filled</span>
                <span className="text-slate-600">·</span>
                <span className="text-slate-400">{emptySlots} empty</span>
                <span className="text-slate-600">·</span>
                <span className="text-slate-500">{totalSlots} total</span>
                {warningCount > 0 && (
                  <>
                    <span className="text-slate-600">·</span>
                    <span className="text-amber-400 font-semibold flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> {warningCount} {warningCount === 1 ? 'issue' : 'issues'}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="flex gap-3">
            <div className="flex items-center gap-1 bg-card/60 backdrop-blur pb-0 p-1 rounded-lg border border-white/10 shadow-lg">
               <Button variant={viewMode === 'soldier' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('soldier')} className="gap-2 rounded-md">
                  <User className="w-4 h-4" /> Soldier
               </Button>
               <Button variant={viewMode === 'post' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('post')} className="gap-2 rounded-md">
                  <LayoutGrid className="w-4 h-4" /> Post
               </Button>
            </div>

            <div className="flex items-center gap-2 mr-2 bg-card/60 backdrop-blur p-1 rounded-lg border border-white/10 shadow-lg">
               <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-white/10" onClick={() => setCurrentDate(d => addDays(d, -1))}>
                  <ChevronLeft className="w-4 h-4" />
               </Button>
               <span className="text-sm font-semibold min-w-[110px] text-center tracking-wide">{format(currentDate, 'MMM dd, yyyy')}</span>
               <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-white/10" onClick={() => setCurrentDate(d => addDays(d, 1))}>
                  <ChevronRight className="w-4 h-4" />
               </Button>
            </div>
            
            <Button variant="outline" onClick={handleDraft} disabled={loading} className="gap-2 border-indigo-500/30 hover:border-indigo-500/80 hover:bg-indigo-500/10">
              <Wand2 className={cn("w-4 h-4 text-indigo-400", loading && "animate-spin")} /> 
              <span className="font-semibold">Auto Assign</span>
            </Button>
            
            {(isDraft || filledSlots > 0) && (
              <Button onClick={handleSave} disabled={loading} className="gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-lg shadow-emerald-900/50">
                <Save className="w-4 h-4" /> <span className="font-semibold">Save</span>
              </Button>
            )}

            {viewMode === 'post' && !sidebarOpen && (
              <Button variant="ghost" size="icon" className="h-9 w-9 hover:bg-white/10" onClick={() => setSidebarOpen(true)}>
                <PanelRight className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Warning Banner */}
        {warningCount > 0 && (
          <div className="mx-1 mb-3 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-amber-300 mb-1">Constraint Violations Detected</p>
              <div className="space-y-0.5 max-h-20 overflow-y-auto custom-scrollbar">
                {/* Deduplicate by message */}
                {[...new Map(warnings.map(w => [w.message, w])).values()].map((w, i) => (
                  <p key={i} className="text-[10px] text-amber-200/80 flex items-center gap-1.5">
                    <span className={cn(
                      "w-1.5 h-1.5 rounded-full shrink-0",
                      w.type === 'skill' ? "bg-rose-400" : w.type === 'overlap' ? "bg-red-500" : "bg-amber-400"
                    )} />
                    {w.message}
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Timeline Grid */}
        <div className="flex-1 overflow-auto rounded-xl border border-white/10 bg-card/40 backdrop-blur-xl shadow-2xl relative custom-scrollbar">
          {resources.length > 0 ? (
            <div className="min-w-[800px] w-full mt-1">
              {/* Header Timeline */}
              <div className="flex sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b border-white/10 uppercase tracking-widest">
                <div className="w-56 shrink-0 sticky left-0 z-40 bg-background/95 backdrop-blur-md border-r border-white/10 p-4 font-bold text-xs text-muted-foreground flex items-center shadow-[4px_0_12px_rgba(0,0,0,0.2)]">
                  {viewMode === 'soldier' ? 'Soldier Resource' : 'Post / Role'}
                </div>
                <div className="flex-1 flex relative">
                  {hours.map(h => (
                    <div key={h} className="flex-1 border-l border-white/5 h-10 flex items-center justify-center">
                      <span className="text-xs font-semibold text-white/50">
                         {String(h).padStart(2, '0')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Matrix Body */}
              <div className="relative">
                {/* Vertical hour lines */}
                <div className="absolute inset-x-0 top-0 bottom-0 pl-56 flex pointer-events-none">
                   {hours.map(h => (
                      <div key={h} className="flex-1 border-l border-white/5"></div>
                   ))}
                </div>

                {resources.map((res) => (
                  <div key={res.id} className="flex relative border-b border-white/5 hover:bg-white/[0.03] transition-colors group">
                    <div className="w-56 shrink-0 sticky left-0 z-20 bg-card/80 backdrop-blur-md border-r border-white/10 p-3 flex flex-col justify-center shadow-[4px_0_12px_rgba(0,0,0,0.1)] group-hover:bg-card/90 transition-colors">
                       <span className="font-medium text-sm text-slate-200 truncate">{res.name}</span>
                       {res.subtitle && <span className="text-[10px] text-slate-500 truncate mt-0.5">{res.subtitle}</span>}
                    </div>
                    
                    <div className="flex-1 relative h-16 my-1">
                       {res.shifts.map(shift => {
                          const styleInfo = calculateShiftStyle(shift.start, shift.end);
                          if (!styleInfo) return null;

                          const isEmpty = shift.soldier_id == null;
                          const slotKey = `${shift.post_name}|${shift.start}|${shift.role_id}`;
                          const slotWarnings = warningMap[shift.originalIndex];
                          const hasWarning = slotWarnings && slotWarnings.length > 0;

                          if (isEmpty && viewMode === 'post') {
                            return (
                              <div 
                                 key={`${res.id}-${shift.originalIndex}`}
                                 onDragOver={(e) => handleDragOver(e, slotKey)}
                                 onDragLeave={handleDragLeave}
                                 onDrop={(e) => handleDrop(e, shift.originalIndex)}
                                 onClick={() => handleShiftClick(shift, shift.originalIndex)}
                                 style={{ left: styleInfo.left, width: styleInfo.width }}
                                 className={cn(
                                   "absolute top-1 bottom-1 rounded-lg text-xs leading-tight transition-all duration-200 cursor-pointer overflow-hidden",
                                   "border-2 border-dashed border-white/15 bg-white/[0.02] hover:border-indigo-500/40 hover:bg-indigo-500/5",
                                   dragOverSlotKey === slotKey && "border-indigo-400/70 bg-indigo-500/15 scale-[1.02] shadow-lg shadow-indigo-900/30",
                                   styleInfo.clippedStart && "rounded-l-none border-l-0",
                                   styleInfo.clippedEnd && "rounded-r-none border-r-0"
                                 )}
                              >
                                 <div className="flex items-center justify-center h-full opacity-40">
                                   <User className="w-3 h-3 mr-1" />
                                   <span className="text-[10px] font-medium">Unassigned</span>
                                 </div>
                              </div>
                            );
                          }

                          if (isEmpty && viewMode === 'soldier') return null;

                          // Filled slot
                          const isUnavail = shift.type === 'unavailability';
                          return (
                            <div 
                               key={`${res.id}-${shift.originalIndex}-${shift.id || shift.originalIndex}`}
                               onClick={() => !isUnavail && handleShiftClick(shift, shift.originalIndex)}
                               style={{ left: styleInfo.left, width: styleInfo.width }}
                               className={cn(
                                 "absolute top-1 bottom-1 p-2 rounded-lg text-xs leading-tight transition-all duration-300 overflow-hidden backdrop-blur shadow-lg group/shift",
                                 isUnavail
                                   ? "bg-slate-800/60 border border-slate-700 text-slate-400 cursor-not-allowed"
                                   : hasWarning
                                     ? "bg-red-500/20 border border-red-500/60 hover:bg-red-500/30 text-red-100 shadow-red-900/30 ring-1 ring-red-500/30 cursor-pointer hover:scale-[1.02] hover:z-10"
                                     : isDraft
                                       ? "bg-amber-500/20 border border-amber-500/50 hover:bg-amber-500/30 text-amber-200 shadow-amber-900/20 cursor-pointer hover:scale-[1.02] hover:z-10"
                                       : "bg-indigo-500/20 border border-indigo-500/50 hover:bg-indigo-500/30 text-indigo-100 shadow-indigo-900/20 cursor-pointer hover:scale-[1.02] hover:z-10",
                                 styleInfo.clippedStart && "rounded-l-none border-l-0",
                                 styleInfo.clippedEnd && "rounded-r-none border-r-0"
                               )}
                            >
                               <div className="font-bold truncate opacity-90 drop-shadow-sm flex items-center gap-1">
                                 {isUnavail ? <Ban className="w-3 h-3 text-slate-500" /> : hasWarning && (
                                   <ConflictTooltip icon={AlertTriangle} color="text-red-400" warnings={slotWarnings} />
                                 )}
                                 {viewMode === 'soldier' ? shift.post_name : shift.soldier_name}
                               </div>
                               <div className="text-[10px] opacity-70 truncate mt-0.5">
                                 {format(parseISO(shift.start), 'HH:mm')} - {format(parseISO(shift.end), 'HH:mm')}
                                 {isUnavail && shift.reason && ` · ${shift.reason}`}
                               </div>

                               {/* Unassign button (post view only) */}
                               {viewMode === 'post' && !isUnavail && (
                                 <button
                                   onClick={(e) => { e.stopPropagation(); handleUnassign(shift.originalIndex); }}
                                   className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-red-500/0 hover:bg-red-500/60 flex items-center justify-center opacity-0 group-hover/shift:opacity-100 transition-opacity"
                                 >
                                   <X className="w-2.5 h-2.5" />
                                 </button>
                               )}

                               {styleInfo.clippedStart && <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-r from-red-500/50 to-transparent" />}
                               {styleInfo.clippedEnd && <div className="absolute right-0 top-0 bottom-0 w-1 bg-gradient-to-l from-red-500/50 to-transparent" />}
                            </div>
                          )
                       })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground w-full py-24">
              {loading ? (
                <RefreshCw className="w-10 h-10 animate-spin opacity-50 mb-4" />
              ) : (
                <LayoutGrid className="w-10 h-10 opacity-20 mb-4" />
              )}
              <p className="font-medium tracking-wide">{loading ? "Synchronizing Time Matrix..." : "No shift slots generated for this day."}</p>
              <p className="text-xs text-slate-500 mt-2">Make sure you have active posts configured.</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== Soldier Sidebar — RIGHT SIDE (Post view only) ===== */}
      {viewMode === 'post' && sidebarOpen && (
        <div className="w-56 shrink-0 flex flex-col border-l border-white/10 bg-card/60 backdrop-blur-xl">
          <div className="p-3 border-b border-white/10 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Personnel</span>
            <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-white/10" onClick={() => setSidebarOpen(false)}>
              <PanelRightClose className="w-3.5 h-3.5" />
            </Button>
          </div>
          {/* Search + Skill filter */}
          <div className="p-2 space-y-1.5 border-b border-white/5">
            <input
              type="text"
              placeholder="Search by name..."
              value={soldierFilter}
              onChange={e => setSoldierFilter(e.target.value)}
              className="w-full text-xs bg-white/5 border border-white/10 rounded-md px-2.5 py-1.5 text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
            />
            <div className="relative">
              <Filter className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />
              <select
                value={skillFilter}
                onChange={e => setSkillFilter(e.target.value)}
                className="w-full text-xs bg-white/5 border border-white/10 rounded-md pl-6 pr-2 py-1.5 text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 appearance-none cursor-pointer"
              >
                <option value="">All roles</option>
                {allSkills.map(sk => (
                  <option key={sk} value={sk}>{sk}</option>
                ))}
              </select>
            </div>
          </div>
          {/* Soldier list */}
          <div className="flex-1 overflow-y-auto custom-scrollbar p-1.5 space-y-0.5">
            {filteredSoldiers.map(s => (
              <div
                key={s.id}
                draggable
                onDragStart={(e) => handleDragStart(e, s)}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-grab active:cursor-grabbing bg-white/[0.02] hover:bg-indigo-500/10 border border-transparent hover:border-indigo-500/30 transition-all duration-200 group select-none"
              >
                <GripVertical className="w-3 h-3 text-white/20 group-hover:text-indigo-400 transition-colors shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-slate-200 truncate block">{s.name}</span>
                  {s.skills && s.skills.length > 0 && (
                    <span className="text-[10px] text-slate-500 truncate block">{s.skills.join(', ')}</span>
                  )}
                </div>
              </div>
            ))}
            {filteredSoldiers.length === 0 && (
              <div className="text-center py-6 text-slate-500 text-xs">No matching soldiers</div>
            )}
          </div>
          <div className="p-2 border-t border-white/10 text-center">
             <span className="text-[10px] text-slate-500">{filteredSoldiers.length} soldiers</span>
          </div>
        </div>
      )}

      {/* Reassignment Dialog (fallback) */}
      <Dialog open={isReassignOpen} onOpenChange={setIsReassignOpen}>
        <DialogContent className="border-white/10 bg-card/95 backdrop-blur-xl text-white shadow-2xl">
          <DialogHeader><DialogTitle className="text-xl font-bold tracking-tight">Assign Resource</DialogTitle></DialogHeader>
          <div className="py-4">
             <div className="mb-6 p-4 rounded-lg bg-white/5 border border-white/10">
               <p className="text-sm text-slate-300 font-medium leading-relaxed">
                 {selectedShift?.soldier_name ? 'Reassigning' : 'Assigning'} shift for <span className="text-indigo-400 font-bold">{selectedShift?.post_name}</span>
                 {selectedShift?.skill && <span className="text-slate-500"> · requires {selectedShift.skill}</span>}
                 {selectedShift?.soldier_name && <> — Current: <span className="text-rose-400 font-bold">{selectedShift?.soldier_name}</span></>}
               </p>
               <p className="text-xs text-slate-500 mt-2 flex items-center gap-1">
                  Time: {selectedShift && format(parseISO(selectedShift.start), 'HH:mm')} to {selectedShift && format(parseISO(selectedShift.end), 'HH:mm')}
               </p>
             </div>
             {selectedShift?.soldier_name && (
               <Button 
                 variant="outline" 
                 size="sm" 
                 className="w-full mb-4 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/50"
                 onClick={() => { handleUnassign(selectedShiftIndex); setIsReassignOpen(false); }}
               >
                 <X className="w-3.5 h-3.5 mr-2" /> Unassign {selectedShift?.soldier_name}
               </Button>
             )}
             <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">Recommended Personnel</p>
             <div className="grid grid-cols-1 gap-2 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
                {loadingCandidates ? (
                  <div className="flex flex-col items-center justify-center py-12 text-slate-500">
                    <RefreshCw className="w-8 h-8 animate-spin mb-3 opacity-20" />
                    <span className="text-xs font-medium">Analyzing personnel fitness...</span>
                  </div>
                ) : candidates.length > 0 ? (
                  candidates.map(c => {
                    const hasConflict = c.conflicts.length > 0;
                    const isOccupied = c.conflicts.includes('occupied');
                    const isUnavailable = c.conflicts.includes('unavailable');
                    const isCooldown = c.conflicts.includes('cooldown');
                    const isSkillMismatch = c.conflicts.includes('skill_mismatch');

                    return (
                      <Button 
                        key={c.id} 
                        variant="outline" 
                        size="lg" 
                        className={cn(
                          "h-auto py-3 px-4 justify-start items-start gap-4 transition-all duration-200 bg-white/[0.02] border-white/10 group relative",
                          hasConflict 
                            ? "hover:bg-red-500/10 hover:border-red-500/30" 
                            : "hover:bg-indigo-500/10 hover:border-indigo-500/40"
                        )} 
                        onClick={() => handleReassign(c)}
                      >
                        <div className="mt-1">
                          <User className={cn("w-5 h-5", hasConflict ? "text-slate-500" : "text-indigo-400")} />
                        </div>
                        
                        <div className="flex-1 text-left min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="font-bold text-sm text-slate-200">{c.name}</span>
                            <div className="flex gap-1.5">
                              {isOccupied && <ConflictTooltip icon={Ban} color="text-rose-500" message="Occupied (Overlapping Shift)" />}
                              {isUnavailable && <ConflictTooltip icon={CalendarX} color="text-amber-500" message="Unavailable (Leave/Absence)" />}
                              {isCooldown && <ConflictTooltip icon={Clock4} color="text-indigo-400" message="Cooldown Violation" />}
                              {isSkillMismatch && <ConflictTooltip icon={AlertTriangle} color="text-rose-400" message="Missing Required Skill" />}
                            </div>
                          </div>
                          
                          {c.last_shift ? (
                            <p className="text-[10px] text-slate-500 leading-tight">
                              Last: <span className="text-slate-400 font-medium">{c.last_shift.post_name}</span> ends {format(parseISO(c.last_shift.end), 'MMM dd, HH:mm')}
                            </p>
                          ) : (
                            <p className="text-[10px] text-slate-600 italic">No recent shifts recorded</p>
                          )}
                        </div>

                        <div className="flex flex-col items-end shrink-0 gap-1">
                           <Badge variant="outline" className={cn(
                             "text-[9px] px-1.5 py-0 border-none",
                             hasConflict ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"
                           )}>
                             {hasConflict ? 'CONFLICT' : 'READY'}
                           </Badge>
                           <span className="text-[10px] text-slate-600 font-mono tracking-tighter">FIT: {Math.max(0, Math.floor(c.fitness_score))}</span>
                        </div>
                      </Button>
                    );
                  })
                ) : (
                  <div className="text-center py-6 text-slate-500 text-xs italic">No personnel found</div>
                )}
             </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
