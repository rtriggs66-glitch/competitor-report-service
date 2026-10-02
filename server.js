const express = require("express");
const Stripe = require("stripe");
const PDFDocument = require("pdfkit");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Startup check: log any missing env vars so failures are obvious in Render logs
const requiredEnv = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "GOOGLE_API_KEY",
  "GOOGLE_CX",
  "GROQ_API_KEY",
  "BREVO_API_KEY",
];
const missingEnv = requiredEnv.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error("Missing env vars:", missingEnv.join(", "));
}
if (!process.env.BREVO_SENDER_EMAIL && !process.env.GMAIL_USER) {
  console.error(
    "Missing email sender: set BREVO_SENDER_EMAIL or GMAIL_USER to your Brevo-verified sender address."
  );
}

app.get("/", (req, res) => {
  res.send("Competitor report service is running.");
});

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature check failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    res.status(200).send("Received");

    if (event.type !== "checkout.session.completed") return;

    try {
      const session = event.data.object;
      const email = session.customer_details && session.customer_details.email;
      const businessName =
        (session.customer_details && session.customer_details.business_name) ||
        "the customer's business";
      const fields = session.custom_fields || [];
      const getField = (i) =>
        fields[i] && fields[i].text ? fields[i].text.value : "";
      const competitors = [getField(0), getField(1), getField(2)].filter(Boolean);
      const address = (session.customer_details && session.customer_details.address) || {};
      const location = [address.city, address.state, address.country]
        .filter(Boolean)
        .join(", ");

      console.log(`New order from ${email} for ${businessName}`);

      const searchResults = await Promise.all(
        competitors.map((name) => searchCompetitor(name, location))
      );
      const reportText = await writeReportWithGroq(businessName, competitors, searchResults);
      const pdfBuffer = await buildPdf(businessName, reportText);

      if (email) {
        await sendEmail(email, businessName, pdfBuffer);
        console.log(`Report emailed to ${email}`);
      } else {
        console.error("No customer email found on session; could not send.");
      }
    } catch (err) {
      console.error("Error processing order:", err);
    }
  }
);

app.use(express.json());

async function searchCompetitor(name, location) {
  // Search both web-wide and location-qualified so local AND online
  // competitors surface. Location comes from the Stripe billing address.
  const queries = [`"${name}"`];
  if (location) queries.push(`"${name}" ${location}`);
  const results = await Promise.all(queries.map((q) => googleSearch(q)));
  return results.join("\n");
}

async function googleSearch(query) {
  try {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", process.env.GOOGLE_API_KEY);
    url.searchParams.set("cx", process.env.GOOGLE_CX);
    url.searchParams.set("q", query);
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.items || data.items.length === 0) {
      return `No search results found for "${query}".`;
    }
    return data.items
      .slice(0, 5)
      .map((item) => `- ${item.title}: ${item.snippet} (${item.link})`)
      .join("\n");
  } catch (err) {
    console.error(`Google search failed for "${query}":`, err.message);
    return `Search unavailable for "${query}".`;
  }
}

async function writeReportWithGroq(businessName, competitors, searchResults) {
  const [c1 = "", c2 = "", c3 = ""] = competitors;
  const [r1 = "Not researched.", r2 = "Not researched.", r3 = "Not researched."] = searchResults;

  const prompt = `You are writing a competitor research report for a paying customer. The first half profiles each competitor. The second half is analysis — that analysis is what the customer is paying for, so make it sharp, specific, and impossible to mistake for a Google search summary.

Business being researched for: ${businessName}

Web search results for Competitor 1 (${c1 || "not provided"}):
${r1}

Web search results for Competitor 2 (${c2 || "not provided"}):
${r2}

Web search results for Competitor 3 (${c3 || "not provided"}):
${r3}

For EACH named competitor above (skip any competitor with no name — never invent a company), output:

## [Competitor name]

**Overview**
[What the company is and does]

**Pricing and offer**
[Their pricing model and flagship offers]

**What customers say**
[Common praise and complaints]

**Traffic and distribution**
[How they reach customers — cover BOTH local presence (physical stores, service area) AND online presence (website, app, delivery, social)]

After all competitors, output the analysis:

## Head-to-head comparison

For each dimension below, give one short, direct line per competitor in this exact format:

**Price point**
- [Competitor name]: [where they sit on price, with specifics]

**Signature offer**
- [Competitor name]: [what they lead with]

**Biggest strength**
- [Competitor name]: [the one thing they do best]

**Biggest weakness**
- [Competitor name]: [their most exploitable gap]

## Positioning gaps

[The gaps NONE of the competitors are covering — unmet customer needs, ignored audiences, weak local or online presence. Explain why each gap is an opening for ${businessName}.]

## Your 30-day action plan

[A numbered list of concrete moves ${businessName} can execute in the next 30 days — one action per line, each tied to a gap above. Quick wins first, bigger plays after. Each item: the action, then one line on why it works.]

Rules:
- Treat the web search results as your primary source — they are the most current information.
- Where the search results are thin, missing, or say "No search results found", fill the gap from your own knowledge of the company. Write a full, useful section anyway.
- Cover each competitor locally AND online: a neighborhood shop can still have a strong web presence, and a national brand can have a weak local footprint. Call out both.
- NEVER write "Not found in available sources", "recommend manual follow-up", "Not researched", or any placeholder text. Every section must contain real content.
- Be specific: names of products, approximate price points, and concrete observations beat generic statements.
- Every recommendation must trace back to a gap named in this report — no generic marketing advice.`;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await resp.json();
  if (!data.choices || !data.choices[0]) {
    console.error("Unexpected Groq response:", JSON.stringify(data));
    throw new Error("Groq did not return a report.");
  }
  return data.choices[0].message.content;
}

function buildPdf(businessName, reportText) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(22).fillColor("#04342C").text("Competitor report");
    doc.fontSize(12).fillColor("#0F6E56").text(`Prepared for ${businessName}`);
    doc.moveDown(1.5);
    doc.strokeColor("#0F6E56").moveTo(56, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(1);

    const lines = reportText.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("## ")) {
        doc.moveDown(0.7);
        doc.fontSize(15).fillColor("#04342C").text(trimmed.replace(/^##\s*/, ""));
        doc.moveDown(0.3);
      } else if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
        doc.fontSize(11.5).fillColor("#0F6E56").text(trimmed.replace(/\*\*/g, ""));
      } else if (trimmed.length > 0) {
        doc.fontSize(10.5).fillColor("#222222").text(trimmed);
      } else {
        doc.moveDown(0.4);
      }
    }
    doc.moveDown(1.5);
    doc.fontSize(8).fillColor("#888888").text("Compiled from web research and AI analysis.");
    doc.end();
  });
}

async function sendEmail(toEmail, businessName, pdfBuffer) {
  const senderEmail = process.env.BREVO_SENDER_EMAIL || process.env.GMAIL_USER;
  if (!senderEmail) {
    throw new Error(
      "Email sender not configured: set BREVO_SENDER_EMAIL or GMAIL_USER env var to your Brevo-verified sender address."
    );
  }

  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: {
        email: senderEmail,
        name: "Review Your Competition",
      },
      to: [{ email: toEmail }],
      subject: `Your competitor report for ${businessName}`,
      textContent:
        "Thanks for your order! Your competitor report is attached as a PDF.",
      attachment: [
        {
          content: pdfBuffer.toString("base64"),
          name: "Competitor-Report.pdf",
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("Brevo send failed:", resp.status, errText);
    throw new Error("Email send failed via Brevo.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
