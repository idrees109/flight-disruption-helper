// api/disruption-helper.js
// Production-style backend:
// - Uses AeroDataBox to verify flight + get real status
// - Calls Gemini ONLY if flight is verified
// - If flight not found, returns a clear message and NO AI fabrication

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
  const FLIGHT_API_KEY = process.env.FLIGHT_API_KEY || "";

  // Parse body safely
  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      console.error("Failed to parse req.body JSON:", e);
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

  const route = from && to ? `${from} → ${to}` : "";

  // ---------- 1) Try AeroDataBox to verify the flight ----------
  let adbStatus = null;
  let statusSource = "user_unverified"; // default: we haven't verified anything yet

  if (FLIGHT_API_KEY && flightNumber && flightDate) {
    adbStatus = await fetchFlightStatusFromAeroDataBox({
      flightNumber,
      flightDate,
      FLIGHT_API_KEY,
    });

    if (adbStatus) {
      statusSource = "aerodatabox_verified";
    } else {
      statusSource = "user_not_found"; // explicitly: API did not find the flight
    }
  } else {
    statusSource = "user_no_api"; // we couldn't even call the API
  }

  // ---------- 2) Decide disruption type & delay ----------
  let disruptionType = issueType || "delay";
  let effectiveDelay =
    typeof delayMinutes === "number" ? delayMinutes : null;

  if (statusSource === "aerodatabox_verified" && adbStatus) {
    if (adbStatus.disruptionType) {
      disruptionType = adbStatus.disruptionType;
    }
    if (typeof adbStatus.delayMinutes === "number") {
      effectiveDelay = adbStatus.delayMinutes;
    }
  }

  // ---------- 3) Eligibility (simple rule) ----------
  const eligibility = buildEligibility(disruptionType, effectiveDelay);

  // ---------- 4) Explanation logic ----------
  let explanation = "";
  let explanationFromAI = false;

  if (statusSource === "aerodatabox_verified" && GEMINI_API_KEY) {
    // ✅ Flight verified by AeroDataBox – safe to ask Gemini for a detailed explanation
    explanation = await buildExplanationWithGemini({
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
    explanationFromAI = true;
  } else if (!FLIGHT_API_KEY) {
    // No flight API at all – we can optionally still use Gemini,
    // but clearly say that the flight is NOT verified.
    if (GEMINI_API_KEY) {
      explanation = await buildUnverifiedExplanationWithGemini({
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
      });
      explanationFromAI = true;
    } else {
      explanation =
        "We could not verify this flight because no flight status API is configured. " +
        "Please double-check your flight number, airline, and date on the airline's website. " +
        "We also cannot generate an AI explanation right now.";
    }
  } else if (statusSource === "user_not_found") {
    // ❌ Flight API actively said “no such flight”
    explanation =
      "We could not find this flight in our status database for the date you entered. " +
      "Please double-check your flight number, airline, and travel date against your booking, " +
      "boarding pass, or the airline’s official website. Because the flight could not be verified, " +
      "we are not generating a detailed AI explanation based on this data.";
  } else {
    // Some other fallback case
    explanation =
      "We could not reliably verify this flight. Please double-check your details on the airline's website. " +
      "No AI-generated explanation is shown for unverified flight information.";
  }

  // ---------- 5) Build final response ----------
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
      source: statusSource, // "aerodatabox_verified", "user_not_found", etc.
    },
    eligibility,
    explanation,
    options: [],
    messages: [],
    hotels: [],
    debug: {
      statusSource,
      usedAeroDataBox: statusSource === "aerodatabox_verified",
      explanationFromAI,
      hasFlightApiKey: !!FLIGHT_API_KEY,
      hasGeminiKey: !!GEMINI_API_KEY,
    },
  });
}

// ---------- Helper: call AeroDataBox (this part we already proved works) ----------

async function fetchFlightStatusFromAeroDataBox({
  flightNumber,
  flightDate,
  FLIGHT_API_KEY,
}) {
  if (!flightNumber || !flightDate || !FLIGHT_API_KEY) return null;

  try {
    const url =
      "https://prod.api.market/api/v1/aedbx/aerodatabox/flights/Number/" +
      encodeURIComponent(flightNumber) +
      "/" +
      encodeURIComponent(flightDate) +
      "?dateLocalRole=Both&withAircraftImage=false&withLocation=false";

    console.log("Calling AeroDataBox URL:", url);

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-market-key": FLIGHT_API_KEY,
      },
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error("AeroDataBox HTTP error", resp.status, txt);
      return null;
    }

    const data = await resp.json();
    console.log("AeroDataBox raw JSON:", JSON.stringify(data));

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
      console.warn("AeroDataBox: no flight object found in response");
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

    let delayMinutes = null;
    if (scheduledDep && actualDep) {
      const sched = new Date(scheduledDep);
      const act = new Date(actualDep);
      if (!isNaN(sched.getTime()) && !isNaN(act.getTime())) {
        delayMinutes = Math.round((act - sched) / 60000);
      }
    }

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
      raw: flight,
    };
  } catch (err) {
    console.error("AeroDataBox fetch failed", err);
    return null;
  }
}

