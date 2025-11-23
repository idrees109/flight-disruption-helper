// api/disruption-helper.js
// TEST MODE: Use AeroDataBox (via api.market) to fetch flight status.
// No Gemini in this version. Always returns 200 so the frontend doesn't show
// the generic "something went wrong" error.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    // This is the only non-200 we return.
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

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
  } = body;

  const route = from && to ? `${from} → ${to}` : "";

  // Defaults based on user input
  let disruptionType = issueType || "delay";
  let effectiveDelay =
    typeof delayMinutes === "number" ? delayMinutes : null;
  let statusSource = "user";
  let adbStatus = null;
  let usedAeroDataBox = false;

  // Try AeroDataBox only if we have a key + number + date
  if (FLIGHT_API_KEY && flightNumber && flightDate) {
    adbStatus = await fetchFlightStatusFromAeroDataBox({
      flightNumber,
      flightDate,
      FLIGHT_API_KEY,
    });

    if (adbStatus) {
      usedAeroDataBox = true;
      statusSource = "aerodatabox";

      if (adbStatus.disruptionType) {
        disruptionType = adbStatus.disruptionType;
      }
      if (typeof adbStatus.delayMinutes === "number") {
        effectiveDelay = adbStatus.delayMinutes;
      }
    }
  } else {
    console.warn(
      "AeroDataBox not called: missing key, flightNumber or flightDate",
      { hasKey: !!FLIGHT_API_KEY, flightNumber, flightDate }
    );
  }

  const explanation = usedAeroDataBox
    ? "AeroDataBox returned flight data successfully. In this test mode, the delay and times shown above are taken from the flight API where available."
    : "We could not retrieve data from the flight status API. In this test mode, the details above are based only on what you entered.";

  const eligibilitySummary = usedAeroDataBox
    ? "AeroDataBox integration test: flight API responded. Eligibility logic is not implemented in this test mode."
    : "AeroDataBox integration test: flight API did not provide usable data. Eligibility logic is not implemented in this test mode.";

  // Always return 200 here so the frontend doesn't show the generic error.
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
      source: statusSource, // "aerodatabox" or "user"
    },
    eligibility: {
      label: "Unknown",
      type: "mixed",
      summary: eligibilitySummary,
    },
    explanation,
    options: [],
    messages: [],
    hotels: [],
    debug: {
      usedAeroDataBox,
      hasFlightApiKey: !!FLIGHT_API_KEY,
    },
  });
}

// --- Helper to call AeroDataBox flight status API ---

async function fetchFlightStatusFromAeroDataBox({
  flightNumber,
  flightDate,
  FLIGHT_API_KEY,
}) {
  if (!flightNumber || !flightDate || !FLIGHT_API_KEY) return null;

  try {
    // Pattern from your Java example:
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

    // Try to locate the actual flight object inside the response
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

    // Compute delay in minutes if we have both times
    let delayMinutes = null;
    if (scheduledDep && actualDep) {
      const sched = new Date(scheduledDep);
      const act = new Date(actualDep);
      if (!isNaN(sched.getTime()) && !isNaN(act.getTime())) {
        delayMinutes = Math.round((act - sched) / 60000);
      }
    }

    // Basic disruption classification
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
