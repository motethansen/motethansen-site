/** /admin and /admin/* -> the editor page, served by the shared articles service (one copy for every site). */
export const onRequest = ({ request, env }) => env.ARTICLES.fetch(request);
