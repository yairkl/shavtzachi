import React, { useState, useEffect, useMemo } from 'react';
import { getSoldiers, getPosts, getSchedule, draftSchedule, saveSchedule } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Save, RefreshCw, ChevronLeft, ChevronRight, User, LayoutGrid, CheckCircle2 } from 'lucide-react';
import { addDays, addHours, format, startOfToday, startOfDay, parseISO, isBefore, differenceInMinutes } from 'date-fns';
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function Scheduler() {
  const [soldiers, setSoldiers] = useState([]);
  const [posts, setPosts] = useState([]);
  const [shifts, setShifts] = useState([]); 
  const [loading, setLoading] = useState(false);
  const [isDraft, setIsDraft] = useState(false);
  const [currentDate, setCurrentDate] = useState(startOfToday());
  const [viewMode, setViewMode] = useState('soldier'); 
  
  const [selectedShift, setSelectedShift] = useState(null);
  const [selectedShiftIndex, setSelectedShiftIndex] = useState(null);
  const [isReassignOpen, setIsReassignOpen] = useState(false);

  const fetchInitialData = async () => {
    try {
      const [sRes, pRes] = await Promise.all([getSoldiers(), getPosts()]);
      setSoldiers(sRes.data);
      setPosts(pRes.data);
    } catch (e) { console.error(e); }
  };

  const fetchDaySchedule = async () => {
    setLoading(true);
    try {
      const { dayStart, dayEnd } = getDayBounds();
      const start = format(dayStart, "yyyy-MM-dd'T'HH:mm:ss");
      const endStr = format(dayEnd, "yyyy-MM-dd'T'HH:mm:ss");
      
      const { data } = await getSchedule(start, endStr);
      setShifts(data);
      setIsDraft(false);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchInitialData(); }, []);
  useEffect(() => { fetchDaySchedule(); }, [currentDate]);

  const getDayBounds = () => {
     const dayStart = startOfDay(currentDate);
     const dayStartAt6 = addHours(dayStart, 6);
     const dayEnd = addDays(dayStartAt6, 1);
     return { dayStart: dayStartAt6, dayEnd };
  };

  const handleDraft = async () => {
    setLoading(true);
    try {
      const start = format(currentDate, "yyyy-MM-dd'T'HH:mm:ss");
      const { dayEnd } = getDayBounds();
      const endStr = format(dayEnd, "yyyy-MM-dd'T'HH:mm:ss");
      const { data } = await draftSchedule(start, endStr);
      setShifts(data);
      setIsDraft(true);
    } catch (error) {
      console.error("Error drafting:", error);
    } finally { setLoading(false); }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      const start = format(currentDate, "yyyy-MM-dd'T'HH:mm:ss");
      const { dayEnd } = getDayBounds();
      const endStr = format(dayEnd, "yyyy-MM-dd'T'HH:mm:ss");
      
      const payload = shifts.map(s => ({
        soldier_id: s.soldier_id,
        post_name: s.post_name,
        start: s.start,
        end: s.end,
        role_id: s.role_id
      }));

      await saveSchedule(start, endStr, payload);
      setIsDraft(false);
      alert("Schedule saved successfully!");
    } catch (error) {
      console.error("Error saving:", error);
      alert("Error saving schedule.");
    } finally { setLoading(false); }
  };

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
    setIsDraft(true); // Mark as modified
    setIsReassignOpen(false);
  };

  // Convert resources to rows
  const resources = useMemo(() => {
    if (viewMode === 'soldier') {
      return soldiers.map(s => ({
         id: s.id.toString(),
         name: s.name,
         shifts: shifts.filter(sh => sh.soldier_id === s.id).map((sh) => ({ ...sh, originalIndex: shifts.indexOf(sh) }))
      }));
    } else {
      let list = [];
      posts.forEach(p => {
        p.slots.forEach(s => {
          const resId = `${p.name}-slot-${s.role_index}`;
          list.push({ 
            id: resId, 
            name: `${p.name} (S${s.role_index + 1})`,
            shifts: shifts.filter(sh => sh.post_name === p.name && sh.role_id === s.role_index).map((sh) => ({ ...sh, originalIndex: shifts.indexOf(sh) }))
          });
        });
      });
      return list;
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

     // Handle 0 duration safely
     if (durationMinutes <= 0) return null;

     return {
         left: `${(offsetMinutes / totalMinutes) * 100}%`,
         width: `${(durationMinutes / totalMinutes) * 100}%`,
         clippedStart,
         clippedEnd
     };
  };

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-100px)]">
      <div className="flex justify-between items-end shrink-0">
        <div>
          <h2 className="text-3xl font-black tracking-tight text-white flex items-center gap-4">
             Shift Scheduler {isDraft && <Badge variant="secondary" className="bg-amber-500/20 text-amber-300 border-amber-500/50 animate-pulse px-3 py-1 text-xs">UNSAVED DRAFT</Badge>}
             {!isDraft && shifts.length > 0 && <Badge variant="secondary" className="bg-emerald-500/20 text-emerald-300 border-emerald-500/50 gap-1 px-3 py-1 text-xs"><CheckCircle2 className="w-3 h-3"/> SAVED</Badge>}
          </h2>
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
            <RefreshCw className={cn("w-4 h-4 text-indigo-400", loading && "animate-spin")} /> 
            <span className="font-semibold">{shifts.length > 0 ? 'Retry Draft' : 'Generate Draft'}</span>
          </Button>
          
          {(isDraft || shifts.length > 0) && (
            <Button onClick={handleSave} disabled={loading} className="gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-lg shadow-emerald-900/50">
              <Save className="w-4 h-4" /> <span className="font-semibold">Save</span>
            </Button>
          )}
        </div>
      </div>

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
              {/* Infinite vertical hour lines behind everything */}
              <div className="absolute inset-x-0 top-0 bottom-0 pl-56 flex pointer-events-none">
                 {hours.map(h => (
                    <div key={h} className="flex-1 border-l border-white/5"></div>
                 ))}
              </div>

              {resources.map((res) => (
                <div key={res.id} className="flex relative border-b border-white/5 hover:bg-white/[0.03] transition-colors group">
                  <div className="w-56 shrink-0 sticky left-0 z-20 bg-card/80 backdrop-blur-md border-r border-white/10 p-4 flex items-center shadow-[4px_0_12px_rgba(0,0,0,0.1)] group-hover:bg-card/90 transition-colors">
                     <span className="font-medium text-sm text-slate-200 truncate">{res.name}</span>
                  </div>
                  
                  <div className="flex-1 relative h-16 my-1">
                     {res.shifts.map(shift => {
                        const styleInfo = calculateShiftStyle(shift.start, shift.end);
                        if (!styleInfo) return null;

                        return (
                          <div 
                             key={`${res.id}-${shift.originalIndex}`}
                             onClick={() => handleShiftClick(shift, shift.originalIndex)}
                             style={{ left: styleInfo.left, width: styleInfo.width }}
                             className={cn(
                               "absolute top-1 bottom-1 p-2 rounded-lg text-xs leading-tight transition-all duration-300 cursor-pointer overflow-hidden backdrop-blur hover:scale-[1.02] hover:z-10 shadow-lg",
                               isDraft ? "bg-amber-500/20 border border-amber-500/50 hover:bg-amber-500/30 text-amber-200 shadow-amber-900/20" : "bg-indigo-500/20 border border-indigo-500/50 hover:bg-indigo-500/30 text-indigo-100 shadow-indigo-900/20",
                               styleInfo.clippedStart && "rounded-l-none border-l-0",
                               styleInfo.clippedEnd && "rounded-r-none border-r-0"
                             )}
                          >
                             <div className="font-bold truncate opacity-90 drop-shadow-sm">
                               {viewMode === 'soldier' ? shift.post_name : shift.soldier_name}
                             </div>
                             <div className="text-[10px] opacity-70 truncate mt-0.5">
                               {format(parseISO(shift.start), 'HH:mm')} - {format(parseISO(shift.end), 'HH:mm')}
                             </div>

                             {/* Visual indicator for clipping */}
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
            <p className="font-medium tracking-wide">{loading ? "Synchronizing Time Matrix..." : "No shifts generated for this day."}</p>
          </div>
        )}
      </div>

      <Dialog open={isReassignOpen} onOpenChange={setIsReassignOpen}>
        <DialogContent className="border-white/10 bg-card/95 backdrop-blur-xl text-white shadow-2xl">
          <DialogHeader><DialogTitle className="text-xl font-bold tracking-tight">Reassign Resource</DialogTitle></DialogHeader>
          <div className="py-4">
             <div className="mb-6 p-4 rounded-lg bg-white/5 border border-white/10">
               <p className="text-sm text-slate-300 font-medium leading-relaxed">
                 Updating shift for <span className="text-indigo-400 font-bold">{selectedShift?.post_name}</span>. <br/>
                 Current Assignment: <span className="text-rose-400 font-bold">{selectedShift?.soldier_name}</span>
               </p>
               <p className="text-xs text-slate-500 mt-2 flex items-center gap-1">
                  Time: {selectedShift && format(parseISO(selectedShift.start), 'HH:mm')} to {selectedShift && format(parseISO(selectedShift.end), 'HH:mm')}
               </p>
             </div>
             <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">Available Replacements</p>
             <div className="grid grid-cols-2 gap-2 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
                {soldiers.map(s => (
                    <Button key={s.id} variant="outline" size="sm" className="justify-start gap-2 border-white/10 hover:bg-indigo-500/20 hover:border-indigo-500/50 transition-colors bg-white/[0.02]" onClick={() => handleReassign(s)}>
                        <User className="w-3.5 h-3.5 opacity-70" /> 
                        <span className="truncate">{s.name}</span>
                    </Button>
                ))}
             </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
