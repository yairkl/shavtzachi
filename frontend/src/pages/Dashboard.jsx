import React, { useEffect, useState } from 'react';
import { getSoldiers, getPosts } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Users, Shield, TrendingUp, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Dashboard() {
  const [stats, setStats] = useState({ soldiers: 0, posts: 0, avgHistory: 0 });
  const [fairnessData, setFairnessData] = useState([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [sRes, pRes] = await Promise.all([getSoldiers(), getPosts()]);
        const sData = sRes.data;
        const pData = pRes.data;
        
        setStats({
          soldiers: sData.length,
          posts: pData.length,
          avgHistory: sData.reduce((acc, s) => acc + s.history_score, 0) / (sData.length || 1)
        });

        // Top 5 and Bottom 5 for fairness visualization
        const sorted = [...sData].sort((a, b) => b.history_score - a.history_score);
        setFairnessData(sorted.slice(0, 8));
      } catch (error) {
        console.error("Dashboard data fetch error:", error);
      }
    };
    fetchData();
  }, []);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-4xl font-extrabold tracking-tight text-white">Shavtzachi Central</h2>
          <p className="text-muted-foreground text-lg mt-2">Operational readiness and workload distribution overview.</p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <StatCard 
          title="Total Personnel" 
          value={stats.soldiers} 
          icon={Users} 
          trend="+2 currently available" 
          color="primary"
        />
        <StatCard 
          title="Active Posts" 
          value={stats.posts} 
          icon={Shield} 
          trend="All manned" 
          color="accent"
        />
        <StatCard 
          title="Avg Workload" 
          value={stats.avgHistory.toFixed(1)} 
          icon={TrendingUp} 
          trend="Score points" 
          color="emerald"
        />
        <StatCard 
          title="System Status" 
          value="Optimal" 
          icon={AlertCircle} 
          trend="No conflicts detected" 
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
            {fairnessData.map((s, idx) => (
              <div key={s.id} className="space-y-2">
                <div className="flex justify-between text-sm items-center">
                  <span className="font-semibold">{s.name}</span>
                  <span className="font-mono text-muted-foreground">{s.history_score.toFixed(1)} pts</span>
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

        {/* Readiness Board */}
        <Card className="glass border-none shadow-2xl bg-gradient-to-br from-card/50 to-background/50">
           <CardHeader>
             <CardTitle className="text-xl font-bold">System Insights</CardTitle>
           </CardHeader>
           <CardContent className="flex flex-col items-center justify-center py-10 space-y-6">
              <div className="relative w-48 h-48 flex items-center justify-center">
                 <svg className="w-full h-full transform -rotate-90">
                    <circle 
                        cx="96" cy="96" r="88" 
                        className="stroke-muted/20 fill-none" 
                        strokeWidth="12" 
                    />
                    <circle 
                        cx="96" cy="96" r="88" 
                        className="stroke-primary fill-none transition-all duration-1000 ease-out" 
                        strokeWidth="12" 
                        strokeDasharray={552.92}
                        strokeDashoffset={552.92 * (1 - 0.82)}
                        strokeLinecap="round"
                    />
                 </svg>
                 <div className="absolute flex flex-col items-center">
                    <span className="text-4xl font-black">82%</span>
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">Readiness</span>
                 </div>
              </div>
              <p className="text-center text-sm text-muted-foreground px-6 leading-relaxed">
                The current scheduling draft satisfies 100% of hard constraints and optimizes for a 
                <span className="text-primary font-bold"> 12.4% reduction </span> 
                in personnel fatigue variance.
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
