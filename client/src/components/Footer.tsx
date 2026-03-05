export function Footer() {
  return (
    <footer className="pointer-events-none fixed inset-x-0 bottom-4 z-30 px-4">
      <div className="pointer-events-auto mx-auto hidden max-w-max items-center gap-4 rounded-full glass-panel px-4 py-2 text-xs text-muted-foreground lg:flex">
        <span className="section-kicker">HomeBrain</span>
        <span>Residence intelligence mesh online</span>
        <span className="status-dot h-2 w-2 rounded-full bg-cyan-400" />
        <span>Adaptive light and dark command surfaces active</span>
      </div>
    </footer>
  )
}
