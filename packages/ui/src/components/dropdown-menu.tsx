// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "cn"
import { CheckIcon } from "lucide-react"

// A menu of actions or choices opened from a button (the org menu at the top of the sidebar, #3579), on Base UI's Menu:
// the arrow keys move between items, Enter or Space picks one, Escape or a click outside closes it, and focus goes back
// to the button. Items are 44px tall below md (touch) and 32px from md up.
function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

// The popup, placed next to the trigger. `container` is where it renders: inside a modal <dialog> (the phone drawer) the
// popup must be in that dialog, or the dialog's top layer covers it and makes it inert.
function DropdownMenuContent({
  className,
  container,
  align = "start",
  side = "bottom",
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Portal.Props, "container"> &
  Pick<MenuPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Positioner className="isolate z-50 outline-none" positionMethod="fixed" align={align} side={side} sideOffset={sideOffset}>
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "max-h-(--available-height) w-(--anchor-width) min-w-48 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-sm outline-none data-ending-style:opacity-0 data-starting-style:opacity-0 motion-safe:transition-opacity motion-safe:duration-100",
            className
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

const itemClass =
  "relative flex min-h-11 w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground md:min-h-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return <MenuPrimitive.Item data-slot="dropdown-menu-item" className={cn(itemClass, className)} {...props} />
}

// A link in the menu: render it as the router's link with `render`, so the menu closes and the router navigates.
function DropdownMenuLinkItem({ className, closeOnClick = true, ...props }: MenuPrimitive.LinkItem.Props) {
  return <MenuPrimitive.LinkItem data-slot="dropdown-menu-link-item" closeOnClick={closeOnClick} className={cn(itemClass, className)} {...props} />
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

// One choice of a radio group, checked when it is the group's value. The check mark sits on the right, so the names of
// the choices line up with the other items.
function DropdownMenuRadioItem({ className, children, closeOnClick = true, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem data-slot="dropdown-menu-radio-item" closeOnClick={closeOnClick} className={cn(itemClass, "pr-8", className)} {...props}>
      {children}
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" aria-hidden="true">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
    </MenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
}
