import * as React from "react"
import { cn } from "cn"

const STICKY_FIRST_COL =
  "[&_th:first-child:not([colspan])]:sticky [&_th:first-child:not([colspan])]:left-0 [&_th:first-child:not([colspan])]:z-20 " +
  "[&_th:first-child:not([colspan])]:bg-muted [&_th:first-child:not([colspan])]:shadow-[inset_-1px_0_0_var(--color-border),inset_0_-1px_0_var(--color-border)] " +
  "[&_tbody_td:first-child:not([colspan])]:sticky [&_tbody_td:first-child:not([colspan])]:left-0 [&_tbody_td:first-child:not([colspan])]:z-[5] " +
  "[&_tbody_td:first-child:not([colspan])]:bg-card [&_tbody_td:first-child:not([colspan])]:transition-colors " +
  "[&_tbody_tr:hover>td:first-child:not([colspan])]:bg-[color-mix(in_oklch,var(--card),var(--muted)_50%)] " +
  "[&_tbody_tr:has([aria-expanded='true'])>td:first-child:not([colspan])]:bg-[color-mix(in_oklch,var(--card),var(--muted)_50%)] " +
  "[&_tbody_tr[data-state='selected']>td:first-child:not([colspan])]:bg-muted " +
  "[&_tbody_td:first-child:not([colspan])]:shadow-[inset_-1px_0_0_var(--color-border)] " +
  "[&_tfoot_td:first-child:not([colspan])]:sticky [&_tfoot_td:first-child:not([colspan])]:left-0 [&_tfoot_td:first-child:not([colspan])]:z-[5] " +
  "[&_tfoot_td:first-child:not([colspan])]:bg-[color-mix(in_oklch,var(--card),var(--muted)_50%)] " +
  "[&_tfoot_td:first-child:not([colspan])]:shadow-[inset_-1px_0_0_var(--color-border)] " +
  "print:[&_th:first-child:not([colspan])]:static! print:[&_td:first-child:not([colspan])]:static!"

// `container` reaches the scrolling wrapper, e.g. to bound its height so a sticky header has something to stick in.
function Table({
  className,
  container,
  stickyFirstCol = false,
  ...props
}: React.ComponentProps<"table"> & { container?: React.ComponentProps<"div">; stickyFirstCol?: boolean }) {
  return (
    <div
      data-slot="table-container"
      {...container}
      className={cn("relative w-full overflow-x-auto", container?.className)}
    >
      <table
        data-slot="table"
        data-sticky-first-col={stickyFirstCol ? "" : undefined}
        className={cn("w-full caption-bottom text-sm", stickyFirstCol && STICKY_FIRST_COL, className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

// The last row drops only its bottom hairline, so a total's top rule on it stays (#2002).
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-b-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-1.5 align-middle text-sm whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
