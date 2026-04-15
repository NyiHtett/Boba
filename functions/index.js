const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const geminiKey = defineSecret("GEMINI_API_KEY");

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

exports.askGemini = onCall(
  { secrets: [geminiKey], cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }

    const { prompt, json } = request.data;
    if (!prompt || typeof prompt !== "string") {
      throw new HttpsError("invalid-argument", "Missing prompt.");
    }

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
    };
    if (json) {
      body.generationConfig = { responseMimeType: "application/json" };
    }

    const res = await fetch(
      `${GEMINI_URL}?key=${geminiKey.value()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const status = res.status;
      if (status === 429)
        throw new HttpsError("resource-exhausted", "Rate limit — try again soon.");
      throw new HttpsError("internal", `Gemini error (${status})`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new HttpsError("internal", "Empty response from Gemini.");
    return { text };
  }
);
