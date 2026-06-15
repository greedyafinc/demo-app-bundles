"use client"

import * as React from "react"
import { ChevronRight, FileText, Folder, MessageSquare, Play, Plug, Users } from "lucide-react"

import { TeamSwitcher } from "@/components/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

const teams = [
  {
    name: "RowboatX",
    logo: Users,
    plan: "Workspace",
  },
]

type RowboatSummary = {
  agents: string[]
  config: string[]
  runs: string[]
}

type ResourceKind = "agent" | "config" | "run"

type SidebarSelect = (item: { kind: ResourceKind; name: string }) => void

type UnifiedStatus = {
  configured: boolean
  slug: string | null
  gateway: string
}

// Run logs are named `<iso-ish timestamp>-<seq>.jsonl`
// (e.g. 2026-06-11T16-37-31Z-0074374-000.jsonl); render them as friendly
// chat-history labels.
function runLabel(fileName: string): string {
  const m = fileName.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z/)
  if (!m) return fileName.replace(/\.jsonl$/, "")
  const [, y, mo, d, h, mi] = m
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi))
  if (Number.isNaN(date.getTime())) return fileName.replace(/\.jsonl$/, "")
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  onSelectResource?: SidebarSelect
}

export function AppSidebar({ onSelectResource, ...props }: AppSidebarProps) {
  const { state: sidebarState } = useSidebar()
  const [summary, setSummary] = React.useState<RowboatSummary>({
    agents: [],
    config: [],
    runs: [],
  })
  const [loading, setLoading] = React.useState(true)
  const [unified, setUnified] = React.useState<UnifiedStatus | null>(null)

  React.useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/rowboat/summary")
        if (!res.ok) return
        const data = await res.json()
        setSummary({
          agents: data.agents || [],
          config: data.config || [],
          runs: data.runs || [],
        })
      } catch (error) {
        console.error("Failed to load rowboat summary", error)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  React.useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/unified/status")
        if (!res.ok) return
        setUnified(await res.json())
      } catch {
        /* served outside the rowboatx server (e.g. next dev) — leave null */
      }
    }
    load()
  }, [])

  // Limit runs shown and provide "View more" affordance similar to chat history.
  const runsLimit = 8
  const visibleRuns = summary.runs.slice(0, runsLimit)
  const hasMoreRuns = summary.runs.length > runsLimit

  const handleSelect = (kind: ResourceKind, name: string) => {
    onSelectResource?.({ kind, name })
  }

  const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>({
    agents: false,
    config: false,
    runs: false,
  })

  const isCollapsed = sidebarState === "collapsed"

  React.useEffect(() => {
    if (isCollapsed) {
      setOpenGroups((prev) => {
        const closed: Record<string, boolean> = {}
        for (const key of Object.keys(prev)) closed[key] = false
        return closed
      })
    }
  }, [isCollapsed])

  const handleOpenChange = (key: string, next: boolean) => {
    if (isCollapsed) return
    setOpenGroups((prev) => ({ ...prev, [key]: next }))
  }

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={teams} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarMenu>
            <Collapsible
              className="group/collapsible"
              open={openGroups.agents}
              onOpenChange={(open) => handleOpenChange("agents", open)}
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton className="h-9">
                    <Folder className="mr-2 h-4 w-4" />
                    <span className="truncate">Agents</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
              </SidebarMenuItem>
              <CollapsibleContent asChild>
                <SidebarMenu className="pl-2">
                  {loading ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
                  ) : summary.agents.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No agents found</div>
                  ) : (
                    summary.agents.map((name) => (
                      <SidebarMenuItem key={name}>
                        <SidebarMenuButton
                          className="pl-8 h-8"
                          onClick={() => handleSelect("agent", name)}
                        >
                          <FileText className="mr-2 h-3.5 w-3.5" />
                          <span className="truncate">{name}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))
                  )}
                </SidebarMenu>
              </CollapsibleContent>
            </Collapsible>

            <Collapsible
              className="group/collapsible"
              open={openGroups.config}
              onOpenChange={(open) => handleOpenChange("config", open)}
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton className="h-9">
                    <Plug className="mr-2 h-4 w-4" />
                    <span className="truncate">Config</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
              </SidebarMenuItem>
              <CollapsibleContent asChild>
                <SidebarMenu className="pl-2">
                  {loading ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
                  ) : summary.config.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No config files</div>
                  ) : (
                    summary.config.map((name) => (
                      <SidebarMenuItem key={name}>
                        <SidebarMenuButton
                          className="pl-8 h-8"
                          onClick={() => handleSelect("config", name)}
                        >
                          <FileText className="mr-2 h-3.5 w-3.5" />
                          <span className="truncate">{name}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))
                  )}
                </SidebarMenu>
              </CollapsibleContent>
            </Collapsible>

            <Collapsible
              className="group/collapsible"
              open={openGroups.runs}
              onOpenChange={(open) => handleOpenChange("runs", open)}
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton className="h-9">
                    <Play className="mr-2 h-4 w-4" />
                    <span className="truncate">Runs</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
              </SidebarMenuItem>
              <CollapsibleContent asChild>
                <SidebarMenu className="pl-2">
                  {loading ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
                  ) : summary.runs.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No runs found</div>
                  ) : (
                    <>
                      {visibleRuns.map((name) => (
                        <SidebarMenuItem key={name}>
                          <SidebarMenuButton
                            className="pl-8 h-8"
                            onClick={() => handleSelect("run", name)}
                          >
                            <FileText className="mr-2 h-3.5 w-3.5" />
                            <span className="truncate">{name}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                      {hasMoreRuns && (
                        <SidebarMenuItem>
                          <SidebarMenuButton className="pl-8 h-8 text-muted-foreground">
                            <span className="truncate">View more…</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )}
                    </>
                  )}
                </SidebarMenu>
              </CollapsibleContent>
            </Collapsible>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Chat History</SidebarGroupLabel>
          <SidebarMenu>
            {loading ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
            ) : summary.runs.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No chats yet</div>
            ) : (
              visibleRuns.map((name) => (
                <SidebarMenuItem key={name}>
                  <SidebarMenuButton
                    className="h-8"
                    onClick={() => handleSelect("run", name)}
                  >
                    <MessageSquare className="mr-2 h-3.5 w-3.5" />
                    <span className="truncate">{runLabel(name)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:justify-center">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${unified?.configured ? "bg-emerald-500" : "bg-zinc-400"}`}
          />
          <span className="truncate group-data-[collapsible=icon]:hidden">
            {unified?.configured ? "Unified gateway · connected" : "Standalone · no gateway"}
          </span>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
