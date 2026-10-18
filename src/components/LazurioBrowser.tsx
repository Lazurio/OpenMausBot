/** The bot header's button, in Simple and Advanced alike, round in Simple mode's header. Its tooltip is its name. */
export function LazurioBrowserButton({ open, round = false }: { open: boolean; round?: boolean }) {
      className={cn(
        "relative",
        round ? "flex size-8 items-center justify-center rounded-full transition-colors hover:bg-ink/[0.06]" : "rounded-md p-1.5 hover:bg-raised",
        open ? "text-accent" : "text-ink-secondary hover:text-ink",
      )}