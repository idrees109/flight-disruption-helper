// api/disruption-helper.js
// Vercel Serverless Function

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Read secret keys from Vercel environment variables
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const FLIGHT_API_KEY = process.env.FLIGHT_API_KEY;   // AeroDataBox
  const PLACES_API_KEY = process.env.PLACES_API_KEY;   // (optional – for hotels later)

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Server is missing GEMINI_API_KEY. Check Vercel environment variables.",
    });
  }

  // Make sure we have a JSON body
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const {
    from = "",
    to = "",
    airline = "",
    flightNumber = "",
    flightDate = "",
    issueType = "",
    delayMinutes = null,
    cause = "",
    region = "",
    priority = "earliest",
    extraContext = "",
  } = body;

  // Basic fallback labels
  const disruptionType = issueType || "delay";
  const delayLabel =
    typeof delayMinutes === "number" && delayMinutes > 0
      ? `${delayMinutes} minutes`
      : "unknown / not provided";

  // ---------- 1) Build prompt for Gemini ----------
  const userSummary = `
Flight details:
- Route: ${from || "?"} → ${to || "?"}
- Airline: ${airline || "?"}
- Flight: ${flightNumber || "?"}
- Date: ${flightDate || "?"}

Disruption:
- Type: ${disruptionType}
- Reported delay: ${delayLabel}
- Cause (if known): ${cause || "not specified"}
- Region context: ${region || "let the assistant infer from route"}
- Traveller priority: ${priority}
- Extra context: ${extraContext || "none provided"}
`.trim();

  const systemInstructions = `
You are an assistant helping travellers understand typical airline disruption handling.

Given the structured context below, you MUST:
1. Provide a concise plain-language explanation of what likely happened and what typical rights/recourse might be, *without* giving legal or financial advice.
2. Focus on:
   - rebooking options,
   - refunds vs vouchers,
   - when compensation may or may not be possible,
   - what support (meals / hotels / transport) airlines often provide.
3. Make it clear that:
   - final decisions depend on the airline, booking conditions, and local law,
   - this is general educational guidance only.

Write in clear, simple English, 2–4 short paragraphs.
Do not use bullet points. No markdown headings. Just text.
`.trim();

  const promptText = `${systemInstructions}\n\nHere is the traveller's situation:\n\n${userSummary}`;

  let explanation = "";
  try {
    const geminiResp = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
        encodeURIComponent(GEMINI_API_KEY),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: promptText }],
            },
          ],
        }),
      }
    );

    if (!geminiResp.ok) {
      const text = await geminiResp.text();
      console.error("Gemini error:", geminiResp.status, text);
      throw new Error("Gemini API error");
    }

    const geminiJson = await geminiResp.json();
    const parts =
      geminiJson?.candidates?.[0]?.content?.parts || [];
    explanation = parts
      .map((p) => p.text || "")
      .join("\n")
      .trim();
  } catch (err) {
    console.error("Gemini call failed:", err);
    explanation =
      "We could not retrieve a detailed explanation from the AI right now. " +
      "Please try again later, or check your airline's website and local passenger rights information.";
  }

  // ---------- 2) Build simple eligibility label ----------
  let eligibilityLabel = "Unknown";
  let eligibilitySummary =
    "This is a general, non-legal explanation based on typical airline practice.";

  if (disruptionType === "cancellation") {
    eligibilityLabel = "Maybe";
    eligibilitySummary =
      "For cancellations, airlines often offer rebooking or a refund; compensation may depend on cause and local law.";
  } else if (disruptionType === "delay" && typeof delayMinutes === "number") {
    if (delayMinutes >= 180) {
      eligibilityLabel = "Maybe";
      eligibilitySummary =
        "Long delays can sometimes trigger compensation or extra support, depending on route, cause, and local rules.";
    } else if (delayMinutes >= 60) {
      eligibilityLabel = "Unlikely";
      eligibilitySummary =
        "Moderate delays may qualify for some support (meals, rebooking), but compensation is less common.";
    } else {
      eligibilityLabel = "Unlikely";
      eligibilitySummary =
        "Short delays usually do not qualify for compensation, though rebooking options may exist.";
    }
  }

  // ---------- 3) Return JSON in the format your frontend expects ----------
  const route =
    from && to ? `${from} → ${to}` : "";

  return res.status(200).json({
    status: {
      flightNumber,
      route,
      disruptionType,
      delayMinutes,
      scheduledDepartureLocal: null,
      actualDepartureLocal: null,
      scheduledArrivalLocal: null,
      estimatedArrivalLocal: null,
    },
    eligibility: {
      label: eligibilityLabel,
      type: "mixed",
      summary: eligibilitySummary,
    },
    explanation,
    options: [],  // we can ask Gemini to generate structured options later
    messages: [], // and draft messages later too
    hotels: [],   // and add Places-based suggestions later
  });
}
  console.log("Has keys?", {
    hasGemini: !!GEMINI_API_KEY,
    hasFlight: !!FLIGHT_API_KEY,
    hasPlaces: !!PLACES_API_KEY,
  });

