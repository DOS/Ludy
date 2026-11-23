// SPDX-License-Identifier: AGPL-3.0-only
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "group/switch peer relative inline-flex min-h-6 min-w-9 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none max-md:min-h-11 max-md:min-w-11 disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <span
        data-slot="switch-track"
        className="pointer-events-none inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-field-border bg-muted p-0.5 transition-colors group-focus-visible/switch:border-ring group-focus-visible/switch:ring-3 group-focus-visible/switch:ring-ring/50 group-aria-invalid/switch:border-destructive group-aria-invalid/switch:ring-3 group-aria-invalid/switch:ring-destructive/20 group-data-checked/switch:border-primary group-data-checked/switch:bg-primary dark:group-data-unchecked/switch:bg-input/30 dark:group-aria-invalid/switch:border-destructive/50 dark:group-aria-invalid/switch:ring-destructive/40"
      >
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          className="pointer-events-none block size-3.5 rounded-full bg-muted-foreground transition-transform data-checked:translate-x-4 data-checked:bg-primary-foreground"
        />
      </span>
    </SwitchPrimitive.Root>
  )
}

export { Switch }
