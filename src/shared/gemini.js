import { getFunctions, httpsCallable } from "firebase/functions";
import { getApps } from "firebase/app";

// Re-use the existing Firebase app (initialized in firebase.js)
function getApp() {
  return getApps()[0];
}

let _askFn = null;
function getAskFn() {
  if (!_askFn) {
    const functions = getFunctions(getApp());
    _askFn = httpsCallable(functions, "askGemini");
  }
  return _askFn;
}

export async function askGemini(noteContent, question) {
  const prompt = `You are a helpful, friendly study assistant called Boba. A student is taking notes and wants your help. Based on their notes below, answer their question concisely and clearly. If the notes are empty or unrelated, still answer helpfully using your knowledge.

Notes:
${noteContent || "(no notes yet)"}

Question: ${question}`;

  const result = await getAskFn()({ prompt });
  return result.data.text;
}

export async function generateQuiz(sectionText) {
  const prompt = `You are a study quiz generator called Boba. Given the following study notes, generate exactly 10 multiple-choice questions to test comprehension. Each question should have 4 options (A, B, C, D) with exactly one correct answer.

Return ONLY valid JSON in this exact format, no markdown:
{
  "questions": [
    {
      "question": "...",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct": 0
    }
  ]
}

Notes:
${sectionText}`;

  const result = await getAskFn()({ prompt, json: true });
  return JSON.parse(result.data.text);
}
