import Link from "next/link";

/** Organization branding on meeting pages (paid plans), or the MeetSphere wordmark. */
export function Branding({ branding }: { branding: { displayName?: string; logoUrl?: string; accentColor?: string } | null }) {
  if (!branding) return <Link href="/"><strong>MeetSphere</strong></Link>;
  return (
    <div className="branding-bar">
      {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary customer logo URL */}
      {branding.logoUrl ? <img src={branding.logoUrl} alt="" /> : null}
      <strong style={branding.accentColor ? { color: branding.accentColor } : undefined}>{branding.displayName}</strong>
    </div>
  );
}
