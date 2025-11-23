// api/disruption-helper.js
// Vercel serverless function for Flight Disruption Helper

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1) Read secret keys from Vercel env vars
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const FLIGHT_API_KEY = process.env.FLIGHT_API_KEY;
  const PLACES_API_KEY = process.env.PLACES_API_KEY; // not yet used, for hotels later

  // Debug (only visible in Vercel logs)
  console.log("Has keys?", {
    hasGemini: !!GEMINI_API_KEY,
    hasFlight: !!FLIGHT_API_KEY,
    hasPlaces: !!PLACES_API_KEY,
  });

  // 2) Parse JSON body safely
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      console.error("Failed to parse body JSON", e);
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

  // 3) Try to get real status from AeroDataBox (if configured)
  let disruptionType = issueType || "delay";
  let effectiveDelay = delayMinutes;
  let statusSource = "user"; // default
  let adbStatus = null;

  if (FLIGHT_API_KEY && flightNumber && flightDate) {
    adbStatus = await fetchFlightStatusFromAeroDataBox({
      flightNumber,
      flightDate,
      FLIGHT_API_KEY,
    });

    if (adbStatus) {
      statusSource = "aerodatabox";
      if (adbStatus.disruptionType) {
        disruptionType = adbStatus.disruptionType;
      }
      if (typeof adbStatus.delayMinutes === "number") {
        effectiveDelay = adbStatus.delayMinutes;
      }
    }
  }

  // 4) Build a simple eligibility label & summary
  const elig = buildEligibility(disruptionType, effectiveDelay);

  // 5) Ask Gemini for explanation (if key present)
  const explanation = await buildExplanationWithGemini({
    GEMINI_API_KEY,
    from,
    to,
    airline,
    flightNumber,
    flightDate,
    disruptionType,
    effectiveDelay,
    cause,
    region,
    priority,
    extraContext,
    statusSource,
  });

  const route =
    from && to ? `${from} → ${to}` : "";

  // 6) Return JSON in the format your frontend expects
  return res.status(200).json({
    status: {
      flightNumber,
      route,
      disruptionType,
      delayMinutes: effectiveDelay,
      scheduledDepartureLocal: adbStatus?.scheduledDepartureLocal || null,
      actualDepartureLocal: adbStatus?.actualDepartureLocal || null,
      scheduledArrivalLocal: adbStatus?.scheduledArrivalLocal || null,
      estimatedArrivalLocal: adbStatus?.estimatedArrivalLocal || null,
      source: statusSource, // 👈 tell frontend whether this is "user" or "aerodatabox"
    },
    eligibility: elig,
    explanation,
    options: [],  // we can add structured options later
    messages: [], // and draft messages later
    hotels: [],   // and hotels later (using PLACES_API_KEY)
  });
}

/**
 * Fetch flight status from AeroDataBox via api.market.
 * Returns null if anything fails.
 */
