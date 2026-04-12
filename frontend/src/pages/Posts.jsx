import React, { useEffect, useState, useRef } from 'react';
import { getPosts, createPost, updatePost, deletePost, exportPosts, importPosts, getSkills } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Clock, ShieldCheck, RefreshCw, Trash2, X, Pencil, Download, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

export default function Posts() {
  const [posts, setPosts] = useState([]);
  const [availableSkills, setAvailableSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const [formData, setFormData] = useState({
    name: "",
    shift_length_hours: 4,
    start_time: "06:00",
    end_time: "05:59",
    cooldown_hours: 0,
    intensity_weight: 1.0,
    slots: ["soldier"],
    is_active: true
  });
  const fileInputRef = useRef(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [{ data: postsData }, { data: skillsData }] = await Promise.all([
        getPosts(),
        getSkills()
      ]);
      setPosts(postsData);
      setAvailableSkills(skillsData);
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const handleExport = async () => {
    try {
        const response = await exportPosts();
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'posts.csv');
        document.body.appendChild(link);
        link.click();
        link.remove();
    } catch (e) { console.error("Export failed", e); }
  };

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        setLoading(true);
        await importPosts(file);
        fetchData();
        alert("Import successful!");
    } catch (e) {
        console.error("Import failed", e);
        alert("Import failed. Check format.");
    } finally {
        setLoading(false);
        e.target.value = null;
    }
  };

  const handleOpenAdd = () => {
    setEditingPost(null);
    setFormData({ name: "", shift_length_hours: 4, start_time: "06:00", end_time: "05:59", cooldown_hours: 0, intensity_weight: 1.0, slots: [availableSkills[0] || ""], is_active: true });
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (post) => {
    setEditingPost(post);
    setFormData({
        name: post.name,
        shift_length_hours: post.shift_length_hours,
        start_time: post.start_time,
        end_time: post.end_time,
        cooldown_hours: post.cooldown_hours,
        intensity_weight: post.intensity_weight,
        is_active: post.is_active,
        slots: post.slots.sort((a,b) => a.role_index - b.role_index).map(s => s.skill)
    });
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    try {
        if (editingPost) await updatePost(editingPost.name, formData);
        else await createPost(formData);
        setIsDialogOpen(false);
        fetchData();
    } catch (error) { console.error("Error saving post:", error); }
  };

  const handleDelete = async (name) => {
    if (!confirm(`Are you sure?`)) return;
    try { await deletePost(name); fetchData(); } catch (error) { console.error(error); }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Post Configuration</h2>
          <p className="text-muted-foreground mt-1 text-sm">Define tasks, required skills, and intensity weights.</p>
        </div>
        <div className="flex gap-2">
           <input type="file" ref={fileInputRef} className="hidden" accept=".csv" onChange={handleImport} />
           <Button variant="outline" size="sm" className="gap-2" onClick={() => fileInputRef.current?.click()} disabled={loading}>
            <Upload className="w-4 h-4" /> Import CSV
          </Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={handleExport} disabled={loading}>
            <Download className="w-4 h-4" /> Export CSV
          </Button>
          <Button size="sm" className="gap-2 ml-2" onClick={handleOpenAdd}>
            <Plus className="w-4 h-4" /> New Post
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {loading ? (
            <div className="col-span-full text-center py-20 italic animate-pulse">Scanning post definitions...</div>
        ) : posts.map((post) => (
            <Card key={post.name} className={cn("glass flex flex-col border-none group relative overflow-hidden transition-all duration-300", !post.is_active && "opacity-60 grayscale-[0.4]")}>
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <div className="flex flex-col gap-1">
                    <CardTitle className="text-xl font-bold">{post.name}</CardTitle>
                    {!post.is_active && <Badge variant="outline" className="w-fit text-[9px] h-4 bg-muted text-muted-foreground uppercase font-black px-1.5 border-none">Inactive</Badge>}
                  </div>
                  <Badge variant={post.intensity_weight > 1.2 ? "destructive" : "secondary"} className="font-mono text-[10px]">
                    W: {post.intensity_weight.toFixed(1)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex-1 space-y-4 pt-2">
                <div className="flex items-center gap-4 text-xs text-muted-foreground bg-muted/20 p-2 rounded-lg border border-border/40">
                  <div className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> {post.shift_length_hours}h</div>
                  <div className="flex items-center gap-1.5 border-l border-border/50 pl-4"><RefreshCw className="w-3.5 h-3.5" /> {post.cooldown_hours}h CD</div>
                </div>
                <div className="space-y-2">
                  <h4 className="text-[9px] font-extrabold uppercase text-muted-foreground tracking-[0.2em] flex items-center gap-1.5 opacity-60">
                    <ShieldCheck className="w-3 h-3" /> Required Slots
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {post.slots.map((slot, idx) => (
                      <Badge key={idx} variant="outline" className="text-[9px] bg-background/30 font-bold px-2 py-0.5 border-border/60">
                        {slot.skill}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-0 flex gap-2">
                    <Button variant="outline" className="flex-1 h-8 text-[10px] gap-2 border-border/40 hover:bg-muted/50" onClick={() => handleOpenEdit(post)}>
                        <Pencil className="w-3 h-3" /> Edit Template
                    </Button>
                    <Button variant="outline" className="h-8 w-8 text-red-500 hover:text-red-400 p-0 border-border/40" onClick={() => handleDelete(post.name)}>
                        <Trash2 className="w-4 h-4" />
                    </Button>
              </CardFooter>
            </Card>
          ))
        }
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="glass border-border text-white max-w-lg scrollbar-hide max-h-[90vh] overflow-y-auto">
            <DialogHeader>
                <DialogTitle className="text-xl font-bold">{editingPost ? `Edit Post: ${editingPost.name}` : 'Create New Post Template'}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-6 py-4">
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label className="text-xs uppercase opacity-60 font-bold tracking-wider">Post Name</Label>
                        <Input value={formData.name} onChange={e => setFormData(p => ({...p, name: e.target.value}))} className="bg-background/50 border-border" disabled={!!editingPost} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label className="text-xs uppercase opacity-60 font-bold tracking-wider">Weight</Label>
                            <Input type="number" step="0.1" value={formData.intensity_weight} onChange={e => setFormData(p => ({...p, intensity_weight: parseFloat(e.target.value)}))} className="bg-background/50 border-border" />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs uppercase opacity-60 font-bold tracking-wider">Cooldown</Label>
                            <Input type="number" value={formData.cooldown_hours} onChange={e => setFormData(p => ({...p, cooldown_hours: parseInt(e.target.value)}))} className="bg-background/50 border-border" />
                        </div>
                    </div>
                    <div className="flex items-center gap-3 bg-background/30 p-2.5 rounded-lg border border-border/40">
                        <Label className="text-xs uppercase opacity-80 font-bold flex-1 cursor-pointer" htmlFor="post-active-toggle">Enabled / Active</Label>
                        <input 
                            id="post-active-toggle"
                            type="checkbox" 
                            checked={formData.is_active} 
                            onChange={e => setFormData(p => ({...p, is_active: e.target.checked}))}
                            className="w-4 h-4 rounded border-border bg-background accent-primary cursor-pointer"
                        />
                    </div>
                </div>
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label className="text-xs uppercase opacity-60 font-bold tracking-wider">Shift Duration (Hrs)</Label>
                        <Input type="number" value={formData.shift_length_hours} onChange={e => setFormData(p => ({...p, shift_length_hours: parseInt(e.target.value)}))} className="bg-background/50 border-border" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label className="text-xs uppercase opacity-60 font-bold tracking-wider">Start Time</Label>
                            <Input type="time" value={formData.start_time} onChange={e => setFormData(p => ({...p, start_time: e.target.value}))} className="bg-background/50 border-border px-2" />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs uppercase opacity-60 font-bold tracking-wider">End Time</Label>
                            <Input type="time" value={formData.end_time} onChange={e => setFormData(p => ({...p, end_time: e.target.value}))} className="bg-background/50 border-border px-2" />
                        </div>
                    </div>
                </div>
            </div>
            
            <div className="space-y-3 pt-2">
                <div className="flex justify-between items-center border-b border-border/50 pb-2">
                    <Label className="text-xs font-bold uppercase tracking-widest text-primary">Required Slots</Label>
                    <Button variant="outline" size="sm" onClick={() => setFormData(prev => ({ ...prev, slots: [...prev.slots, availableSkills[0] || ""] }))} className="h-7 text-[9px] uppercase font-black bg-primary/10 text-primary border-primary/30">Add Slot</Button>
                </div>
                <div className="grid grid-cols-1 gap-2 mt-1">
                    {formData.slots.map((slotSkill, idx) => (
                        <div key={idx} className="flex gap-2 items-center bg-muted/20 p-2 rounded-lg border border-border/40">
                            <Badge variant="outline" className="font-mono h-8 w-8 justify-center rounded-md border-border/60">#{idx+1}</Badge>
                            <div className="flex-1">
                                <Select value={slotSkill} onValueChange={(val) => {
                                    const newSlots = [...formData.slots];
                                    newSlots[idx] = val;
                                    setFormData(p => ({ ...p, slots: newSlots }));
                                }}>
                                    <SelectTrigger className="bg-background/40 h-8 border-border/50">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {availableSkills.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </div>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-red-500" onClick={() => setFormData(p => ({ ...p, slots: p.slots.filter((_, i) => i !== idx) }))}>
                                <X className="w-4 h-4" />
                            </Button>
                        </div>
                    ))}
                </div>
            </div>
            <DialogFooter className="pt-4 gap-2">
                <Button variant="ghost" className="text-muted-foreground" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} className="bg-primary hover:bg-primary/90 font-bold px-8">{editingPost ? 'Update Template' : 'Create Template'}</Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
