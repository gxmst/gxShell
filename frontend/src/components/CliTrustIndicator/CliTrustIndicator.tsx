import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { cliTrustDeadline, formatCliTrustRemaining, isCliTrustActive } from "../../utils/cliTrust";

export function CliTrustIndicator({ profile, locale, revoking, onRevoke }: {
  profile: types.Profile;
  locale: string;
  revoking: boolean;
  onRevoke: (profileID: string) => void;
}) {
  const [now, setNow] = useState(Date.now);
  const active = isCliTrustActive(profile, now);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!active) return null;
  const remaining = formatCliTrustRemaining(cliTrustDeadline(profile) - now);
  const title = [
    t(locale, "cliTrustIndicator", { remaining }),
    t(locale, "cliTrustIndicatorAction"),
    t(locale, "cliTrustRunningJobsHint"),
  ].join("\n");

  return (
    <button
      type="button"
      className="server-cli-trust-indicator"
      title={title}
      aria-label={title}
      disabled={revoking}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onRevoke(profile.id);
      }}
    >
      <AlertTriangle size={12} />
    </button>
  );
}