async function fetchFlightStatusFromAeroDataBox({
  flightNumber,
  flightDate,
  FLIGHT_API_KEY,
}) {
  if (!flightNumber || !flightDate || !FLIGHT_API_KEY) return null;

  try {
    // 🔴 TODO: Replace this URL and header name with the EXACT ones from api.market AeroDataBox docs.
    //
    // Go to api.market → AeroDataBox API → "API Documentation".
    // Find the endpoint for "flight by number & date".
    // It will show something like:
    //   GET https://prod.api.market/.../flights/number/{flightNumber}/{date}
    //
    // Put that full URL here, using flightNumber and flightDate.
    const url = `https://prod.api.market/REPLACE/THIS/PATH/with/aerodatabox/flights/number/${encodeURIComponent(
      flightNumber
    )}/${encodeURIComponent(flightDate)}`;

    // Also check the header name in the docs: e.g. "x-api-key" or "x-apimarket-key".
    const resp = await fetch(url, {
      headers: {
        "x-api-key": FLIGHT_API_KEY, // 🔴 change header name if docs say something else
      },
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error("AeroDataBox HTTP error", resp.status, txt);
      return null;
    }

    const data = await resp.json();
    console.log("AeroDataBox raw data:", JSON.stringify(data));

    // Some endpoints return { departures: [...] } or { arrivals: [...] } or an array.
    let flight = null;
    if (Array.isArray(data)) {
      flight = data[0] || null;
    } else if (Array.isArray(data.flights)) {
      flight = data.flights[0] || null;
    } else if (Array.isArray(data.departures)) {
      flight = data.departures[0] || null;
    } else if (Array.isArray(data.arrivals)) {
      flight = data.arrivals[0] || null;
    } else {
      flight = data;
    }

    if (!flight) {
      console.warn("AeroDataBox: no flight object found");
      return null;
    }

    const dep = flight.departure || flight.departureTime || {};
    const arr = flight.arrival || flight.arrivalTime || {};

    const scheduledDep = dep.scheduledTimeLocal || dep.scheduled || null;
    const actualDep =
      dep.actualTimeLocal ||
      dep.estimatedTimeLocal ||
      dep.revisedTimeLocal ||
      dep.actual ||
      dep.estimated ||
      null;

    const scheduledArr = arr.scheduledTimeLocal || arr.scheduled || null;
    const estimatedArr =
      arr.actualTimeLocal ||
      arr.estimatedTimeLocal ||
      arr.revisedTimeLocal ||
      arr.actual ||
      arr.estimated ||
      null;

    // Compute delay in minutes if we have both times
    let delayMinutes = null;
    if (scheduledDep && actualDep) {
      const sched = new Date(scheduledDep);
      const act = new Date(actualDep);
      if (!isNaN(sched.getTime()) && !isNaN(act.getTime())) {
        delayMinutes = Math.round((act - sched) / 60000);
      }
    }

    // Basic disruption classification from status + delay
    let disruptionType = "none";
    const statusText = (flight.status || flight.flightStatus || "").toLowerCase();
    if (statusText.includes("cancel")) {
      disruptionType = "cancellation";
    } else if (delayMinutes !== null && delayMinutes > 0) {
      disruptionType = "delay";
    }

    return {
      disruptionType,
      delayMinutes,
      scheduledDepartureLocal: scheduledDep || null,
      actualDepartureLocal: actualDep || null,
      scheduledArrivalLocal: scheduledArr || null,
      estimatedArrivalLocal: estimatedArr || null,
    };
  } catch (err) {
    console.error("AeroDataBox fetch failed", err);
    return null;
  }
}

/**
 * Very simple eligibility logic based on disruption type + delay.
 */
function buildEligibility(disruptionType, delayMinutes) {
  let label = "Unknown";
  let summary =
    "This is general, non-legal guidance based on typical airline practice.";

  if (disruptionType === "cancellation") {
    label = "Maybe";
    summary =
      "For cancellations, airlines often offer rebooking or a refund; compensation may depend on cause and local law.";
  } else if (disruptionType === "delay" && typeof delayMinutes === "number") {
    if (delayMinutes >= 180) {
      label = "Maybe";
      summary =
        "Long delays can sometimes trigger compensation or extra support, depending on route, cause, and local rules.";
    } else if (delayMinutes >= 60) {
      label = "Unlikely";
      summary =
        "Moderate delays may qualify for some support (meals, rebooking), but compensation is less common.";
    } else {
      label = "Unlikely";
      summary =
        "Short delays usually do not qualify for compensation, though rebooking options may exist.";
    }
  }

  return {
    label,
    type: "mixed",
    summary,
  };
}

/**
 * Call Gemini to generate the explanation text.
 */
async function buildExplanationWithGemini(params) {
  const {
    GEMINI_API_KEY,
    from,
    to,
    airline,
    flightNumber,
    flightDate,
    disruptionType,
    effectiveDelay,
    cause,
    region,
    priority,
    extraContext,
    statusSource,
  } = params;

  if (!GEMINI_API_KEY) {
    return (
      "We could not retrieve a detailed explanation from the AI right now. " +
      "Please check your airline's website and local passenger rights information."
    );
  }

  const delayLabel =
    typeof effectiveDelay === "number" && effectiveDelay > 0
      ? `${effectiveDelay} minutes`
      : "unknown / not provided";

  const userSummary = `
Flight details:
- Route: ${from || "?"} → ${to || "?"}
- Airline (user-provided, do not change name): ${airline || "?"}
- Flight: ${flightNumber || "?"}
- Date: ${flightDate || "?"}

Status information:
- Source: ${statusSource === "aerodatabox" ? "flight API (AeroDataBox via api.market)" : "what the user typed"}
- Disruption type: ${disruptionType}
- Reported / calculated delay: ${delayLabel}

Other context:
- Cause (if known): ${cause || "not specified"}
- Region context: ${region || "let the assistant infer from route"}
- Traveller priority: ${priority}
- Extra context: ${extraContext || "none provided"}
`.trim();

  const systemInstructions = `
You are an assistant helping travellers understand typical airline disruption handling.

Given the structured context below, you MUST:
1. Provide a concise plain-language explanation of what the traveller can typically expect (rebooking, support, compensation).
2. Make it crystal clear that:
   - you cannot give legal or financial advice,
   - final decisions depend on the airline, booking conditions, and local law,
   - local passenger-rights regulations may apply (e.g. EU261/UK261) but you do not know the exact jurisdiction.
3. Do NOT invent or guess:
   - specific causes of the delay,
   - internal airline decisions,
   - exact amounts of compensation.
   Instead, use language like "may", "could", "often", "typically".
4. Use the airline name exactly as provided in the context. Do not change or guess the airline.
5. Write in clear, simple English, 2–4 short paragraphs. No bullet points, no headings.
`.trim();

  const promptText = `${systemInstructions}\n\nHere is the traveller's situation:\n\n${userSummary}`;

  try {
    const resp = await fetch(
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

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Gemini HTTP error", resp.status, text);
      throw new Error("Gemini error");
    }

    const json = await resp.json();
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const explanation = parts.map((p) => p.text || "").join("\n").trim();

    if (!explanation) {
      throw new Error("Empty explanation from Gemini");
    }

    return explanation;
  } catch (err) {
    console.error("Gemini call failed", err);
    return (
      "We could not retrieve a detailed explanation from the AI right now. " +
      "Please try again later, or check your airline's website and local passenger rights information."
    );
  }
}
