// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "cn"
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BotIcon,
  CalendarIcon,
  CheckIcon,
  GripVerticalIcon,
  KanbanIcon,
  Link2Icon,
  ListChecksIcon,
  ListIcon,
  PencilIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  UnlinkIcon,
  UserIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"

// Consistent 16px, stroke 1.5 icons for Projects screens (DESIGN.md §3.7).
const PROJECT_ICONS = {
  archive: ArchiveIcon,
  arrowDown: ArrowDownIcon,
  arrowUp: ArrowUpIcon,
  back: ArrowLeftIcon,
  board: KanbanIcon,
  bot: BotIcon,
  calendar: CalendarIcon,
  check: CheckIcon,
  checklist: ListChecksIcon,
  edit: PencilIcon,
  filters: SlidersHorizontalIcon,
  grip: GripVerticalIcon,
  link: Link2Icon,
  list: ListIcon,
  plus: PlusIcon,
  remove: XIcon,
  unlink: UnlinkIcon,
  user: UserIcon,
  users: UsersIcon,
} as const

type ProjectIconName = keyof typeof PROJECT_ICONS

function ProjectIcon({ name, className, ...props }: { name: ProjectIconName } & React.ComponentProps<"svg">) {
  const Icon = PROJECT_ICONS[name]
  return <Icon data-slot="project-icon" aria-hidden="true" strokeWidth={1.5} className={cn("size-4 shrink-0", className)} {...props} />
}

export { ProjectIcon, type ProjectIconName }
