/** Page chrome per site: <head> extras, header, footer and the article CSS. Keep each in step with the site it dresses. */

const motethansen = {
  headExtra: `<link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="theme-color" content="#fbfaf7">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
  <link rel="stylesheet" href="/style.css">`,
  bodyOpen: `<a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <nav class="nav" aria-label="Primary">
      <a class="nav__brand" href="/">
        <img class="nav__mark" src="/assets/img/logo-smartcity.png" alt="" width="512" height="512" decoding="async">
        <span class="nav__brand-text">Michael Motet Hansen</span>
      </a>
      <ul class="nav__links">
        <li><a href="/#projects">Projects</a></li>
        <li><a href="/#research">Research</a></li>
        <li><a href="/writing/">Writing</a></li>
        <li><a href="https://michael.motethansen.com" target="_blank" rel="noopener">Resume</a></li>
        <li><a href="/#contact">Contact</a></li>
      </ul>
    </nav>
  </header>
  <main id="main"><section class="section"><div class="container">`,
  bodyClose: (year) => `</div></section></main>
  <footer class="site-footer">
    <div class="container site-footer__inner">
      <p class="site-footer__copy">
        <img class="site-footer__mark" src="/assets/img/logo-smartcity.png" alt="" width="512" height="512" loading="lazy" decoding="async">
        <span>&copy; ${year} Michael Motet Hansen</span>
      </p>
      <ul class="site-footer__links">
        <li><a href="https://github.com/motethansen" target="_blank" rel="noopener">GitHub</a></li>
        <li><a href="https://mastodon.sg/@motethansen" target="_blank" rel="noopener me">Mastodon</a></li>
        <li><a href="https://orcid.org/0000-0001-7645-5958" target="_blank" rel="noopener">ORCID</a></li>
      </ul>
    </div>
  </footer>`,
  css: `
.article{max-width:720px;margin:0 auto}
.article__meta{color:var(--color-text-soft);margin:.4rem 0 1.6rem;font-size:.95rem}
.article__cover{width:100%;height:auto;border-radius:var(--radius);margin:0 0 2rem}
.article__body{font-size:1.08rem;line-height:1.75}
.article__body h2{margin:2.2rem 0 .8rem;font-size:1.5rem}
.article__body h3{margin:1.8rem 0 .6rem;font-size:1.2rem}
.article__body img{max-width:100%;height:auto;border-radius:8px}
.article__body blockquote{margin:1.4rem 0;padding:.2rem 1.2rem;border-left:3px solid var(--color-accent);color:var(--color-text-muted)}
.article__body pre{overflow-x:auto;padding:1rem;background:var(--color-bg-alt);border-radius:8px}
.article__body a{color:var(--color-accent)}
.article__tags{margin-top:2.4rem;color:var(--color-text-soft);font-size:.9rem}
.video{position:relative;aspect-ratio:16/9;margin:1.8rem 0}.video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:8px}`,
};

// vizneo.com is a Vite/React SPA with hashed asset names, so pages rendered here carry their own small stylesheet
// (same palette and fonts as the site's 404 page) and need only the logo from the site's assets.
const vizneo = {
  headExtra: `<link rel="icon" type="image/svg+xml" href="/vizneo_shape_logo_color.svg">
  <meta name="theme-color" content="#fafaf7">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap">
  <style>
  :root{--ink:#0b1220;--muted:#4b5563;--paper:#fafaf7;--navy:#0b2547;--line:#e4dfd0;--serif:"Fraunces",Georgia,serif;--sans:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
  *{box-sizing:border-box} body{margin:0;background:var(--paper);color:var(--ink);font:400 1.05rem/1.7 var(--sans)}
  a{color:var(--navy)} .wrap{max-width:760px;margin:0 auto;padding:0 1.25rem}
  .vh{border-bottom:1px solid var(--line);background:#fff} .vh .wrap{max-width:1100px;display:flex;align-items:center;gap:1.5rem;min-height:64px}
  .vh__brand{display:flex;align-items:center;gap:.6rem;font:600 1.15rem var(--serif);color:var(--navy);text-decoration:none}
  .vh__brand img{width:32px;height:32px} .vh nav{margin-left:auto;display:flex;gap:1.4rem;flex-wrap:wrap}
  .vh nav a{text-decoration:none;font-weight:500;color:var(--muted)} .vh nav a:hover{color:var(--navy)}
  main{padding:3rem 0 5rem} h1{font:600 clamp(2rem,5vw,2.9rem)/1.12 var(--serif);color:var(--navy);margin:.4rem 0 .6rem}
  .eyebrow{font:500 .78rem/1 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0}
  .article__meta{color:var(--muted);margin:0 0 1.8rem;font-size:.95rem}
  .article__cover{width:100%;height:auto;border-radius:12px;margin:0 0 2rem}
  .article__body h2{font:600 1.6rem/1.25 var(--serif);color:var(--navy);margin:2.4rem 0 .8rem}
  .article__body h3{font:600 1.25rem/1.3 var(--serif);color:var(--navy);margin:1.9rem 0 .6rem}
  .article__body img{max-width:100%;height:auto;border-radius:8px}
  .article__body blockquote{margin:1.5rem 0;padding:.1rem 1.2rem;border-left:3px solid var(--navy);color:var(--muted)}
  .article__body pre{overflow-x:auto;padding:1rem;background:#f1eee4;border-radius:8px}
  .article__tags{margin-top:2.4rem;color:var(--muted);font-size:.9rem}
  .video{position:relative;aspect-ratio:16/9;margin:1.8rem 0}.video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:8px}
  .list{list-style:none;padding:0;margin:2rem 0 0} .list li{padding:1.4rem 0;border-top:1px solid var(--line)}
  .list a.t{font:600 1.35rem/1.3 var(--serif);text-decoration:none} .list p{margin:.3rem 0 0;color:var(--muted)}
  .list .d{font-size:.88rem;color:var(--muted)}
  .vf{border-top:1px solid var(--line);padding:2rem 0;color:var(--muted);font-size:.92rem;text-align:center}
  </style>`,
  bodyOpen: `<header class="vh"><div class="wrap">
    <a class="vh__brand" href="/"><img src="/vizneo_shape_logo_color.svg" alt="" width="32" height="32"><span>Vizneo</span></a>
    <nav aria-label="Primary"><a href="/#about">About</a><a href="/#services">Services</a><a href="/#product">Product</a><a href="/writing/">Writing</a><a href="/#contact">Contact</a></nav>
  </div></header>
  <main id="main"><div class="wrap">`,
  bodyClose: (year) => `</div></main>
  <footer class="vf"><div class="wrap">&copy; ${year} Vizneo · <a href="/">vizneo.com</a></div></footer>`,
  css: "",
};

export const LAYOUTS = { motethansen, vizneo };
