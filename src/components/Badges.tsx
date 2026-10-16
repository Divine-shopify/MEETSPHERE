import { BADGE_LABELS } from "@/lib/client";

export function Badges({ badges }: { badges: string[] }) {
  return (
    <span className="row" style={{ gap: 4, display: "inline-flex" }}>
      {badges.map((b) => (
        <span key={b} className={`badge ${b}`}>
          {BADGE_LABELS[b] ?? b}
        </span>
      ))}
    </span>
  );
}
