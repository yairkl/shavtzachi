import * as React from "react"
import { Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function TimePicker({ value, onChange, className }) {
  const [hour, minute] = value.split(":")

  const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, "0"))
  const minutes = Array.from({ length: 12 }, (_, i) => (i * 5).toString().padStart(2, "0"))

  const handleHourChange = (newHour) => {
    onChange(`${newHour}:${minute}`)
  }

  const handleMinuteChange = (newMinute) => {
    onChange(`${hour}:${newMinute}`)
  }

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <div className="flex bg-white/5 border border-white/10 rounded-xl overflow-hidden h-10 items-center px-2 gap-1 transition-all hover:border-primary/50">
        <Clock className="w-3.5 h-3.5 text-primary opacity-60 mr-1" />
        
        <Select value={hour} onValueChange={handleHourChange}>
          <SelectTrigger className="border-none bg-transparent h-8 w-[50px] p-0 font-black text-sm focus:ring-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-zinc-950 border-white/10 text-white min-w-[60px] max-h-48 overflow-y-auto">
            {hours.map((h) => (
              <SelectItem key={h} value={h} className="text-xs font-bold">{h}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-white/20 font-black">:</span>

        <Select value={minute} onValueChange={handleMinuteChange}>
          <SelectTrigger className="border-none bg-transparent h-8 w-[50px] p-0 font-black text-sm focus:ring-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-zinc-950 border-white/10 text-white min-w-[60px] max-h-48 overflow-y-auto">
            {minutes.map((m) => (
              <SelectItem key={m} value={m} className="text-xs font-bold">{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
