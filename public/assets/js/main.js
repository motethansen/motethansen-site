/* =========================================================================
   motethansen.com — main.js
   Fetches /api/orcid and /api/feeds on page load and injects results into
   placeholder sections. Always falls back to static markup on failure.
   ========================================================================= */

(function () {
  "use strict";

  const ENDPOINTS = {
    orcid: "/api/orcid",
    feeds: "/api/feeds",
  };

  const FETCH_TIMEOUT_MS = 6000;

  /* ---------- utilities ---------- */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.startsWith("on") && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else {
          node.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children])
        .filter(Boolean)
        .forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    }
    return node;
  }

  function fetchJSON(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .finally(() => clearTimeout(timer));
  }

  function markLoaded(container, opts) {
    if (!container) return;
    container.setAttribute("data-loading", "false");
    if (opts && opts.error) container.setAttribute("data-error", "true");
  }

  function clearRendered(container) {
    // Remove anything we previously rendered (keeps loading + fallback nodes intact).
    container.querySelectorAll(":scope > [data-rendered]").forEach((n) => n.remove());
  }

  function formatDate(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
  }

  function truncate(text, max) {
    if (!text) return "";
    const t = text.trim().replace(/\s+/g, " ");
    return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
  }

  /* ---------- renderers ---------- */

  function renderResearch(container, items) {
    if (!Array.isArray(items) || items.length === 0) throw new Error("No research items");
    const grid = el("div", { class: "feed__fallback", "data-rendered": "true" });
    items.slice(0, 4).forEach((item) => {
      grid.appendChild(
        el("article", { class: "research-card" }, [
          el("p", { class: "research-card__meta", text: item.meta || item.type || "Research" }),
          el("h3", { class: "research-card__title", text: item.title || "Untitled" }),
          item.summary ? el("p", { class: "research-card__body", text: truncate(item.summary, 220) }) : null,
        ])
      );
    });
    clearRendered(container);
    container.appendChild(grid);
  }

  function renderPublications(container, items) {
    if (!Array.isArray(items) || items.length === 0) throw new Error("No publications");
    const list = el("ol", { class: "pub-list", "data-rendered": "true" });
    items.slice(0, 12).forEach((p) => {
      const meta = [p.type, p.year].filter(Boolean).join(" · ") || "Publication";
      const titleNode = p.url
        ? el("a", { href: p.url, target: "_blank", rel: "noopener", text: p.title || "Untitled" })
        : document.createTextNode(p.title || "Untitled");
      list.appendChild(
        el("li", { class: "pub" }, [
          el("p", { class: "pub__meta", text: meta }),
          el("div", {}, [
            el("h3", { class: "pub__title" }, [titleNode]),
            p.authors ? el("p", { class: "pub__authors", text: p.authors }) : null,
          ]),
        ])
      );
    });
    clearRendered(container);
    container.appendChild(list);
  }

  function renderWritingFeed(container, items) {
    if (!Array.isArray(items) || items.length === 0) throw new Error("No writing items");
    const wrap = el("div", { class: "writing-cards", "data-rendered": "true" });
    items.slice(0, 4).forEach((item) => {
      const sourceLabel = item.source || (item.url && /substack/i.test(item.url) ? "Substack" : "Medium");
      const titleText = item.title || "Untitled";
      const card = el("article", { class: "writing-card" }, [
        el("p", { class: "writing-card__meta", text: sourceLabel }),
        el(
          "h4",
          { class: "writing-card__title" },
          item.url
            ? [el("a", { href: item.url, target: "_blank", rel: "noopener", text: titleText })]
            : [document.createTextNode(titleText)]
        ),
        item.excerpt ? el("p", { class: "writing-card__excerpt", text: truncate(item.excerpt, 180) }) : null,
        item.date ? el("p", { class: "writing-card__date", text: formatDate(item.date) }) : null,
      ]);
      wrap.appendChild(card);
    });
    clearRendered(container);
    container.appendChild(wrap);
  }

  /* ---------- loaders ---------- */

  function loadOrcid() {
    const research = document.getElementById("research");
    const publications = document.getElementById("publications");

    fetchJSON(ENDPOINTS.orcid)
      .then((data) => {
        try {
          renderResearch(research, data && data.projects);
          markLoaded(research);
        } catch (e) {
          markLoaded(research, { error: true });
        }
        try {
          renderPublications(publications, data && data.publications);
          markLoaded(publications);
        } catch (e) {
          markLoaded(publications, { error: true });
        }
      })
      .catch(() => {
        markLoaded(research, { error: true });
        markLoaded(publications, { error: true });
      });
  }

  function loadFeeds() {
    const groups = [
      { id: "writing-urbanlife", key: "urbanlife" },
      { id: "writing-vizneo", key: "vizneo" },
    ];

    fetchJSON(ENDPOINTS.feeds)
      .then((data) => {
        groups.forEach((g) => {
          const container = document.getElementById(g.id);
          if (!container) return;
          try {
            const items = data && data[g.key];
            renderWritingFeed(container, items);
            markLoaded(container);
          } catch (e) {
            markLoaded(container, { error: true });
          }
        });
      })
      .catch(() => {
        groups.forEach((g) => markLoaded(document.getElementById(g.id), { error: true }));
      });
  }

  /* ---------- boot ---------- */

  function init() {
    loadOrcid();
    loadFeeds();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
