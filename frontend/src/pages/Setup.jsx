import React, { useEffect, useState } from 'react';
import { gsheetsService } from '../services/gsheetsService';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { 
  Plus, 
  FileSpreadsheet, 
  ChevronRight, 
  Search, 
  Loader2,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

export default function Setup() {
  const [view, setView] = useState('choice'); // 'choice', 'create', 'select'
  const [loading, setLoading] = useState(false);
  const [spreadsheets, setSpreadsheets] = useState([]);
  const [newTitle, setNewTitle] = useState('Shavtzachi Scheduler');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (view === 'select') {
      fetchSpreadsheets();
    }
  }, [view]);

  const fetchSpreadsheets = async () => {
    setLoading(true);
    setError(null);
    try {
      const files = await gsheetsService.listSpreadsheets();
      setSpreadsheets(files);
    } catch (err) {
      setError("Failed to load spreadsheets from Google Drive.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await gsheetsService.createSpreadsheet(newTitle);
      window.location.reload();
    } catch (err) {
      setError("Failed to create spreadsheet. Ensure you have the required permissions.");
      console.error(err);
      setLoading(false);
    }
  };

  const handleSelect = (id) => {
    gsheetsService.setSpreadsheetId(id);
    window.location.reload();
  };

  const renderChoice = () => (
    <div className="grid gap-6 sm:grid-cols-2">
      <button
        onClick={() => setView('create')}
        className="flex flex-col items-center gap-4 p-8 rounded-2xl border border-border/50 bg-card/40 hover:bg-card/60 hover:border-primary/50 transition-all group text-center"
      >
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
          <Plus className="w-8 h-8" />
        </div>
        <div>
          <h3 className="text-xl font-bold mb-1">Create New</h3>
          <p className="text-sm text-muted-foreground">Start fresh with a pre-configured spreadsheet.</p>
        </div>
      </button>

      <button
        onClick={() => setView('select')}
        className="flex flex-col items-center gap-4 p-8 rounded-2xl border border-border/50 bg-card/40 hover:bg-card/60 hover:border-primary/50 transition-all group text-center"
      >
        <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-500 group-hover:scale-110 transition-transform">
          <Search className="w-8 h-8" />
        </div>
        <div>
          <h3 className="text-xl font-bold mb-1">Select Existing</h3>
          <p className="text-sm text-muted-foreground">Connect to a spreadsheet you already have.</p>
        </div>
      </button>
    </div>
  );

  const renderCreate = () => (
    <Card className="border-border/50 bg-card/50 backdrop-blur-xl">
      <CardHeader>
        <CardTitle>Create New Spreadsheet</CardTitle>
        <CardDescription>We'll create a new Google Sheet with all required tabs and headers.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title">Spreadsheet Title</Label>
          <Input 
            id="title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="e.g. My Unit Schedule"
            className="bg-background/50"
          />
        </div>
      </CardContent>
      <CardFooter className="flex justify-between gap-3">
        <Button variant="ghost" onClick={() => setView('choice')}>Back</Button>
        <Button onClick={handleCreate} disabled={loading || !newTitle} className="gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          Create Spreadsheet
        </Button>
      </CardFooter>
    </Card>
  );

  const renderSelect = () => (
    <Card className="border-border/50 bg-card/50 backdrop-blur-xl">
      <CardHeader>
        <CardTitle>Select a Spreadsheet</CardTitle>
        <CardDescription>Showing recent spreadsheets from your Google Drive.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="py-12 flex flex-col items-center gap-4 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="animate-pulse">Fetching files...</p>
          </div>
        ) : spreadsheets.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground space-y-4">
            <AlertCircle className="w-12 h-12 mx-auto opacity-20" />
            <p>No spreadsheets found in your Drive.</p>
            <Button variant="outline" onClick={() => setView('create')}>Create one instead</Button>
          </div>
        ) : (
          <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
            {spreadsheets.map((file) => (
              <button
                key={file.id}
                onClick={() => handleSelect(file.id)}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border/50 bg-background/30 hover:bg-accent hover:border-primary/30 transition-all text-left group"
              >
                <div className="p-2 rounded bg-green-500/10 text-green-500">
                  <FileSpreadsheet className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{file.name}</div>
                  <div className="text-xs text-muted-foreground">Modified {new Date(file.modifiedTime).toLocaleDateString()}</div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
              </button>
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter>
        <Button variant="ghost" onClick={() => setView('choice')}>Back</Button>
      </CardFooter>
    </Card>
  );

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-[#020617] text-white overflow-hidden relative">
      {/* Background blobs */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-primary/10 blur-[100px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-blue-500/10 blur-[100px]" />
      </div>

      <div className="w-full max-w-2xl z-10 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 rounded-2xl bg-primary/10 text-primary mb-2">
            <FileSpreadsheet className="w-8 h-8" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Sheet Setup</h1>
          <p className="text-xl text-slate-400">Welcome to Shavtzachi! Let's connect your workspace.</p>
        </div>

        {error && (
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex gap-3 items-center">
            <AlertCircle className="w-5 h-5 shrink-0" />
            {error}
          </div>
        )}

        <div className="transition-all duration-300">
          {view === 'choice' && renderChoice()}
          {view === 'create' && renderCreate()}
          {view === 'select' && renderSelect()}
        </div>

        <p className="text-center text-sm text-slate-500">
          Tip: You can always change your spreadsheet later in Settings.
        </p>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
      `}</style>
    </div>
  );
}
