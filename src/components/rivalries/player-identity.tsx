// Initial-letter avatar plus display name and @username. Used in every
// rivalry list row.
export function PlayerIdentity({
  displayName,
  username,
  detail,
}: {
  displayName: string;
  username: string;
  detail?: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-heading text-lg font-semibold uppercase"
      >
        {(displayName.trim()[0] ?? username[0] ?? "?").toUpperCase()}
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium">{displayName}</p>
        <p className="truncate text-sm text-muted-foreground">
          @{username}
          {detail ? ` · ${detail}` : ""}
        </p>
      </div>
    </div>
  );
}
