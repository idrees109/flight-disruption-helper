export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Read keys from Vercel env
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const FLIGHT_API_KEY = process.env.FLIGHT_API_KEY;
  const PLACES_API_KEY = process.env.PLACES_API_KEY;

  // Don't send keys back, just booleans
  return res.status(200).json({
    ok: true,
    envCheck: {
      hasGemini: !!GEMINI_API_KEY,
      hasFlightApi: !!FLIGHT_API_KEY,
      hasPlaces: !!PLACES_API_KEY,
    },
    message:
      "Backend is connected and can see your environment variables. You can now call the real APIs.",
  });
}
