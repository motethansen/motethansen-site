/** Sites served by this service. Add "vizneo" here once its page template exists. */
export const ENABLED_SITES = ["motethansen"];

export const SITES = {
  motethansen: { origin: "https://motethansen.com", name: "Michael Motet Hansen" },
};

/** The site a request is for, from the host the visitor used (the sites forward requests unchanged). */
export function siteOf(request) {
  const host = new URL(request.url).hostname;
  if (host === "vizneo.com" || host.endsWith(".vizneo.com")) return "vizneo";
  return "motethansen";
}
