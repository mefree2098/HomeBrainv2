import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border p-0.5 shadow-inner transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
      "border-slate-400/55 bg-slate-500/70 data-[state=unchecked]:!border-slate-400/55 data-[state=unchecked]:!bg-slate-500/70",
      "data-[state=checked]:!border-primary/80 data-[state=checked]:!bg-primary data-[state=checked]:shadow-[0_0_0_1px_hsl(var(--primary)_/_0.35),0_8px_22px_hsl(var(--primary)_/_0.24)]",
      "dark:border-white/20 dark:bg-slate-700/80 dark:data-[state=unchecked]:!border-white/20 dark:data-[state=unchecked]:!bg-slate-700/80 dark:data-[state=checked]:!border-primary/80 dark:data-[state=checked]:!bg-primary",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-6 w-6 rounded-full bg-white shadow-[0_6px_18px_rgba(0,0,0,0.22)] ring-0 transition-transform duration-300 dark:bg-slate-100 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
