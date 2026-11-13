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
