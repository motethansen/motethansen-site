/**
 * Pages middleware — host-based routing
 *
 * michael.motethansen.com  →  serves /resume/ content directly (no redirect)
 * motethansen.com          →  serves / as normal
 */
export async function onRequest(context) {
  const url  = new URL(context.request.url);
  const host = url.hostname;

  if (host === "michael.motethansen.com" && (url.pathname === "/" || url.pathname === "")) {
    // Internal rewrite — serve /resume/ without changing the URL in the browser
    const resumeUrl = new URL(context.request.url);
    resumeUrl.pathname = "/resume/";
    return context.env.ASSETS.fetch(new Request(resumeUrl.toString(), context.request));
  }

  return context.next();
}
