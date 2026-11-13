/** /media/* -> uploaded article images, served from R2 by the articles service. */
export const onRequest = ({ request, env }) => env.ARTICLES.fetch(request);
