// Competitor Report Service
// Receives a Stripe payment webhook, researches the named competitors with
// real Google search results, writes a report with Groq (grounded only in
// those real results), builds a PDF, and emails it to the buyer.
//
// You do not need to understand this code to use it. Follow DEPLOY.md.

const express = require("express");
const Stripe = require("stripe");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

const app = express();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Health check (visit your deployed URL in a browser to see this) ----
app.get("/", (req, res) => {
  res.send("Competitor report service is running.");
});

// ---- Stripe webhook must receive the raw body for signature verification ----
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

    // Respond to Stripe immediately; do the slow work after.
    res.status(200).send("Received");

    if (event.type !== "checkout.session.completed") return;

    try {
      const session = event.data.object;
      const email = session.customer_details && session.customer_details.email;
      const fields = session.custom_fields || [];

      // Fields are read in the order you configured them in the Stripe
      // Payment Link: 0 = business name, 1-3 = competitors.
      const getField = (i) =>
        fields[i] && fields[i].text ? fields[i].text.value : "";

      const businessName = getField(0) || "the customer's business";
      const competitors = [getField(1), getField(2), getField(3)].filter(
        Boolean
      );

      console.log(`New order from ${email} for ${businessName}`);

      const searchResults = await Promise.all(
        competitors.map((name) => googleSearch(name))
      );

      const reportText = await writeReportWithGroq(
        businessName,
        competitors,
        searchResults
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

// Every other route can use normal JSON parsing.
app.use(express.json());

// ---- Step: real search per competitor ----
async function googleSearch(query) {
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
}

// ---- Step: Groq writes the report, grounded only in the search results ----
async function writeReportWithGroq(businessName, competitors, searchResults) {
  const [c1 = "", c2 = "", c3 = ""] = competitors;
  const [r1 = "Not researched.", r2 = "Not researched.", r3 = "Not researched."] =
    searchResults;

  const prompt = `You are writing a competitor research report using ONLY the search results provided below. Do not invent, assume, or fill in facts that aren't present in the results. If a section can't be supported by the search results, write exactly: "Not found in available sources — recommend manual follow-up."

Business being researched for: ${businessName}

Search results for Competitor 1 (${c1}):
${r1}

Search results for Competitor 2 (${c2}):
${r2}

Search results for Competitor 3 (${c3}):
${r3}

For EACH competitor, using only the search results above, output:

## [Competitor name]

**Overview**
[based on search results only]

**Pricing and offer**
[based on search results only, or 'Not found in available sources']

**What customers say**
[based on search results only, or 'Not found in available sources']

**Traffic and distribution**
[based on search results only, or 'Not found in available sources']

After all three competitors, output:

## Positioning gaps
[based only on patterns actually visible across the search results above]

## Recommendations
[3 numbered recommendations tied directly to the gaps above]`;

  const resp = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
      }),
    }
  );

  const data = await resp.json();
  if (!data.choices || !data.choices[0]) {
    console.error("Unexpected Groq response:", JSON.stringify(data));
    throw new Error("Groq did not return a report.");
  }
  return data.choices[0].message.content;
}

// ---- Step: turn the report text into a PDF ----
function buildPdf(businessName, reportText) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc
      .fontSize(22)
      .fillColor("#04342C")
      .text("Competitor report", { continued: false });
    doc
      .fontSize(12)
      .fillColor("#0F6E56")
      .text(`Prepared for ${businessName}`);
    doc.moveDown(1.5);
    doc.strokeColor("#0F6E56").moveTo(56, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(1);

    const lines = reportText.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("## ")) {
        doc.moveDown(0.7);
        doc
          .fontSize(15)
          .fillColor("#04342C")
          .text(trimmed.replace(/^##\s*/, ""), { underline: false });
        doc.moveDown(0.3);
      } else if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
        doc
          .fontSize(11.5)
          .fillColor("#0F6E56")
          .text(trimmed.replace(/\*\*/g, ""));
      } else if (trimmed.length > 0) {
        doc.fontSize(10.5).fillColor("#222222").text(trimmed);
      } else {
        doc.moveDown(0.4);
      }
    }

    doc.end();
  });
}

// ---- Step: email the PDF to the buyer ----
async function sendEmail(toEmail, businessName, pdfBuffer) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: `"Review Your Competition" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: `Your competitor report for ${businessName}`,
    text: "Thanks for your order! Your competitor report is attached as a PDF.",
    attachments: [
      {
        filename: "Competitor-Report.pdf",
        content: pdfBuffer,
      },
    ],
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
