export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // For now, just echo back what we got:
  return res.status(200).json({
    status: {
      disruptionType: "delay",
      delayMinutes: req.body?.delayMinutes ?? null,
      flightNumber: req.body?.flightNumber ?? "",
      route: `${req.body?.from ?? ""} → ${req.body?.to ?? ""}`,
    },
    eligibility: {
      label: "Unknown",
      summary: "This is a placeholder response from the backend.",
    },
    explanation:
      "Backend is connected! Now you can implement real logic with Gemini & flight APIs.",
    options: [],
    messages: [],
    hotels: [],
  });
}
