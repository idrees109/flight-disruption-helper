// Call AeroDataBox via api.market using flight number + date
async function fetchFlightStatusFromAeroDataBox({
  flightNumber,
  flightDate,
  FLIGHT_API_KEY,
}) {
  if (!flightNumber || !flightDate || !FLIGHT_API_KEY) return null;

  try {
    // Build the URL using the pattern from your Java example
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
        "x-api-market-key": FLIGHT_API_KEY, // from Vercel env var
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
