import * as React from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon, Clock } from "lucide-react"

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

export function DateTimeRangePicker({ date, setDate, startTime, setStartTime, endTime, setEndTime, className }) {
  const [isOpen, setIsOpen] = React.useState(false)
  const isSelecting = React.useRef(false)

  const handleOpenChange = (open) => {
    setIsOpen(open)
    if (open) {
      isSelecting.current = false
    }
  }

  return (
    <div className={cn("grid gap-2", className)}>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            id="date"
            variant={"outline"}
            className={cn(
              "w-full justify-start text-left font-normal h-12 border-white/10 bg-white/5 rounded-xl text-sm font-bold",
              !date && "text-muted-foreground"
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
              <span>Select date range</span>
            )}
          </Button>
        </PopoverTrigger>
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
          <div className="p-4 border-t border-white/10 grid grid-cols-2 gap-4 bg-background/50 rounded-b-md">
             <div className="space-y-2">
               <Label className="text-[10px] uppercase font-black tracking-widest text-primary flex items-center gap-2"><Clock className="w-3 h-3" /> Activation Time</Label>
               <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="bg-white/5 border-white/10 h-10 rounded-xl font-bold text-center w-full" />
             </div>
             <div className="space-y-2">
               <Label className="text-[10px] uppercase font-black tracking-widest text-destructive flex items-center gap-2"><Clock className="w-3 h-3" /> Release Time</Label>
               <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="bg-white/5 border-white/10 h-10 rounded-xl font-bold text-center w-full" />
             </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
