import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, Paintbrush, RefreshCw, Wrench, X } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { gsheetsService } from '@/services/gsheetsService';
import { summarizeIssues } from '@/lib/sheetModel';
import { describeError } from '@/lib/errors';
import { notify, useConfirm } from '@/lib/notify';

const LEVEL = {
  error: { Icon: AlertCircle, cls: 'text-red-400' },
  warning: { Icon: AlertTriangle, cls: 'text-amber-400' },
  info: { Icon: Info, cls: 'text-blue-400' },
};
const ORDER = { error: 0, warning: 1, info: 2 };

/** A flat list of problems, worst first. Items: { level, sheet?, row?, message }. */
export function IssueList({ issues, limit = 50, className = '' }) {
  const sorted = [...issues].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  const shown = sorted.slice(0, limit);
  return (
    <ul className={`space-y-1.5 text-sm ${className}`}>
      {shown.map((i, idx) => {
        const { Icon, cls } = LEVEL[i.level] || LEVEL.info;
        return (
          <li key={idx} className="flex items-start gap-2">
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${cls}`} />
            <span className="min-w-0 break-words">
              {i.sheet && <span className="font-semibold">{i.sheet}{i.row ? ` row ${i.row}` : ''}: </span>}
              {i.message}
            </span>
          </li>
        );
      })}
      {sorted.length > limit && <li className="text-xs text-muted-foreground">…and {sorted.length - limit} more.</li>}
    </ul>
  );
}

/** Banner shown on the Scheduler when a day has nothing to schedule or something looks wrong. */
export function DiagnosticsBanner({ items }) {
  // Dismissal is remembered per set of messages, so a different problem shows up again.
  const key = items.map((i) => i.message).join('|');
  const [dismissedKey, setDismissedKey] = useState(null);
  if (!items.length || dismissedKey === key) return null;
  const worst = items.some((i) => i.level === 'error') ? 'error' : 'warning';
  return (
    <div className={`mx-1 mb-3 p-3 rounded-lg border flex items-start gap-3 ${worst === 'error' ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
      <div className="flex-1 min-w-0 space-y-2">
        <p className="text-xs font-semibold">Why is nothing being scheduled?</p>
        <IssueList issues={items} limit={6} />
        <p className="text-xs text-muted-foreground">
          Check the spreadsheet under <Link to="/settings" className="underline">Settings → Spreadsheet health</Link>.
        </p>
      </div>
      <button onClick={() => setDismissedKey(key)} aria-label="Dismiss" className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
    </div>
  );
}

/** Spreadsheet health: what was found, what is wrong, and a one-click structure repair. */
export function SheetHealthCard({ compact = false }) {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      gsheetsService.clearCache();
      setHealth(await gsheetsService.getHealth());
    } catch (e) {
      console.error(e);
      setError(describeError(e, 'Could not read the spreadsheet.'));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const repair = async () => {
    setBusy(true);
    try {
      const changes = await gsheetsService.ensureSchema({ force: true });
      notify.success(changes.length ? `Repaired: ${changes.join('; ')}.` : 'Nothing to repair - the structure is already complete.');
      await load();
    } catch (e) {
      console.error(e);
      notify.error(describeError(e, 'Could not repair the spreadsheet.'));
      setBusy(false);
    }
  };

  const format = async () => {
    const ok = await confirm({
      title: 'Format sheets for editing?',
      description: 'Adds a styled header, notes, dropdowns, input checks, ISO date/24h time formats and red/amber highlighting of cells the app cannot read to the Soldiers, Posts and Unavailabilities tabs. Missing header columns are added; existing data is never changed. Highlight rules created by this app are refreshed; other formatting rules you added are kept.',
      confirmText: 'Format',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await gsheetsService.ensureSchema({ force: true });
      const n = await gsheetsService.applyFormatting();
      notify.success(`Formatted ${n} tab(s) for editing in Google Sheets.`);
      await load();
    } catch (e) {
      console.error(e);
      notify.error(describeError(e, 'Could not format the spreadsheet.'));
      setBusy(false);
    }
  };

  if (compact) {
    if (!health || !health.issues.length) return error ? (
      <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 text-red-400 shrink-0" />{error}
      </div>
    ) : null;
    const { errors, warnings } = summarizeIssues(health.issues);
    return (
      <div className={`p-4 rounded-lg border space-y-2 ${errors ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold">
            Your spreadsheet has {errors ? `${errors} problem${errors === 1 ? '' : 's'}` : ''}{errors && warnings ? ' and ' : ''}{warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''}
          </p>
          <Link to="/settings" className="text-xs underline shrink-0">Review</Link>
        </div>
        <IssueList issues={health.issues} limit={3} />
      </div>
    );
  }

  const summary = health ? summarizeIssues(health.issues) : null;
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Spreadsheet health
          {summary && (summary.errors ? <AlertCircle className="w-4 h-4 text-red-400" /> : summary.warnings ? <AlertTriangle className="w-4 h-4 text-amber-400" /> : <CheckCircle2 className="w-4 h-4 text-green-400" />)}
        </CardTitle>
        <CardDescription>
          The spreadsheet can be edited by hand. This checks that the tabs, columns and values can be understood.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {busy && !health && <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Checking…</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {health && (
          <>
            <p className="text-sm text-muted-foreground">
              Found {health.counts.soldiers} soldier(s), {health.counts.posts} post(s), {health.counts.unavailabilities} unavailability record(s) and {health.counts.assignments} scheduled assignment(s).
            </p>
            {health.issues.length === 0
              ? <p className="text-sm text-green-400 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> No problems found.</p>
              : <IssueList issues={health.issues} />}
          </>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={load} disabled={busy}>
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Check again
          </Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={repair} disabled={busy} title="Creates missing tabs and header columns. Never changes existing data.">
            <Wrench className="w-4 h-4" /> Repair sheet structure
          </Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={format} disabled={busy} title="Dropdowns, validation, formats and highlighting for editing the sheet by hand. Never changes cell contents.">
            <Paintbrush className="w-4 h-4" /> Format sheets for editing
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Result of a file import: counts plus anything that was skipped or adjusted. */
export function ImportReport({ report, onClose }) {
  if (!report) return null;
  const problems = report.issues;
  return (
    <div className="fixed inset-0 z-[105] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-2xl space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Import finished</h2>
        <p className="text-sm">
          Imported <b>{report.imported}</b> new {report.kind}{report.skipped ? `, skipped ${report.skipped} that already exist` : ''}.
        </p>
        {problems.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">These rows needed attention:</p>
            <IssueList issues={problems} limit={30} />
          </>
        )}
        <div className="flex justify-end"><Button onClick={onClose}>Close</Button></div>
      </div>
    </div>
  );
}
