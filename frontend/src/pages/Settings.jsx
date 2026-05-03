import React, { useState } from 'react';
import { gsheetsService } from '../services/gsheetsService';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Save, ExternalLink, Info } from 'lucide-react';

export default function Settings() {
  const [spreadsheetId, setSpreadsheetId] = useState(gsheetsService.getSpreadsheetId());
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const handleSave = () => {
    setIsSaving(true);
    try {
      gsheetsService.setSpreadsheetId(spreadsheetId);
      setMessage({ type: 'success', text: 'Settings saved successfully!' });
      setTimeout(() => setMessage({ type: '', text: '' }), 3000);
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to save settings.' });
    } finally {
      setIsSaving(false);
    }
  };

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Configure your application preferences and Google Sheets integration.
        </p>
      </div>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Google Sheets Configuration
          </CardTitle>
          <CardDescription>
            Connect the application to your own Google Spreadsheet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="spreadsheet-id">Spreadsheet ID</Label>
            <div className="flex gap-2">
              <Input
                id="spreadsheet-id"
                value={spreadsheetId}
                onChange={(e) => setSpreadsheetId(e.target.value)}
                placeholder="Enter Spreadsheet ID"
                className="font-mono text-sm"
              />
              <Button 
                variant="outline" 
                size="icon"
                onClick={() => window.open(sheetUrl, '_blank')}
                title="Open Spreadsheet"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20 flex gap-3 text-sm text-blue-200">
            <Info className="h-5 w-5 shrink-0 text-blue-400" />
            <div className="space-y-1">
              <p className="font-semibold text-blue-300">Where to find the Spreadsheet ID?</p>
              <p className="opacity-80">
                Open your Google Sheet. The ID is the long string of characters in the URL between 
                <code className="bg-blue-500/20 px-1 rounded mx-1">/d/</code> and 
                <code className="bg-blue-500/20 px-1 rounded mx-1">/edit</code>.
              </p>
            </div>
          </div>

          {message.text && (
            <div className={`p-3 rounded-md text-sm ${
              message.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
              {message.text}
            </div>
          )}
        </CardContent>
        <CardFooter className="border-t border-border/50 pt-6 flex justify-between gap-4">
          <Button 
            onClick={handleSave} 
            disabled={isSaving}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            {isSaving ? 'Saving...' : 'Save Configuration'}
          </Button>
          <Button 
            variant="outline"
            onClick={() => {
              if (confirm("Disconnect this spreadsheet? You will be redirected to the setup page.")) {
                gsheetsService.setSpreadsheetId(null);
                window.location.reload();
              }
            }}
            className="text-muted-foreground hover:text-destructive"
          >
            Change Spreadsheet
          </Button>
        </CardFooter>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm opacity-60">
        <CardHeader>
          <CardTitle className="text-lg">Application Info</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Version</span>
            <span className="font-medium text-foreground">1.2.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Storage</span>
            <span className="font-medium text-foreground">Local Browser Storage</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
