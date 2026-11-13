/** Sites served by this service. A request's site comes from the host the visitor used (the sites forward it unchanged). */
export const ENABLED_SITES = ["motethansen", "vizneo"];

export const SITES = {
  motethansen: { origin: "https://motethansen.com", name: "Michael Motet Hansen", host: "motethansen.com" },
  vizneo: { origin: "https://vizneo.com", name: "Vizneo", host: "vizneo.com" },
};

export function siteOf(request) {
  const host = new URL(request.url).hostname;
  if (host === "vizneo.com" || host.endsWith(".vizneo.com")) return "vizneo";
  return "motethansen";
}

/**
 * Linked-out sources. The mac-mini names one of these in each push; the service decides what it means, so a
 * stolen token cannot publish onto a site that source is not configured for, or from an unexpected host.
 */
export const EXTERNAL_SOURCES = {
  "va-substack": { platform: "Substack", source: "Vizneo Academy", sites: ["motethansen", "vizneo"], host: /^vizneoacademy\.substack\.com$/ },
  "ulw-substack": { platform: "Substack", source: "Urban Life Works", sites: ["motethansen"], host: /^urbanlifeworks\.substack\.com$/ },
  "linkedin-legacy": { platform: "LinkedIn", source: "Michael Motet Hansen", sites: ["motethansen"], host: /^www\.linkedin\.com$/ },
};
