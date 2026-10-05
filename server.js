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
      const fields = session.custom_fields || [];
      const getField = (i) =>
        fields[i] && fields[i].text ? fields[i].text.value : "";
      // Intake: the customer describes THEIR business. Naming competitors
      // is optional (field 3) — discovery finds the rest, including the
      // ones they don't know exist.
      // Payment link field order: 1 business name, 2 what it does,
      // 3 competitors you already know (optional).
      const businessName =
        getField(0) ||
        (session.customer_details && session.customer_details.business_name) ||
        "the customer's business";
      const businessType = getField(1);
      // Optional: competitors the customer already knows (field 3,
      // comma-separated). Discovery still runs and fills remaining slots.
      const knownCompetitors = (getField(2) || "")
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3);
      const address = (session.customer_details && session.customer_details.address) || {};
      const location = [address.city, address.state, address.country]
        .filter(Boolean)
        .join(", ");

      console.log(
        `New order from ${email} for ${businessName} (${businessType || "type not given"}, ${location || "no location"})`
      );

      const discovered = await discoverCompetitors(businessType, location, businessName);
      const discoveryResults = discovered.discoveryResults;
      // Customer-named competitors first; discovery fills the rest (max 3).
      const seen = new Set();
      const names = [];
      for (const n of [...knownCompetitors, ...discovered.names]) {
        const key = n.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          names.push(n);
        }
      }
      names.splice(3);
      console.log(`Competitors for report: ${names.join(", ") || "(none)"}`);

      const searchResults = await Promise.all(
        names.map((name) => searchCompetitor(name, location))
      );
      const reportText = await writeReportWithGroq(
        businessName,
        businessType,
        location,
        names,
        searchResults,
        discoveryResults
      );
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

async function groqChat(prompt) {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await resp.json();
  if (!data.choices || !data.choices[0]) {
    console.error("Unexpected Groq response:", JSON.stringify(data));
    throw new Error("Groq did not return a response.");
  }
  return data.choices[0].message.content;
}

async function discoverCompetitors(businessType, location, businessName) {
  // Find who this business actually competes with — including competitors
  // the customer doesn't know exist — from live search results.
  const type = businessType || businessName;
  const queries = location
    ? [
        `best ${type} in ${location}`,
        `${type} near ${location}`,
        `top rated ${type} ${location}`,
      ]
    : [`best ${type}`, `${type} reviews`, `top ${type} companies`];
  const results = await Promise.all(queries.map((q) => googleSearch(q)));
  const discoveryResults = results.join("\n");

  const prompt = `A customer is starting a ${type}${location ? ` in ${location}` : ""}. From the web search results below, identify up to 3 real businesses they will compete with — the businesses a customer finds when looking for a ${type}${location ? ` in ${location}` : ""}.

Search results:
${discoveryResults}

Reply with ONLY a JSON array of up to 3 business names, like ["Name One", "Name Two", "Name Three"]. Rules:
- Only name businesses that actually appear in the search results.
- Do not include "${businessName}".
- If the results name fewer than 3, return only what you found. No other text.`;

  try {
    const text = await groqChat(prompt);
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const names = JSON.parse(match[0])
        .filter((n) => typeof n === "string" && n.trim().length > 0)
        .map((n) => n.trim())
        .slice(0, 3);
      if (names.length > 0) {
        console.log(`Discovered competitors: ${names.join(", ")}`);
        return { names, discoveryResults };
      }
    }
  } catch (err) {
    console.error("Competitor discovery failed:", err.message);
  }
  console.log(
    "Competitor discovery found no names; report will identify competitors from the market results."
  );
  return { names: [], discoveryResults };
}

