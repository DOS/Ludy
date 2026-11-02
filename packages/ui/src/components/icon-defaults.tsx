// SPDX-License-Identifier: AGPL-3.0-only
// The stroke of every lucide icon (DESIGN.md 3.7): 1.5, set once for the whole app by wrapping its root in
// <IconDefaults>, so an icon that names no strokeWidth of its own draws at 1.5 and no screen sets it file by file. The
// named exceptions are spinners and check marks, which draw heavier so they stay legible when small; they name
// HEAVY_ICON_STROKE themselves. The marketing site cannot use a client provider (its sections ship no client
// JavaScript) and holds the same default in its stylesheet (apps/web/src/app/globals.css).
import { LucideProvider } from "lucide-react"
import type { ReactNode } from "react"

export const ICON_STROKE = 1.5
export const HEAVY_ICON_STROKE = 2

function IconDefaults({ children }: { children: ReactNode }) {
  return <LucideProvider strokeWidth={ICON_STROKE}>{children}</LucideProvider>
}

export { IconDefaults }
