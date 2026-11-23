// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "cn"
import { ChevronDownIcon } from "lucide-react"

// A menu of actions opened from a button (#3601): the exports and the less used actions of a screen, so the header keeps one
// primary action. Arrow keys move between items, Enter or Space runs one, Escape closes it and focus returns to the trigger.
function Menu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />
}

// The trigger is the caller's Button (`render={<Button ... />}`), so it keeps the button look and sizes.
function MenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />
}

function MenuContent({ className, align = "end", sideOffset = 6, children, ...props }: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "align" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner align={align} sideOffset={sideOffset} className="isolate z-50 outline-none">
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            "min-w-48 max-w-[calc(100vw-2rem)] origin-(--transform-origin) rounded-lg bg-popover p-1 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none duration-100 motion-safe:data-open:animate-in motion-safe:data-open:fade-in-0 motion-safe:data-open:zoom-in-95 motion-safe:data-closed:animate-out motion-safe:data-closed:fade-out-0 motion-safe:data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

// A link as an item: pass `render={<Link ... />}`.
function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(
        "flex min-h-9 w-full cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

// The arrow after a trigger's label.
function MenuChevron() {
  return <ChevronDownIcon className="size-4 opacity-70" aria-hidden="true" data-slot="menu-chevron" />
}

export { Menu, MenuTrigger, MenuContent, MenuItem, MenuChevron }