async function writeReportWithGroq(
  businessName,
  businessType,
  location,
  competitors,
  searchResults,
  discoveryResults
) {
  const competitorBlocks =
    competitors.length > 0
      ? competitors
          .map(
            (name, i) =>
              `Competitor ${i + 1}: ${name}\nWeb search results:\n${searchResults[i] || "Not researched."}`
          )
          .join("\n\n")
      : "No competitor names were extracted from search. Identify the most relevant competitors from the market discovery results and your own knowledge of this market, and profile them.";

  const sharedContext = `Customer's business: ${businessName}
What it does: ${businessType || "(not stated — infer it from the business name and market context)"}
Market: ${location || "online / not specified"}

Market discovery search results (what customers find when they look for this kind of business in this market):
${discoveryResults}

Competitor research:
${competitorBlocks}`;

  const formatRules = `Formatting and quality rules:
- Plain characters only: write x for multiplication and - for ranges. No italics, no special symbols.
- Write money with commas, like $52,000.
- Treat the web search results as your primary source — they are the most current information.
- Where the search results are thin, missing, or say "No search results found", fill the gap from your own knowledge. Write a full, useful section anyway.
- Cover each competitor locally AND online: a neighborhood shop can still have a strong web presence, and a national brand can have a weak local footprint. Call out both.
- NEVER write "Not found in available sources", "recommend manual follow-up", "Not researched", or any placeholder text. Every section must contain real content.
- Be specific: names of products, approximate price points, and concrete observations beat generic statements.`;

  // Part 1: what the business could be worth + competitor profiles.
  const partOnePrompt = `You are writing part 1 of a competitor research report for a paying customer. The customer did NOT name their competitors — discovering who they are up against, including competitors they don't know exist, is the core of what they paid for. Part 1 shows them what their business could be worth, then profiles each competitor found for them.

${sharedContext}

Write ONLY these sections, in this order:

## What your business could be worth

Estimate what ${businessName} could earn, grounded in the competitor pricing and market signals in the research above.

**Year 1**
[A realistic first-year revenue RANGE for a new entrant. Show the math in plain language: typical price per customer, believable customers per week, weeks open. State every assumption you use.]

**Year 2 and beyond**
[How the range grows once reviews, repeat customers, and word of mouth build. Show the changed assumptions: more customers per week, repeat/referral share, any price increases.]

Rules for this section: always give ranges, never one exact figure; label these as estimates built on the stated assumptions; never promise or guarantee income.

## Your competitors

For EACH competitor in the research above, output:

## [Competitor name]

**Overview**
[What the company is and does]

**Pricing and offer**
[Their pricing model and flagship offers]

**What customers say**
[Common praise and complaints]

**Traffic and distribution**
[How they reach customers — cover BOTH local presence (physical stores, service area) AND online presence (website, app, delivery, social)]

${formatRules}`;

  // Part 2: the analysis — comparison, gaps, how to beat them, action plan.
  // Split into a second call so a long report never gets cut off.
  const partTwoPrompt = `You are writing part 2 of a competitor research report for ${businessName}. Part 1 (already written) estimated what the business could be worth and profiled each competitor. Part 2 is the analysis: how the competitors stack up, where the openings are, how to beat them, and what to do in the next 30 days. Make it sharp, specific, and impossible to mistake for a Google search summary.

${sharedContext}

Write ONLY these sections, in this order:

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

## How you beat them

[The specific moves that would make ${businessName} better than the competition: an offer none of them have, an audience they ignore, an experience they do badly, a channel they neglect. For each move: what it is, which competitor weakness it exploits, and why customers would switch. This is the section the customer reads twice.]

## Your 30-day action plan

[A numbered list of concrete moves ${businessName} can execute in the next 30 days — one action per line, each tied to a gap or a "how you beat them" move above. Quick wins first, bigger plays after. Each item: the action, then one line on why it works.]

Rules:
- Every recommendation must trace back to a competitor weakness or a gap named in this report — no generic marketing advice.
${formatRules}`;

  const partOne = await groqChat(partOnePrompt);
  const partTwo = await groqChat(partTwoPrompt);
  return `${partOne}\n\n${partTwo}`;
}

function printRichText(doc, text) {
  // Groq writes **bold** spans. Print the bold segments with the bold
  // font instead of letting the asterisks show in the PDF. Also swap
  // special symbols for plain characters the PDF font renders cleanly.
  const segments = text
    .split("**")
    .map((part, i) => ({
      part: part
        .replace(/×/g, "x")
        .replace(/[–—]/g, "-")
        .replace(/\*/g, ""),
      bold: i % 2 === 1,
    }))
    .filter((seg) => seg.part.length > 0);
  segments.forEach((seg, i) => {
    doc.font(seg.bold ? "Helvetica-Bold" : "Helvetica");
    doc.text(seg.part, { continued: i < segments.length - 1 });
  });
  doc.font("Helvetica");
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
        doc.fontSize(10.5).fillColor("#222222");
        printRichText(doc, trimmed);
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
