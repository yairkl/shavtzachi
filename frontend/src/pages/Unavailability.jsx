import React, { useEffect, useState, useMemo, useRef } from 'react';
import { 
  getUnavailabilities, 
  createUnavailability, 
  updateUnavailability,
  deleteUnavailability, 
  getSoldiers, 
  checkManpower,
  getSkills
} from '@/services/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Plus, 
  Trash2, 
  CalendarX, 
  Clock, 
  User, 
  AlertTriangle, 
  CheckCircle2, 
  Info,
  ChevronRight,
  ShieldCheck,
  Search,
  Filter,
  ArrowUpDown,
  List,
  GanttChartSquare,
  ChevronLeft,
  LayoutDashboard,
  BarChart3,
  CalendarDays,
  Plane,
  Stethoscope,
  MoreHorizontal,
  Home,
  Calendar as CalendarIcon
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { format, parseISO, isAfter, isBefore, startOfToday, addDays, differenceInMinutes, startOfDay, endOfDay, addMinutes } from 'date-fns';
import { DateTimeRangePicker } from '@/components/DateTimeRangePicker';

export default function Unavailability() {
  const [records, setRecords] = useState([]);
  const [soldiers, setSoldiers] = useState([]);
  const [availableSkills, setAvailableSkills] = useState([]);
  const [manpowerReport, setManpowerReport] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Tabs & View State
  const [activeTab, setActiveTab] = useState('registry');
  const [viewMode, setViewMode] = useState('timeline');
  
  // Filtering & Sorting
  const [searchTerm, setSearchTerm] = useState('');
  const [skillFilter, setSkillFilter] = useState('all');
  const [sortBy, setSortBy] = useState('name');
  const [timelineStart, setTimelineStart] = useState(startOfToday());
  
  // Dialog State
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [reasonType, setReasonType] = useState('regular'); 
  
  // Split State for Date/Time
  const [sd, setSd] = useState(format(new Date(), "yyyy-MM-dd"));
  const [st, setSt] = useState(format(new Date(), "HH:00"));
  const [ed, setEd] = useState(format(addDays(new Date(), 1), "yyyy-MM-dd"));
  const [et, setEt] = useState(format(new Date(), "HH:00"));
  
  const [formData, setFormData] = useState({
    soldier_id: "",
    reason: ""
  });

  const fetchData = async () => {
    setLoading(true);
    try {
      const [{ data: rData }, { data: sData }, { data: skData }] = await Promise.all([
        getUnavailabilities(),
        getSoldiers(),
        getSkills()
      ]);
      setRecords(rData);
      setSoldiers(sData);
      setAvailableSkills(skData);
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  const getStartISO = () => `${sd}T${st}`;
  const getEndISO = () => `${ed}T${et}`;

  const fetchManpowerCheck = async () => {
    try {
      const { data } = await checkManpower(getStartISO(), getEndISO());
      setManpowerReport(data);
    } catch (e) {
      console.error("Manpower check failed", e);
    }
  };

  useEffect(() => { fetchData(); }, []);
  
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchManpowerCheck();
    }, 500);
    return () => clearTimeout(timer);
  }, [sd, st, ed, et]);

  const [dateRange, setDateRange] = useState({
    from: new Date(),
    to: addDays(new Date(), 1)
  });

  useEffect(() => {
    if (activeTab === 'sustainability') {
      setSd(format(timelineStart, "yyyy-MM-dd"));
      setEd(format(addDays(timelineStart, 13), "yyyy-MM-dd"));
    } else if (dateRange?.from) {
      setSd(format(dateRange.from, "yyyy-MM-dd"));
      if (dateRange.to) setEd(format(dateRange.to, "yyyy-MM-dd"));
    }
  }, [dateRange, timelineStart, activeTab]);

  const handleOpenCreate = (initialData = {}) => {
    setEditingRecord(null);
    setReasonType('regular');
    setFormData({
      soldier_id: initialData.soldier_id?.toString() || "",
      reason: ""
    });
    const start = initialData.start_datetime ? parseISO(initialData.start_datetime) : new Date();
    const end = initialData.end_datetime ? parseISO(initialData.end_datetime) : addDays(start, 1);
    setSd(format(start, "yyyy-MM-dd"));
    setSt(format(start, "HH:00"));
    setEd(format(end, "yyyy-MM-dd"));
    setEt(format(end, "HH:00"));
    setDateRange({ from: start, to: end });
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (record) => {
    setEditingRecord(record);
    const r = record.reason || "";
    if (r.toLowerCase() === 'regular') setReasonType('regular');
    else if (r.toLowerCase() === 'vacation') setReasonType('vacation');
    else if (r.toLowerCase() === 'sickness') setReasonType('sickness');
    else setReasonType('other');

    const start = parseISO(record.start_datetime);
    const end = parseISO(record.end_datetime);
    setSd(format(start, "yyyy-MM-dd"));
    setSt(format(start, "HH:00"));
    setEd(format(end, "yyyy-MM-dd"));
    setEt(format(end, "HH:00"));
    setDateRange({ from: start, to: end });

    setFormData({
      soldier_id: record.soldier_id.toString(),
      reason: r
    });
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      if (!formData.soldier_id) return alert("Select a soldier");
      const finalReason = reasonType === 'regular' ? 'Regular' :
                         reasonType === 'vacation' ? 'Vacation' : 
                         reasonType === 'sickness' ? 'Sickness' : formData.reason;
      const payload = {
        ...formData,
        start_datetime: getStartISO(),
        end_datetime: getEndISO(),
        reason: finalReason,
        soldier_id: parseInt(formData.soldier_id)
      };
      if (editingRecord) await updateUnavailability(editingRecord.id, payload);
      else await createUnavailability(payload);
      setIsDialogOpen(false);
      fetchData();
    } catch (e) {
      alert(e.response?.data?.detail || "Operation failed");
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Remove this unavailability record?")) return;
    try {
      await deleteUnavailability(id);
      setIsDialogOpen(false);
      fetchData();
    } catch (e) { console.error(e); }
  };

  const handleTimelineClick = (soldierId, e) => {
    if (e.target.closest('.gantt-bar')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const totalWidth = rect.width;
    const totalMinutes = 14 * 24 * 60;
    const clickMinutes = (x / totalWidth) * totalMinutes;
    const snappedMinutes = Math.round(clickMinutes / 60) * 60;
    const clickedDate = addMinutes(startOfDay(timelineStart), snappedMinutes);
    handleOpenCreate({ soldier_id: soldierId, start_datetime: format(clickedDate, "yyyy-MM-dd'T'HH:mm"), end_datetime: format(addDays(clickedDate, 1), "yyyy-MM-dd'T'HH:mm") });
  };

  const filteredSoldiers = useMemo(() => {
    let result = [...soldiers];
    if (skillFilter !== 'all') result = result.filter(s => s.skills.includes(skillFilter));
    if (searchTerm) result = result.filter(s => s.name.toLowerCase().includes(searchTerm.toLowerCase()));
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }, [soldiers, searchTerm, skillFilter]);

  const timelineDays = useMemo(() => Array.from({ length: 14 }).map((_, i) => addDays(timelineStart, i)), [timelineStart]);

  const allSkills = useMemo(() => {
    if (!Array.isArray(manpowerReport)) return [];
    const skills = new Set();
    manpowerReport.forEach(day => {
      day.report.forEach(m => skills.add(m.skill));
    });
    return Array.from(skills).sort();
  }, [manpowerReport]);

  const calculateGanttStyle = (startStr, endStr) => {
    const windowStart = startOfDay(timelineStart);
    const windowEnd = endOfDay(addDays(timelineStart, 13));
    let start = parseISO(startStr);
    let end = parseISO(endStr);
    if (isAfter(start, windowEnd) || isBefore(end, windowStart)) return null;
    const actualStart = isBefore(start, windowStart) ? windowStart : start;
    const actualEnd = isAfter(end, windowEnd) ? windowEnd : end;
    const totalMinutes = 14 * 24 * 60;
    const offsetMinutes = differenceInMinutes(actualStart, windowStart);
    const durationMinutes = differenceInMinutes(actualEnd, actualStart);
    return { left: `${(offsetMinutes / totalMinutes) * 100}%`, width: `${(durationMinutes / totalMinutes) * 100}%`, clippedStart: isBefore(start, windowStart), clippedEnd: isAfter(end, windowEnd) };
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-700 h-[calc(100vh-120px)] flex flex-col">
      <div className="flex justify-between items-center shrink-0">
        <div>
          <h2 className="text-4xl font-extrabold tracking-tight text-white flex items-center gap-3"><CalendarDays className="w-10 h-10 text-primary" />Attendance & Readiness</h2>
          <p className="text-muted-foreground text-sm mt-1">Manage personnel availability and sustainability metrics.</p>
        </div>
        <div className="flex gap-4">
          <div className="flex items-center gap-1 bg-card/60 backdrop-blur pb-0 p-1 rounded-xl border border-white/10 shadow-lg">
             <Button variant={activeTab === 'registry' ? 'secondary' : 'ghost'} size="sm" onClick={() => setActiveTab('registry')} className="gap-2 rounded-lg py-5 px-4 font-bold"><LayoutDashboard className="w-4 h-4" /> Personnel Registry</Button>
             <Button variant={activeTab === 'sustainability' ? 'secondary' : 'ghost'} size="sm" onClick={() => setActiveTab('sustainability')} className="gap-2 rounded-lg py-5 px-4 font-bold"><BarChart3 className="w-4 h-4" /> Sustainability</Button>
          </div>
          <Button size="lg" className="gap-2 shadow-lg shadow-primary/20 bg-primary hover:bg-primary/90" onClick={() => handleOpenCreate()}><Plus className="w-5 h-5 font-black" /> Authorize Absence</Button>
        </div>
      </div>

      {activeTab === 'registry' ? (
        <>
          <Card className="glass border-none shadow-xl bg-card/20 p-3 shrink-0">
            <div className="flex flex-wrap gap-4 items-center">
              <div className="relative flex-1 min-w-[200px]"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" /><Input placeholder="Identify Personnel..." className="pl-10 bg-background/50 border-white/5 h-9 text-xs" value={searchTerm} onChange={e => setSearchTerm(e.target.value)}/></div>
              <div className="flex items-center gap-2"><Select value={skillFilter} onValueChange={setSkillFilter}><SelectTrigger className="w-[160px] bg-background/30 border-white/5 text-[10px] h-9 font-bold"><SelectValue placeholder="Skillsets" /></SelectTrigger><SelectContent className="bg-zinc-900 border-white/10 text-white max-h-72 overflow-y-auto"><SelectItem value="all">Every Qualification</SelectItem>{availableSkills.map(s => (<SelectItem key={s} value={s}>{s}</SelectItem>))}</SelectContent></Select></div>
              <div className="flex items-center gap-2 bg-background/20 rounded-lg p-0.5 border border-white/5"><Button variant={viewMode === 'table' ? 'secondary' : 'ghost'} size="icon" onClick={() => setViewMode('table')} className="h-8 w-8 rounded-md"><List className="w-4 h-4" /></Button><Button variant={viewMode === 'timeline' ? 'secondary' : 'ghost'} size="icon" onClick={() => setViewMode('timeline')} className="h-8 w-8 rounded-md"><GanttChartSquare className="w-4 h-4" /></Button></div>
              {viewMode === 'timeline' && (<div className="flex items-center gap-2 bg-background/20 rounded-lg p-0.5 border border-white/5"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setTimelineStart(d => addDays(d, -7))}><ChevronLeft className="w-4 h-4" /></Button><span className="text-[10px] font-black uppercase px-2 tracking-tighter w-24 text-center">{format(timelineStart, 'MMM dd')} - {format(addDays(timelineStart, 13), 'MMM dd')}</span><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setTimelineStart(d => addDays(d, 7))}><ChevronRight className="w-4 h-4" /></Button></div>)}
            </div>
          </Card>
          <div className="flex-1 overflow-hidden">
            {viewMode === 'table' ? (
              <Card className="glass border-none shadow-2xl h-full flex flex-col"><div className="flex-1 overflow-auto custom-scrollbar"><Table className="relative"><TableHeader className="bg-muted/30 text-[10px] uppercase tracking-widest font-black sticky top-0 z-10 backdrop-blur-md"><TableRow className="hover:bg-transparent border-white/5 h-12"><TableHead className="pl-6 w-[250px]">Personnel Unit</TableHead><TableHead>Current/Upcoming Absences</TableHead><TableHead className="text-right pr-6 w-[120px]">Actions</TableHead></TableRow></TableHeader><TableBody>{loading ? (<TableRow><TableCell colSpan={3} className="text-center py-24 animate-pulse text-muted-foreground italic">Synchronizing Operational Pool...</TableCell></TableRow>) : filteredSoldiers.map((soldier) => {
                        const soldierAbsences = records.filter(r => r.soldier_id === soldier.id);
                        return (<TableRow key={soldier.id} className="hover:bg-white/5 transition-all border-white/5 group"><TableCell className="pl-6 py-5"><div className="flex items-center gap-4"><div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-primary font-black text-sm border border-primary/20 shadow-inner">{soldier.name.charAt(0)}</div><div className="flex flex-col"><span className="font-bold text-sm tracking-tight">{soldier.name}</span><div className="flex gap-1 mt-1">{soldier.skills.slice(0, 2).map(sk => <Badge key={sk} variant="outline" className="text-[8px] py-0 font-medium border-white/10 uppercase">{sk}</Badge>)}</div></div></div></TableCell><TableCell><div className="flex flex-wrap gap-2">{soldierAbsences.length === 0 ? <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-400 border-none text-[9px] font-black tracking-widest uppercase">Operational</Badge> : soldierAbsences.map(r => (<Badge key={r.id} className="bg-destructive/10 text-destructive border-destructive/20 text-[10px] py-1 px-3 cursor-pointer hover:bg-destructive/20 transition-colors gap-2 font-bold" onClick={() => handleOpenEdit(r)}><Clock className="w-3 h-3" />{format(new Date(r.start_datetime), "MMM d")} - {format(new Date(r.end_datetime), "MMM d")}</Badge>)) }</div></TableCell><TableCell className="text-right pr-6"><Button variant="outline" size="sm" className="opacity-0 group-hover:opacity-100 transition-all text-[10px] font-bold h-8 border-white/10 hover:bg-primary/10 hover:border-primary/50" onClick={() => handleOpenCreate({ soldier_id: soldier.id })}>Log Absence</Button></TableCell></TableRow>);
                      })}</TableBody></Table></div></Card>
            ) : (
              <Card className="glass border-none shadow-2xl h-full flex flex-col overflow-hidden"><div className="flex-1 overflow-auto custom-scrollbar"><div className="min-w-[1200px] w-full mt-1"><div className="flex sticky top-0 z-30 bg-background/95 backdrop-blur-md border-b border-white/10"><div className="w-56 shrink-0 sticky left-0 z-40 bg-background/95 backdrop-blur-lg border-r border-white/10 p-5 font-black text-[10px] uppercase tracking-widest text-muted-foreground shadow-[4px_0_15px_rgba(0,0,0,0.3)]">Personnel Resource</div><div className="flex-1 flex overflow-hidden">{timelineDays.map(day => (<div key={day.toISOString()} className={cn("flex-1 flex flex-col items-center justify-center py-3 border-r border-white/5 text-[10px] font-bold min-w-0", format(day, 'E') === 'Sat' || format(day, 'E') === 'Fri' ? "bg-white/5 text-amber-400" : "text-white/60")}><span>{format(day, 'MMM dd')}</span><span className="opacity-40 font-black">{format(day, 'EEE')}</span></div>))}</div></div><div className="relative"><div className="absolute inset-x-0 top-0 bottom-0 pl-56 flex pointer-events-none z-0">{timelineDays.map(day => (<div key={day.toISOString()} className="flex-1 border-r border-white/5 h-full"></div>))}</div>{filteredSoldiers.map(soldier => {
                         const soldierAbsences = records.filter(r => r.soldier_id === soldier.id);
                         return (<div key={soldier.id} className="flex border-b border-white/5 hover:bg-white/[0.03] transition-colors h-16 relative group cursor-crosshair" onClick={(e) => handleTimelineClick(soldier.id, e)}><div className="w-56 shrink-0 sticky left-0 z-20 bg-card/90 backdrop-blur-md border-r border-white/10 p-4 flex items-center shadow-[4px_0_15px_rgba(0,0,0,0.2)] group-hover:bg-card transition-colors shrink-0"><div className="flex items-center gap-3 truncate"><div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-xs font-black border border-white/10">{soldier.name.charAt(0)}</div><div className="flex flex-col truncate"><span className="text-xs font-bold truncate tracking-tight">{soldier.name}</span><span className="text-[8px] text-muted-foreground uppercase font-black">{soldier.skills[0] || 'no role'}</span></div></div></div><div className="flex-1 relative mx-0.5 z-10 pointer-events-none">{soldierAbsences.map(r => {
                                 const style = calculateGanttStyle(r.start_datetime, r.end_datetime);
                                 if (!style) return null;
                                 return (<div key={r.id} style={{ left: style.left, width: style.width }} onClick={(e) => { e.stopPropagation(); handleOpenEdit(r); }} className={cn("absolute top-2 bottom-2 bg-primary/20 border border-primary/50 rounded-lg p-2 flex flex-col justify-center gap-1 group/item cursor-pointer pointer-events-auto transition-all hover:bg-primary/30 hover:shadow-[0_0_20px_rgba(var(--primary-rgb),0.3)] hover:scale-[1.01] hover:z-20 gantt-bar overflow-hidden shadow-2xl shadow-black/50 font-bold", style.clippedStart && "rounded-l-none border-l-0", style.clippedEnd && "rounded-r-none border-r-0")}><div className="text-[9px] font-black text-primary-foreground/90 uppercase truncate tracking-tight text-center">{r.reason}</div></div>);
                               })}<div className="absolute inset-0 opacity-0 group-hover:opacity-100 bg-primary/5 transition-opacity" /></div></div>)
                      })}</div></div></div></Card>
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col gap-6 animate-in slide-in-from-bottom-4 duration-500">
          <Card className="glass border-none shadow-xl bg-card/20 p-4 shrink-0">
             <div className="flex items-center justify-between gap-8">
                <div className="flex items-center gap-4 shrink-0">
                   <div className="p-2.5 bg-primary/10 rounded-xl border border-primary/20">
                      <ShieldCheck className="w-5 h-5 text-primary"/>
                   </div>
                   <div>
                      <h3 className="text-sm font-bold">Simulation Controls</h3>
                      <p className="text-[10px] text-muted-foreground uppercase font-black tracking-widest">Two-week synchronization</p>
                   </div>
                </div>

                {/* Timeline Navigation */}
                <div className="flex items-center gap-4 bg-background/40 p-2 rounded-2xl border border-white/5 shadow-inner">
                   <Button variant="ghost" size="icon" className="h-10 w-10 text-primary hover:bg-primary/10 rounded-xl" onClick={() => setTimelineStart(d => addDays(d, -7))}>
                      <ChevronLeft className="w-5 h-5" />
                   </Button>
                   <div className="flex flex-col items-center min-w-[140px]">
                      <span className="text-[10px] font-black uppercase tracking-[2px] text-muted-foreground mb-1">Evaluation Period</span>
                      <span className="text-xs font-bold text-white">{format(timelineStart, 'MMM dd')} — {format(addDays(timelineStart, 13), 'MMM dd')}</span>
                   </div>
                   <Button variant="ghost" size="icon" className="h-10 w-10 text-primary hover:bg-primary/10 rounded-xl" onClick={() => setTimelineStart(d => addDays(d, 7))}>
                      <ChevronRight className="w-5 h-5" />
                   </Button>
                </div>

                {/* Time Inputs */}
                <div className="flex-1 flex gap-4 max-w-sm">
                   <div className="flex-1 space-y-1">
                      <Label className="text-[9px] font-black uppercase tracking-widest opacity-40 flex items-center gap-1.5"><Clock className="w-3 h-3" /> Activation</Label>
                      <Input type="time" value={st} onChange={(e) => setSt(e.target.value)} className="bg-white/5 border-white/10 h-10 rounded-xl font-bold text-center" />
                   </div>
                   <div className="flex-1 space-y-1">
                      <Label className="text-[9px] font-black uppercase tracking-widest opacity-40 flex items-center gap-1.5"><Clock className="w-3 h-3" /> Release</Label>
                      <Input type="time" value={et} onChange={(e) => setEt(e.target.value)} className="bg-white/5 border-white/10 h-10 rounded-xl font-bold text-center" />
                   </div>
                </div>
             </div>
          </Card>

          <Card className="glass border-none shadow-2xl flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto custom-scrollbar">
              <div className="min-w-full w-fit">
                {/* Header Row */}
                <div className="flex sticky top-0 z-30 bg-background/95 backdrop-blur-md border-b border-white/10">
                  <div className="w-56 shrink-0 sticky left-0 z-40 bg-background/95 backdrop-blur-lg border-r border-white/10 p-5 font-black text-[10px] uppercase tracking-widest text-muted-foreground shadow-[4px_0_15px_rgba(0,0,0,0.3)]">
                    Qualification Metric
                  </div>
                  <div className="flex">
                    {Array.isArray(manpowerReport) && manpowerReport.map((dayData) => (
                      <div key={dayData.date} className="w-16 shrink-0 flex flex-col items-center justify-center py-4 border-r border-white/5 text-[9px] font-bold">
                        <span className="text-white/80">{format(parseISO(dayData.date), "dd/MM")}</span>
                        <span className="opacity-40 font-black uppercase tracking-tighter scale-75 origin-top">{format(parseISO(dayData.date), "EEE")}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Skill Rows */}
                <div className="relative">
                  {allSkills.map((skill) => (
                    <div key={skill} className="flex border-b border-white/5 hover:bg-white/[0.03] transition-colors h-16 group">
                      {/* Skill Name Column */}
                      <div className="w-56 shrink-0 sticky left-0 z-20 bg-card/90 backdrop-blur-md border-r border-white/10 p-5 flex items-center shadow-[4px_0_15px_rgba(0,0,0,0.2)] group-hover:bg-card transition-colors">
                        <div className="flex flex-col gap-0.5 pointer-events-none">
                          <span className="text-[10px] font-black uppercase tracking-wider text-white/90 truncate">{skill}</span>
                          <span className="text-[8px] text-muted-foreground font-bold italic opacity-60">Status Pool</span>
                        </div>
                      </div>

                      {/* Daily Metrics */}
                      <div className="flex">
                        {manpowerReport.map((dayData) => {
                          const metric = dayData.report.find(m => m.skill === skill);
                          if (!metric) return <div key={dayData.date} className="w-16 shrink-0 border-r border-white/5 bg-black/20" />;
                          
                          return (
                            <div key={dayData.date} className="w-16 shrink-0 border-r border-white/5 px-1 py-3 flex flex-col justify-center gap-1.5 group/cell">
                              <div className="flex items-center justify-center">
                                <span className={cn(
                                  "text-[10px] font-black px-1 rounded flex items-center justify-center text-center tracking-tighter",
                                  metric.status === 'danger' ? "text-red-500" : metric.status === 'warning' ? "text-amber-500" : "text-emerald-500"
                                )}>
                                  {metric.available}/{metric.needed.toFixed(1)}
                                </span>
                              </div>
                              <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden border border-white/5">
                                <div 
                                  className={cn(
                                    "h-full transition-all duration-700 ease-out shadow-[0_0_5px_rgba(var(--primary-rgb),0.5)]",
                                    metric.status === 'danger' ? "bg-red-500" : metric.status === 'warning' ? "bg-amber-500" : "bg-emerald-500"
                                  )} 
                                  style={{ width: `${Math.min(100, (metric.available / (metric.needed || 1)) * 100)}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="p-4 bg-background/50 border-t border-white/5 shrink-0 flex justify-between items-center">
               <div className="flex gap-6">
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[2px]">
                     <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                     <span className="text-emerald-400">Sustainable</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[2px]">
                     <div className="w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]" />
                     <span className="text-amber-400">Caution</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[2px]">
                     <div className="w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
                     <span className="text-red-400">Critical</span>
                  </div>
               </div>
               <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground opacity-50">
                  Total Pool Metrics: {soldiers.length} Personnel Assets Managed
               </div>
            </div>
          </Card>
        </div>
      )}

      {/* Auth Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="glass border-white/10 text-white max-w-lg shadow-[0_0_50px_rgba(0,0,0,0.5)] backdrop-blur-3xl overflow-visible p-0">
          <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-primary/50 via-primary to-primary/50" />
          
          <div className="p-6 space-y-6">
            <DialogHeader>
              <DialogTitle className="text-2xl font-black flex items-center gap-3 tracking-tight">
                {editingRecord ? "AMEND RECORD" : "AUTHORIZE ABSENCE"}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-5">
              {/* Personnel Asset Row */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest opacity-60">
                   <User className="w-3 h-3" /> Personnel Asset
                </Label>
                <Select value={formData.soldier_id} onValueChange={v => setFormData(f => ({ ...f, soldier_id: v }))}>
                  <SelectTrigger className="bg-white/5 border-white/10 h-10 rounded-xl font-bold">
                    <SelectValue placeholder="Identify Personnel..." />
                  </SelectTrigger>
                  <SelectContent className="bg-zinc-950 border-white/10 text-white max-h-60">
                    {soldiers.map(s => (
                      <SelectItem key={s.id} value={s.id.toString()} className="font-bold">{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Date & Time Grid */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest opacity-60">
                  <CalendarIcon className="w-3 h-3" /> Absence Duration
                </Label>
                <DateTimeRangePicker 
                  date={dateRange} setDate={setDateRange} 
                  startTime={st} setStartTime={setSt} 
                  endTime={et} setEndTime={setEt} 
                />
              </div>

              {/* Purpose Selection */}
              <div className="space-y-3">
                <Label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest opacity-60">
                  <Info className="w-3 h-3" /> Purpose of Absence
                </Label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { id: 'regular', label: 'Regular', icon: Home },
                    { id: 'vacation', label: 'Vacation', icon: Plane },
                    { id: 'sickness', label: 'Sick', icon: Stethoscope },
                    { id: 'other', label: 'Custom', icon: MoreHorizontal }
                  ].map(type => (
                    <Button 
                      key={type.id} 
                      variant={reasonType === type.id ? 'secondary' : 'outline'} 
                      className={cn(
                        "h-12 flex flex-col gap-0.5 rounded-xl border-white/5", 
                        reasonType === type.id && "bg-primary/20 border-primary/40 text-primary"
                      )} 
                      onClick={() => setReasonType(type.id)}
                    >
                      <type.icon className="w-3.5 h-3.5" />
                      <span className="text-[9px] font-black uppercase">{type.label}</span>
                    </Button>
                  ))}
                </div>
                {reasonType === 'other' && (
                  <div className="animate-in slide-in-from-top-2 duration-300">
                    <Input 
                      placeholder="Details..." 
                      className="bg-white/5 border-white/10 h-10 rounded-xl text-xs font-medium" 
                      value={formData.reason} 
                      onChange={e => setFormData(f => ({ ...f, reason: e.target.value }))}
                    />
                  </div>
                )}
              </div>

              {/* Status Alert */}
              {Array.isArray(manpowerReport) && manpowerReport.some(d => d.report.some(m => m.status === 'danger')) && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3">
                  <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                  <p className="text-[10px] font-bold text-red-200/80 leading-tight">
                    Crucial shortage detected for simulation window.
                  </p>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 p-4 bg-background/50 border-t border-white/5">
            {editingRecord ? (
              <>
                <Button variant="ghost" onClick={() => handleDelete(editingRecord.id)} className="text-destructive font-black h-10 rounded-xl text-xs px-4">PURGE</Button>
                <Button onClick={handleSave} className="bg-primary flex-1 font-black h-10 rounded-xl text-xs uppercase tracking-wider">Save Amendments</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setIsDialogOpen(false)} className="font-black h-10 rounded-xl text-xs px-4">CANCEL</Button>
                <Button onClick={handleSave} className="bg-primary flex-1 font-black h-10 rounded-xl text-xs uppercase tracking-wider">Authorize Absence</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
