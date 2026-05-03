import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { 
  BarChart3, 
  Users, 
  Settings as SettingsIcon, 
  Calendar, 
  LayoutDashboard,
  LogOut,
  CalendarX,
  ListChecks,
  Menu,
  X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const navItems = [
  { icon: BarChart3, label: 'Dashboard', path: '/' },
  { icon: Calendar, label: 'Scheduler', path: '/scheduler' },
  { icon: Users, label: 'Soldiers', path: '/soldiers' },
  { icon: ListChecks, label: 'Posts', path: '/posts' },
  { icon: CalendarX, label: 'Unavailability', path: '/unavailability' },
  { icon: SettingsIcon, label: 'Settings', path: '/settings' },
];

export default function Layout({ children }) {
  const location = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);

  // Close mobile menu when route changes
  React.useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex flex-col md:flex-row min-h-screen bg-background text-foreground">
      {/* Mobile Header */}
      <header className="md:hidden flex items-center justify-between p-4 border-b border-border bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <h1 className="text-xl font-bold tracking-tight text-primary flex items-center gap-2">
          <LayoutDashboard className="w-6 h-6" />
          Shavtzachi
        </h1>
        <Button 
          variant="ghost" 
          size="icon" 
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        >
          {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </Button>
      </header>

      {/* Sidebar - Desktop & Mobile Drawer */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-40 w-64 border-r border-border bg-card/50 backdrop-blur-xl flex flex-col transition-transform duration-300 ease-in-out md:translate-x-0 md:sticky md:h-screen",
        isMobileMenuOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="p-6 hidden md:block">
          <h1 className="text-2xl font-bold tracking-tight text-primary flex items-center gap-2">
            <LayoutDashboard className="w-8 h-8" />
            Shavtzachi
          </h1>
        </div>

        <nav className="flex-1 px-4 space-y-2 mt-4 md:mt-4">
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

        <div className="p-4 border-t border-border mt-auto">
          <Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground hover:text-destructive">
            <LogOut className="w-5 h-5" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Backdrop for mobile */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-30 md:hidden backdrop-blur-sm"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Main Content */}
      <main className="flex-1 p-4 md:p-8 overflow-y-auto">
        <div className="max-w-7xl mx-auto animate-in fade-in duration-500">
          {children}
        </div>
      </main>
    </div>
  );
}
