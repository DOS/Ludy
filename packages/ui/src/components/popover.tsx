// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "cn"

// A small panel opened from a button (DESIGN.md 4.5, "Popover for small pickers"), on Base UI's Popover: the filters of a list sit
// in one, behind a button that shows how many are on. Focus moves into the panel, Escape or a click outside closes it, and focus
// goes back to the button. Unlike a menu it holds fields, so its content is the caller's own.
function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

// The panel, placed next to the trigger and never wider than the screen: 20rem from sm up, the screen less a 1rem gutter on a phone.
function PopoverContent({
  className,
  align = "end",
  side = "bottom",
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props & Pick<PopoverPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner className="isolate z-50 outline-none" positionMethod="fixed" align={align} side={side} sideOffset={sideOffset} collisionPadding={16}>
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "max-h-(--available-height) w-80 max-w-[calc(100vw-2rem)] origin-(--transform-origin) overflow-y-auto rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-sm outline-none data-ending-style:opacity-0 data-starting-style:opacity-0 motion-safe:transition-opacity motion-safe:duration-100",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return <PopoverPrimitive.Title data-slot="popover-title" className={cn("text-sm font-semibold text-foreground", className)} {...props} />
}

export { Popover, PopoverTrigger, PopoverContent, PopoverTitle }
