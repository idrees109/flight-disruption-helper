// api/disruption-helper.js
// Production backend:
// - Uses AeroDataBox via api.market to verify flight + get real status
// - Calls Gemini ONLY if the flight is verified
// - If flight is not found or cannot be verified, returns a short explanation
//   and DOES NOT let Gemini "make up" a detailed story.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
  const FLIGHT_API_KEY = process.env.FLIGHT_API_KEY || "";

  // ---------- Parse request body safely ----------
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

  // ---------- 1) Try to verify flight via AeroDataBox ----------
  let adbStatus = null;
  let statusSource = "user_unverified"; // default
  if (FLIGHT_API_KEY && flightNumber && flightDate) {
    adbStatus = await fetchFlightStatusFromAeroDataBox({
      flightNumber,
      flightDate,
      FLIGHT_API_KEY,
    });

    if (adbStatus) {
      statusSource = "aerodatabox_verified";
    } else {
      statusSource = "user_not_found"; // API checked but did not find this flight
    }
  } else if (!FLIGHT_API_KEY) {
    statusSource = "user_no_api"; // we don't have a flight API key configured
  }

  // ---------- 2) Decide disruption type & delay ----------
  let disruptionType = "unknown";
  let effectiveDelay = null;

  if (statusSource === "aerodatabox_verified" && adbStatus) {
    // ✅ We trust AeroDataBox and IGNORE any user-entered delay/type.
    disruptionType = adbStatus.disruptionType || "none";
    effectiveDelay =
      typeof adbStatus.delayMinutes === "number"
        ? adbStatus.delayMinutes
        : null;
  } else {
    // Unverified cases – we can still show what user typed in the UI,
    // but we will NOT feed this into Gemini.
    disruptionType = issueType || "unknown";
    effectiveDelay =
      typeof delayMinutes === "number" ? delayMinutes : null;
  }

  // ---------- 3) Eligibility (simple rules) ----------
  const eligibility = buildEligibility(disruptionType, effectiveDelay);

  // ---------- 4) Explanation logic ----------
  let explanation = "";
  let explanationFromAI = false;

  if (statusSource === "aerodatabox_verified" && GEMINI_API_KEY) {
    // ✅ Flight verified AND we have Gemini -> safe to generate detailed guidance
    explanation = await buildVerifiedExplanationWithGemini({
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
  } else if (statusSource === "user_not_found") {
    // ❌ Flight API could not find this flight -> no Gemini, short honest message
    explanation =
      "We couldn’t find this flight in our status database for the date you entered. " +
      "Please double-check your flight number, airline, and travel date against your booking, " +
      "boarding pass, or the airline’s official website. Because the flight could not be verified, " +
      "we’re not generating a detailed AI explanation based on this data.";
  } else if (statusSource === "user_no_api") {
    explanation =
      "We don’t have access to a live flight-status API right now, so we can’t verify this flight. " +
      "Please check the latest status directly on your airline’s website or app for accurate information.";
  } else {
    // user_unverified or any other fallback
    explanation =
      "We couldn’t reliably verify this flight. Please double-check your details on the airline’s website. " +
      "No AI-generated explanation is shown for unverified flight information.";
  }

  // ---------- 5) Build final JSON response ----------
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
      source: statusSource, // "aerodatabox_verified", "user_not_found", "user_no_api", "user_unverified"
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

// =====================================================================
// HELPER: Call AeroDataBox via api.market
// =====================================================================

async function fetchFlightStatusFromAeroDataBox({
  flightNumber,
  flightDate,
  FLIGHT_API_KEY,
}) {
  if (!flightNumber || !flightDate || !FLIGHT_API_KEY) return null;

  try {
    // Pattern proven from your Java example:
    // https://prod.api.market/api/v1/aedbx/aerodatabox/flights/Number/QR629/2025-11-23?dateLocalRole=Both&withAircraftImage=false&withLocation=false
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

// =====================================================================
// HELPER: Simple eligibility logic
// =====================================================================

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

// =====================================================================
// HELPER: Gemini explanation for VERIFIED flights only
// =====================================================================

async function buildVerifiedExplanationWithGemini(params) {
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
    typeof effectiveDelay === "number"
      ? `${effectiveDelay} minutes`
      : "no clear delay reported";

  const userSummary = `
Flight details (verified by flight-status API):
- Route: ${from || "?"} → ${to || "?"}
- Airline: ${airline || "?"}
- Flight: ${flightNumber || "?"}
- Date: ${flightDate || "?"}

Status:
- Disruption type: ${disruptionType}
- Delay: ${delayLabel}

Other context:
- Cause (if known): ${cause || "not specified"}
- Region context: ${region || "let the assistant infer from route"}
- Traveller priority: ${priority}
- Extra context: ${extraContext || "none provided"}
`.trim();

  const systemInstructions = `
You are an assistant helping travellers understand typical airline disruption handling.

The flight status and delay information in the context has been VERIFIED by a flight-status API.

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

// =====================================================================
// HELPER: Low-level Gemini caller
// =====================================================================

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
