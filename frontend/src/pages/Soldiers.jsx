import React, { useEffect, useState, useRef } from 'react';
import { getSoldiers, createSoldier, updateSoldier, deleteSoldier, exportSoldiers, importSoldiers, getSkills } from '@/services/api';
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
import { Search, RefreshCw, UserPlus, Pencil, Trash2, Download, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export default function Soldiers() {
  const [soldiers, setSoldiers] = useState([]);
  const [availableSkills, setAvailableSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSoldier, setEditingSoldier] = useState(null);
  const [formData, setFormData] = useState({ name: "", skills: [], division: "" });
  const fileInputRef = useRef(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [{ data: soldiersData }, { data: skillsData }] = await Promise.all([
        getSoldiers(),
        getSkills()
      ]);
      setSoldiers(soldiersData);
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
        const response = await exportSoldiers();
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'soldiers.csv');
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
        await importSoldiers(file);
        fetchData();
        alert("Import successful!");
    } catch (e) {
        console.error("Import failed", e);
        alert("Import failed. Please check CSV format.");
    } finally {
        setLoading(false);
        e.target.value = null;
    }
  };

  const handleOpenAdd = () => {
    setEditingSoldier(null);
    setFormData({ name: "", skills: [], division: "" });
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (s) => {
    setEditingSoldier(s);
    setFormData({ name: s.name, skills: s.skills, division: s.division || "" });
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    try {
        const payload = { ...formData, division: formData.division ? parseInt(formData.division) : null };
        if (editingSoldier) await updateSoldier(editingSoldier.id, payload);
        else await createSoldier(payload);
        setIsDialogOpen(false);
        fetchData();
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (id) => {
    if (!confirm("Are you sure?")) return;
    try { await deleteSoldier(id); fetchData(); } catch (e) { console.error(e); }
  };

  const filteredSoldiers = soldiers.filter(s => s.name.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Personnel Management</h2>
          <p className="text-muted-foreground mt-1 text-sm">Manage soldier profiles and bulk data operations.</p>
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
            <UserPlus className="w-4 h-4" /> Add Soldier
          </Button>
        </div>
      </div>

      <Card className="glass border-none">
        <CardHeader className="pb-3 px-6 pt-6">
          <div className="flex items-center gap-4">
             <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder="Search personnel..." className="pl-10 bg-background/50 border-border" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
             </div>
             <Button variant="outline" size="icon" onClick={fetchData} disabled={loading}>
                <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
             </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50 text-[11px] uppercase tracking-wider">
              <TableRow>
                <TableHead className="w-[80px] pl-6 text-muted-foreground">ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Qualifications</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right pr-6 w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-20 text-muted-foreground animate-pulse">Synchronizing database...</TableCell></TableRow>
              ) : filteredSoldiers.map((soldier) => (
                <TableRow key={soldier.id} className="hover:bg-muted/30 transition-colors group">
                  <TableCell className="font-mono text-muted-foreground pl-6 text-[10px]">#{soldier.id}</TableCell>
                  <TableCell className="font-semibold text-sm">{soldier.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {soldier.skills.map(skill => (
                        <Badge key={skill} variant="outline" className="text-[9px] uppercase font-bold py-0">{skill}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-xs">{soldier.history_score.toFixed(1)}</TableCell>
                  <TableCell className="text-right pr-6">
                    <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleOpenEdit(soldier)}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500" onClick={() => handleDelete(soldier.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="glass border-border text-white">
            <DialogHeader><DialogTitle>{editingSoldier ? 'Edit Soldier' : 'Add New Soldier'}</DialogTitle></DialogHeader>
            <div className="space-y-4 py-4">
                <div className="space-y-2">
                    <Label htmlFor="name">Full Name</Label>
                    <Input id="name" value={formData.name} onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))} className="bg-background/50 border-border" />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="division">Division ID</Label>
                    <Input id="division" type="number" value={formData.division} onChange={e => setFormData(prev => ({ ...prev, division: e.target.value }))} className="bg-background/50 border-border" />
                </div>
                <div className="space-y-2">
                    <Label className="text-sm font-bold uppercase tracking-widest opacity-50">Qualifications</Label>
                    <div className="grid grid-cols-2 gap-3 mt-2">
                        {availableSkills.map(skill => (
                            <div key={skill} className="flex items-center space-x-2 bg-muted/20 p-2 rounded-lg border border-border/50 hover:bg-muted/40 transition-colors">
                                <Checkbox id={`skill-${skill}`} checked={formData.skills.includes(skill)} onCheckedChange={() => setFormData(prev => ({ ...prev, skills: prev.skills.includes(skill) ? prev.skills.filter(s => s !== skill) : [...prev.skills, skill] }))} />
                                <Label htmlFor={`skill-${skill}`} className="text-xs font-medium capitalize cursor-pointer">{skill}</Label>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} className="bg-primary hover:bg-primary/90">{editingSoldier ? 'Save Changes' : 'Create Profile'}</Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
