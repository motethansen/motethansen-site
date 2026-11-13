/** /api/ingest/* -> the articles service (bearer-token push of Substack posts from the mac-mini). */
export const onRequest = ({ request, env }) => env.ARTICLES.fetch(request);
