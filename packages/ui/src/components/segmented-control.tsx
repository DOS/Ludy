// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { cn } from "cn"

interface SegmentedControlContextValue {
  value: string
  onValueChange: (value: string) => void
  disabled: boolean
  size: "sm" | "default"
}

const SegmentedControlContext = React.createContext<SegmentedControlContextValue | null>(null)

export interface SegmentedControlProps<Value extends string = string> extends Omit<React.ComponentProps<"div">, "onChange"> {
  value: Value
  onValueChange: (value: Value) => void
  disabled?: boolean
  size?: "sm" | "default"
}

// A compact single-choice segmented toggle (DESIGN.md 4.6) using WAI-ARIA radiogroup semantics, 28-32px desktop
// height, 44x44px mobile hit targets under md, and arrow-key roving focus.
function SegmentedControl<Value extends string = string>({
  className,
  value,
  onValueChange,
  disabled = false,
  size = "default",
  onKeyDown,
  children,
  ...props
}: SegmentedControlProps<Value>) {
  const groupRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const root = groupRef.current
    if (!root) return
    const radios = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
    const active = radios.find((el) => el.getAttribute("aria-checked") === "true") ?? radios[0]
    for (const el of radios) el.tabIndex = el === active ? 0 : -1
  }, [value, disabled, children])

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented || disabled) return
    const root = groupRef.current
    if (!root) return
    const radios = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
    if (radios.length === 0) return
    const current = event.target instanceof HTMLElement ? radios.indexOf(event.target as HTMLButtonElement) : -1
    if (current === -1) return

    let nextIndex: number | null = null
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (current + 1) % radios.length
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (current - 1 + radios.length) % radios.length
    else if (event.key === "Home") nextIndex = 0
    else if (event.key === "End") nextIndex = radios.length - 1

    if (nextIndex === null) return
    event.preventDefault()
    const target = radios[nextIndex]
    if (!target) return
    target.focus()
    target.click()
  }

  const contextValue = React.useMemo<SegmentedControlContextValue>(
    () => ({
      value,
      onValueChange: (next) => onValueChange(next as Value),
      disabled,
      size,
    }),
    [value, onValueChange, disabled, size]
  )

  return (
    <SegmentedControlContext.Provider value={contextValue}>
      <div
        ref={groupRef}
        role="radiogroup"
        data-slot="segmented-control"
        data-size={size}
        aria-disabled={disabled || undefined}
        onKeyDown={handleKeyDown}
        className={cn(
          "inline-flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5 text-muted-foreground",
          size === "sm" ? "h-7 max-md:h-auto" : "h-8 max-md:h-auto",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </SegmentedControlContext.Provider>
  )
}

export interface SegmentedControlItemProps extends Omit<React.ComponentProps<"button">, "type" | "role" | "aria-checked"> {
  value: string
}

function SegmentedControlItem({ className, value, disabled: itemDisabled = false, onClick, children, ...props }: SegmentedControlItemProps) {
  const ctx = React.useContext(SegmentedControlContext)
  if (!ctx) throw new Error("SegmentedControlItem must be used inside SegmentedControl")

  const checked = ctx.value === value
  const isDisabled = ctx.disabled || itemDisabled

  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={isDisabled || undefined}
      disabled={isDisabled}
      tabIndex={checked ? 0 : -1}
      data-slot="segmented-control-item"
      data-value={value}
      data-state={checked ? "on" : "off"}
      data-active={checked ? "" : undefined}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented && !isDisabled && !checked) ctx.onValueChange(value)
      }}
      className={cn(
        "inline-flex items-center justify-center gap-1 rounded-md border border-transparent font-medium whitespace-nowrap outline-none select-none motion-safe:transition-[color,background-color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11 max-md:min-w-11 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        ctx.size === "sm" ? "h-6 min-w-7 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5" : "h-7 min-w-8 px-2.5 text-sm [&_svg:not([class*='size-'])]:size-4",
        checked ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export { SegmentedControl, SegmentedControlItem }
