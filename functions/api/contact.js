/**
 * POST /api/contact — contact form handler
 *
 * Forwards submissions to your inbox via Resend.
 * Set RESEND_API_KEY in Cloudflare Pages → Settings → Environment Variables.
 * Get a free key at https://resend.com (free tier: 3 000 emails/month).
 *
 * FROM address must be a verified domain in Resend.
 * Until you verify motethansen.com, use the Resend sandbox:
 *   from: "onboarding@resend.dev"
 */

const RECIPIENT = "hansenmichaelmotet@gmail.com";
const FROM      = "Contact Form <contact@motethansen.com>";

export async function onRequestPost({ request, env }) {
  let name, email, message;

  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    ({ name, email, message } = await request.json());
  } else {
    const fd = await request.formData();
    name    = fd.get("name");
    email   = fd.get("email");
    message = fd.get("message");
  }

  // Basic validation
  if (!name || !email || !message) {
    return jsonResponse({ success: false, error: "All fields are required." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ success: false, error: "Invalid email address." }, 400);
  }

  // Send via Resend if API key is configured
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM,
          to: [RECIPIENT],
          reply_to: email,
          subject: `[motethansen.com] Message from ${name}`,
          html: `
            <p><strong>Name:</strong> ${escHtml(name)}</p>
            <p><strong>Email:</strong> ${escHtml(email)}</p>
            <hr>
            <p>${escHtml(message).replace(/\n/g, "<br>")}</p>
          `,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error("Resend error:", res.status, body);
        // Still return success to the visitor — don't expose internals
      }
    } catch (err) {
      console.error("Email send failed:", err);
    }
  } else {
    // No API key configured yet — log so it's visible in Workers logs
    console.log("Contact form submission (no RESEND_API_KEY):", { name, email, message });
  }

  return jsonResponse({ success: true });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: corsHeaders(),
  });
}

// ── helpers ──────────────────────────────────────────

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
