/**
 * The SpecOS mark: a sheet with its corner cut away, and the cut corner kept
 * beside it in the signal colour. The same clipped corner runs through every
 * icon and badge of the desktop.
 */
export function SpecOSMark({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.25 2H7l7 7v3.75c0 .7-.55 1.25-1.25 1.25h-9.5C2.55 14 2 13.45 2 12.75v-9.5C2 2.55 2.55 2 3.25 2z" fill="currentColor" />
      <path d="M9.4 2h3.6c.55 0 1 .45 1 1v3.6z" fill="var(--accent)" />
    </svg>
  );
}
