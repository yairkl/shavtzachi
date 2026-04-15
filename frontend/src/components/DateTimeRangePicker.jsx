import * as React from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon, Clock, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function DateTimeRangePicker({ 
  date, 
  setDate, 
  startTime, 
  setStartTime, 
  endTime, 
  setEndTime, 
  className,
  placeholder = "Select date range",
  allowClear = true
}) {
  const [isOpen, setIsOpen] = React.useState(false)
  const isSelecting = React.useRef(false)

  const handleOpenChange = (open) => {
    setIsOpen(open)
    if (open) {
      isSelecting.current = false
    }
  }

  return (
    <div className={cn("grid gap-2 relative group-picker", className)}>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <div className="relative">
          <PopoverTrigger asChild>
            <Button
              id="date"
              variant={"outline"}
              className={cn(
                "w-full justify-start text-left font-normal h-12 border-white/10 bg-white/5 rounded-xl text-sm font-bold pr-10",
                !date?.from && "text-muted-foreground"
              )}
            >
              <CalendarIcon className="mr-3 h-5 w-5 text-primary" />
              {date?.from ? (
                date.to ? (
                  <>
                    {format(date.from, "MMM dd, yyyy")} -{" "}
                    {format(date.to, "MMM dd, yyyy")}
                  </>
                ) : (
                  format(date.from, "MMM dd, yyyy")
                )
              ) : (
                <span>{placeholder}</span>
              )}
            </Button>
          </PopoverTrigger>
          {allowClear && date?.from && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg z-10"
              onClick={(e) => {
                e.stopPropagation();
                setDate({ from: undefined, to: undefined });
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <PopoverContent className="w-auto p-0 glass border-white/10 shadow-2xl backdrop-blur-2xl" align="center">
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={date?.from}
            selected={date}
            onSelect={(newRange, selectedDay) => {
              if (!isSelecting.current) {
                isSelecting.current = true
                setDate({ from: selectedDay, to: undefined })
              } else {
                isSelecting.current = false
                if (!newRange) {
                  setDate({ from: date?.from, to: selectedDay })
                } else if (newRange.from && !newRange.to) {
                  setDate({ from: newRange.from, to: selectedDay })
                } else {
                  setDate(newRange)
                }
                setIsOpen(false)
              }
            }}
            numberOfMonths={1}
          />
          <div className="p-4 border-t border-white/10 bg-background/50 rounded-b-md space-y-4">
             <div className="grid grid-cols-2 gap-4">
               <div className="space-y-2">
                 <Label className="text-[10px] uppercase font-black tracking-widest text-primary flex items-center gap-2"><Clock className="w-3 h-3" /> Activation Time</Label>
                 <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="bg-white/5 border-white/10 h-10 rounded-xl font-bold text-center w-full" />
               </div>
               <div className="space-y-2">
                 <Label className="text-[10px] uppercase font-black tracking-widest text-destructive flex items-center gap-2"><Clock className="w-3 h-3" /> Release Time</Label>
                 <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="bg-white/5 border-white/10 h-10 rounded-xl font-bold text-center w-full" />
               </div>
             </div>
             
             {allowClear && date?.from && (
               <Button 
                 variant="outline" 
                 size="sm" 
                 className="w-full h-8 text-[10px] font-black uppercase tracking-widest border-destructive/20 text-destructive hover:bg-destructive/10 hover:border-destructive/40"
                 onClick={() => {
                   setDate({ from: undefined, to: undefined });
                   setIsOpen(false);
                 }}
               >
                 Clear Range
               </Button>
             )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
