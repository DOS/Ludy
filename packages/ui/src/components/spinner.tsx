import { cn } from "cn"
import { Loader2Icon } from "lucide-react"
import { HEAVY_ICON_STROKE } from "./icon-defaults.tsx"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon data-slot="spinner" role="status" strokeWidth={HEAVY_ICON_STROKE} aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