// ---------- Helper: simple eligibility rules ----------

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

// ---------- Helper: Gemini explanation for VERIFIED flights ----------

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

  if (!GEMINI_API_KEY) return "";

  const delayLabel =
    typeof effectiveDelay === "number" && effectiveDelay > 0
      ? `${effectiveDelay} minutes`
      : "unknown / not provided";

  const userSummary = `
Flight details (verified by flight status API):
- Route: ${from || "?"} → ${to || "?"}
- Airline: ${airline || "?"}
- Flight: ${flightNumber || "?"}
- Date: ${flightDate || "?"}

Status:
- Disruption type: ${disruptionType}
- Delay (if any): ${delayLabel}

Other context:
- Cause (if known): ${cause || "not specified"}
- Region context: ${region || "let the assistant infer from route"}
- Traveller priority: ${priority}
- Extra context: ${extraContext || "none provided"}
`.trim();

  const systemInstructions = `
You are an assistant helping travellers understand typical airline disruption handling.

The flight status and delay information in the context is VERIFIED by a flight-status API.

You MUST:
1. Provide a concise plain-language explanation of what the traveller can typically expect (rebooking, support, compensation).
2. Make it clear that:
   - you cannot give legal or financial advice,
   - final decisions depend on the airline, booking conditions, and local law,
   - passenger-rights regulations (like EU261/UK261) may apply but you don't know the exact jurisdiction.
3. Do NOT invent:
   - specific causes of the delay,
   - internal airline decisions,
   - exact compensation amounts.
   Use words like "may", "could", "often", "typically".
4. Use the airline name exactly as provided.
5. Write in clear, simple English, 2–4 short paragraphs. No bullet points, no headings.
`.trim();

  return await callGemini(GEMINI_API_KEY, systemInstructions, userSummary);
}

// ---------- Helper: Gemini explanation when flight NOT verified ----------

async function buildUnverifiedExplanationWithGemini(params) {
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
  } = params;

  if (!GEMINI_API_KEY) return "";

  const delayLabel =
    typeof effectiveDelay === "number" && effectiveDelay > 0
      ? `${effectiveDelay} minutes`
      : "unknown / not provided";

  const userSummary = `
Flight details (NOT verified against any flight-status API):
- Route (user-entered): ${from || "?"} → ${to || "?"}
- Airline (user-entered): ${airline || "?"}
- Flight number (user-entered): ${flightNumber || "?"}
- Date (user-entered): ${flightDate || "?"}

Disruption (user-entered):
- Type: ${disruptionType}
- Delay: ${delayLabel}
- Cause (if known): ${cause || "not specified"}

Other context (user-entered):
- Region context: ${region || "let the assistant infer from route"}
- Traveller priority: ${priority}
- Extra context: ${extraContext || "none provided"}
`.trim();

  const systemInstructions = `
You are an assistant helping travellers understand typical airline disruption handling.

IMPORTANT: The flight details in the context are NOT verified. They come only from what the user typed.

You MUST:
1. Start your answer by clearly stating that the flight information could not be verified and that your explanation is generic.
2. Provide only general guidance on what airlines often do in similar situations (rebooking, support, compensation), without implying that you know the status of this specific flight.
3. Make it clear that:
   - you cannot give legal or financial advice,
   - final decisions depend on the airline, booking conditions, and local law.
4. Do NOT invent concrete facts about this specific flight (no specific timings, airport operations, or decisions).
5. Write in clear, simple English, 2–3 short paragraphs. No bullet points, no headings.
`.trim();

  return await callGemini(GEMINI_API_KEY, systemInstructions, userSummary);
}

// ---------- Helper: low-level Gemini caller ----------

async function callGemini(apiKey, systemInstructions, userSummary) {
  try {
    const promptText = `${systemInstructions}\n\nHere is the traveller's situation:\n\n${userSummary}`;

    const resp = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
        encodeURIComponent(apiKey),
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
      return "";
    }

    const json = await resp.json();
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const explanation = parts.map((p) => p.text || "").join("\n").trim();
    return explanation || "";
  } catch (err) {
    console.error("Gemini call failed:", err);
    return "";
  }
}
