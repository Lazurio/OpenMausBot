import {
  Brain, CalendarClock, Database, FileText, Globe, Image, LayoutDashboard, ListChecks, Monitor, Newspaper, Plug,
  Search, Smartphone, Sparkles, SquareTerminal, Users, Wrench, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import type { TraceToolIcon } from "../../../shared/usage-trace";
import { BotAvatar } from "../Avatar";

const ICONS: Record<TraceToolIcon, LucideIcon> = {
  search: Search, web: Globe, browser: Globe, computer: Monitor, phone: Smartphone, files: FileText, terminal: SquareTerminal,
  memory: Brain, routine: CalendarClock, page: Newspaper, widget: LayoutDashboard, bots: Users, plan: ListChecks, image: Image,
  data: Database, mcp: Plug, tool: Wrench,
};

const BOX = "flex size-6 shrink-0 items-center justify-center rounded-md border border-hairline/50 bg-raised";

export function ToolIcon({ icon, error = false }: { icon: TraceToolIcon; error?: boolean }) {
  const Icon = ICONS[icon];
  return (
    <span className={BOX} aria-hidden>
      <Icon size={13} className={error ? "text-danger" : icon === "browser" || icon === "web" ? "text-accent" : "trace-tool-ink"} />
    </span>
  );
}

export function StepIcon() {
  return (
    <span className={cn(BOX, "trace-step-box")} aria-hidden>
      <Sparkles size={13} className="trace-step-ink" />
    </span>
  );
}

export function TurnAvatar({ bot, name }: { bot: Bot | undefined; name: string }) {
  if (bot) {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center">
        <BotAvatar bot={bot} size={24} state="idle" animated={false} />
      </span>
    );
  }
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-ink-secondary" aria-hidden>
      {(name || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}
