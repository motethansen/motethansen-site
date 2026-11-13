/** /api/admin/* -> the shared articles service (sign-in, article CRUD, preview, image upload). */
export const onRequest = ({ request, env }) => env.ARTICLES.fetch(request);
