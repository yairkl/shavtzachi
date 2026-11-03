import React, { useEffect, useState } from 'react';
import { getSoldiers, getPosts, getUnavailabilities, getShiftsWithAssignments } from '@/services/api';
import { format, addDays } from 'date-fns';
import { notify } from '@/lib/notify';
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Users, Shield, TrendingUp, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Dashboard() {
  const [stats, setStats] = useState({ soldiers: 0, activePosts: 0, avgHistory: 0, availableNow: 0 });
  const [coverage, setCoverage] = useState({ total: 0, filled: 0 });
  const [fairnessData, setFairnessData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const today = new Date();
        const [sRes, pRes, uRes] = await Promise.all([getSoldiers(), getPosts(), getUnavailabilities()]);
        const sData = sRes.data;
        const pData = pRes.data;
        const now = Date.now();
        const unavailableNames = new Set(
          uRes.data
            .filter(u => new Date(u.start_datetime).getTime() <= now && new Date(u.end_datetime).getTime() > now)
            .map(u => u.soldier_name)
        );

        setStats({
          soldiers: sData.length,
          activePosts: pData.filter(p => p.is_active).length,
          avgHistory: sData.reduce((acc, s) => acc + s.history_score, 0) / (sData.length || 1),
          availableNow: sData.filter(s => !unavailableNames.has(s.name)).length,
        });

        const sorted = [...sData].sort((a, b) => b.history_score - a.history_score);
        setFairnessData(sorted.slice(0, 8));
        setLoading(false);

        // Coverage of the next 7 days: how many scheduled slots have someone assigned.
        const { data: slots } = await getShiftsWithAssignments(
          format(today, 'yyyy-MM-dd'), format(addDays(today, 7), 'yyyy-MM-dd')
        );
        setCoverage({ total: slots.length, filled: slots.filter(x => x.soldier_id).length });
      } catch (error) {
        console.error("Dashboard data fetch error:", error);
        notify.error("Could not load dashboard data.");
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const unfilled = coverage.total - coverage.filled;
  const coveragePct = coverage.total ? Math.round((coverage.filled / coverage.total) * 100) : 0;

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white">Shavtzachi Central</h2>
          <p className="text-muted-foreground text-base md:text-lg mt-1 md:mt-2">Operational readiness and workload distribution overview.</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Personnel"
          value={stats.soldiers}
          icon={Users}
          trend={`${stats.availableNow} available right now`}
          color="primary"
        />
        <StatCard
          title="Active Posts"
          value={stats.activePosts}
          icon={Shield}
          trend="Currently enabled"
          color="accent"
        />
        <StatCard
          title="Avg Workload"
          value={stats.avgHistory.toFixed(1)}
          icon={TrendingUp}
          trend="History score points"
          color="emerald"
        />
        <StatCard
          title="Next 7 Days"
          value={coverage.total ? `${coveragePct}%` : '—'}
          icon={AlertCircle}
          trend={coverage.total ? (unfilled ? `${unfilled} unfilled slot${unfilled === 1 ? '' : 's'}` : 'All slots filled') : 'No shifts scheduled'}
          color="blue"
        />
      </div>

      <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2">
        {/* Fairness Ledger Chart */}
        <Card className="glass border-none shadow-2xl">
          <CardHeader>
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-primary" />
              Workload Fairness Ledger
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {!loading && fairnessData.length === 0 && (
              <p className="text-sm text-muted-foreground">Add soldiers and save a schedule to see workload distribution.</p>
            )}
            {fairnessData.map((s, idx) => (
              <div key={s.id} className="space-y-2">
                <div className="flex justify-between text-sm items-center">
                  <span className="font-semibold">{s.name}</span>
                  <span className="font-mono text-muted-foreground">{(s.history_score || 0).toFixed(1)} pts</span>
                </div>
                <div className="h-3 w-full bg-muted/30 rounded-full overflow-hidden border border-white/5">
                  <div
                    className={cn(
                        "h-full transition-all duration-1000 ease-out",
                        idx === 0 ? "bg-intensity-high" : "bg-primary"
                    )}
                    style={{
                        width: `${Math.min(100, (s.history_score / (fairnessData[0]?.history_score || 1)) * 100)}%`,
                        transitionDelay: `${idx * 100}ms`
                    }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Coverage */}
        <Card className="glass border-none shadow-2xl bg-gradient-to-br from-card/50 to-background/50">
           <CardHeader>
             <CardTitle className="text-xl font-bold">Schedule Coverage</CardTitle>
           </CardHeader>
           <CardContent className="flex flex-col items-center justify-center py-10 space-y-6">
              <div className="relative w-48 h-48 flex items-center justify-center">
                 <svg className="w-full h-full transform -rotate-90" viewBox="0 0 192 192">
                    <circle cx="96" cy="96" r="88" className="stroke-muted/20 fill-none" strokeWidth="12" />
                    <circle
                        cx="96" cy="96" r="88"
                        className="stroke-primary fill-none transition-all duration-1000 ease-out"
                        strokeWidth="12"
                        strokeDasharray={552.92}
                        strokeDashoffset={552.92 * (1 - coveragePct / 100)}
                        strokeLinecap="round"
                    />
                 </svg>
                 <div className="absolute flex flex-col items-center">
                    <span className="text-4xl font-black">{coveragePct}%</span>
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">Filled</span>
                 </div>
              </div>
              <p className="text-center text-sm text-muted-foreground px-6 leading-relaxed">
                {coverage.total
                  ? <>{coverage.filled} of {coverage.total} slots in the next 7 days have someone assigned{unfilled ? <> — <span className="text-primary font-bold">{unfilled} still need to be scheduled</span>.</> : '.'}</>
                  : 'No shifts are scheduled for the next 7 days. Generate a schedule in the Scheduler.'}
              </p>
           </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, trend, color }) {
  const colors = {
    primary: "text-primary border-primary/20 bg-primary/5",
    accent: "text-accent-color border-accent-color/20 bg-accent-color/5",
    emerald: "text-intensity-low border-intensity-low/20 bg-intensity-low/5",
    blue: "text-blue-400 border-blue-400/20 bg-blue-400/5",
  };

  return (
    <Card className="glass border-none transition-all hover:translate-y-[-4px]">
      <CardContent className="p-6">
        <div className="flex justify-between items-start">
          <div className={cn("p-2 rounded-lg border", colors[color])}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
        <div className="mt-4 space-y-1">
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">{title}</h3>
          <p className="text-3xl font-black tabular-nums">{value}</p>
        </div>
        <div className="mt-4 text-[10px] font-bold text-muted-foreground/60 uppercase tracking-tighter">
          {trend}
        </div>
      </CardContent>
    </Card>
  );
}
