import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { 
  BarChart3, 
  Users, 
  Settings, 
  Calendar, 
  LayoutDashboard,
  LogOut,
  CalendarX
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const navItems = [
  { icon: BarChart3, label: 'Dashboard', path: '/' },
  { icon: Calendar, label: 'Scheduler', path: '/scheduler' },
  { icon: Users, label: 'Soldiers', path: '/soldiers' },
  { icon: Settings, label: 'Posts', path: '/posts' },
  { icon: CalendarX, label: 'Unavailability', path: '/unavailability' },
];

export default function Layout({ children }) {
  const location = useLocation();

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card/50 backdrop-blur-xl sticky top-0 h-screen flex flex-col">
        <div className="p-6">
          <h1 className="text-2xl font-bold tracking-tight text-primary flex items-center gap-2">
            <LayoutDashboard className="w-8 h-8" />
            Shavtzachi
          </h1>
        </div>

        <nav className="flex-1 px-4 space-y-2 mt-4">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group hover:bg-accent",
                location.pathname === item.path 
                  ? "bg-primary text-primary-foreground shadow-lg" 
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <item.icon className={cn(
                "w-5 h-5",
                location.pathname === item.path ? "text-primary-foreground" : "text-muted-foreground group-hover:text-foreground"
              )} />
              <span className="font-medium">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-border">
          <Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground hover:text-destructive">
            <LogOut className="w-5 h-5" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-y-auto">
        <div className="max-w-7xl mx-auto animate-in fade-in duration-500">
          {children}
        </div>
      </main>
    </div>
  );
}
