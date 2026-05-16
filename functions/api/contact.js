/**
 * POST /api/contact — contact form handler
 * Sends via Resend using RESEND_API_KEY + RESEND_FROM_EMAIL env vars
 * (set in Cloudflare Pages → Settings → Environment Variables).
 * Turnstile verification uses MOTETHANSEN_TURNSTILE_SECRET.
 */

const RECIPIENT = "hansenmichaelmotet@gmail.com";

export async function onRequestPost({ request, env }) {
  let name, email, message, turnstileToken;

  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    ({ name, email, message, turnstileToken } = await request.json());
  } else {
    const fd = await request.formData();
    name           = fd.get("name");
    email          = fd.get("email");
    message        = fd.get("message");
    turnstileToken = fd.get("cf-turnstile-response");
  }

  // Basic validation
  if (!name || !email || !message) {
    return jsonResponse({ success: false, error: "All fields are required." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ success: false, error: "Invalid email address." }, 400);
  }

  // Turnstile verification
  const turnstileSecret = env.MOTETHANSEN_TURNSTILE_SECRET;
  if (turnstileSecret) {
    if (!turnstileToken) {
      return jsonResponse({ success: false, error: "Security check required." }, 400);
    }
    const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: turnstileSecret, response: turnstileToken }),
    });
    const result = await verify.json();
    if (!result.success) {
      return jsonResponse({ success: false, error: "Security check failed. Please try again." }, 400);
    }
  }

  // Send via Resend
  const apiKey  = env.RESEND_API_KEY;
  const fromAddr = env.RESEND_FROM_EMAIL
    ? `Contact Form <${env.RESEND_FROM_EMAIL}>`
    : "Contact Form <noreply@vizneo.com>";

  if (apiKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from:     fromAddr,
          to:       [RECIPIENT],
          reply_to: email,
          subject:  `[motethansen.com] Message from ${name}`,
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
      }
    } catch (err) {
      console.error("Email send failed:", err);
    }
  } else {
    console.log("Contact form (no RESEND_API_KEY):", { name, email, message });
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
