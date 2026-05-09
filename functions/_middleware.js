/**
 * Pages middleware — host-based routing
 *
 * michael.motethansen.com → /resume/
 * motethansen.com         → / (no change)
 */
export async function onRequest(context) {
  const url  = new URL(context.request.url);
  const host = url.hostname;

  if (host === "michael.motethansen.com" && url.pathname === "/") {
    return Response.redirect("https://michael.motethansen.com/resume/", 301);
  }

  return context.next();
}
