import { useState, useEffect, useRef } from "react";
import { askGemini } from "../shared/gemini";

export default function BobaAgent({ visible, noteContent, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const chatRef = useRef(null);
  const recogRef = useRef(null);

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  async function send(text) {
    const q = text || input.trim();
    if (!q || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setLoading(true);
    try {
      const answer = await askGemini(noteContent, q);
      setMessages((m) => [...m, { role: "agent", text: answer }]);
      if (voiceOn) speak(answer);
    } catch (err) {
      setMessages((m) => [...m, { role: "agent", text: `Error: ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  }

  function speak(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 1.1;
    speechSynthesis.speak(u);
  }

  function toggleMic() {
    if (listening) {
      recogRef.current?.stop();
      setListening(false);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Speech recognition not supported in this browser."); return; }
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = false;
    r.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setListening(false);
      send(transcript);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    recogRef.current = r;
    r.start();
    setListening(true);
  }

  if (!visible) return null;

  const s = {
    panel: {
      border: "3px solid var(--line)",
      borderRadius: 16,
      boxShadow: "var(--shadow)",
      background: "var(--sheet)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      height: 420,
      marginBottom: 16,
    },
    header: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "10px 14px",
      background: "var(--accent)",
      color: "#fff",
      fontFamily: '"Fredoka", sans-serif',
      fontWeight: 600,
      fontSize: 14,
    },
    closeBtn: {
      background: "none",
      border: "none",
      color: "#fff",
      fontSize: 18,
      cursor: "pointer",
      fontWeight: 700,
    },
    chat: {
      flex: 1,
      overflowY: "auto",
      padding: 12,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    },
    userMsg: {
      alignSelf: "flex-end",
      background: "var(--accent)",
      color: "#fff",
      padding: "8px 12px",
      borderRadius: "14px 14px 4px 14px",
      maxWidth: "80%",
      fontSize: 13,
      fontWeight: 600,
      lineHeight: 1.4,
    },
    agentMsg: {
      alignSelf: "flex-start",
      background: "var(--split-btn-bg)",
      color: "var(--ink)",
      padding: "8px 12px",
      borderRadius: "14px 14px 14px 4px",
      maxWidth: "85%",
      fontSize: 13,
      lineHeight: 1.5,
      whiteSpace: "pre-wrap",
    },
    inputArea: {
      display: "flex",
      alignItems: "center",
      gap: 0,
      padding: "10px 12px",
      borderTop: "3px solid var(--line)",
      background: "var(--sheet)",
    },
    inputRow: {
      display: "flex",
      alignItems: "center",
      flex: 1,
      border: "3px solid var(--line)",
      borderRadius: 14,
      background: "var(--sheet)",
      overflow: "hidden",
      boxShadow: "var(--shadow-sm)",
    },
    textInput: {
      flex: 1,
      border: "none",
      padding: "10px 12px",
      fontSize: 13,
      fontFamily: '"Nunito", sans-serif',
      fontWeight: 700,
      background: "transparent",
      color: "var(--ink)",
      outline: "none",
      minWidth: 0,
    },
    chipBtn: {
      padding: "6px 10px",
      border: "none",
      background: "transparent",
      cursor: "pointer",
      fontFamily: '"Fredoka", sans-serif',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: "0.03em",
      textTransform: "uppercase",
      color: "var(--muted)",
      borderLeft: "2px solid var(--line)",
      display: "flex",
      alignItems: "center",
      gap: 4,
      whiteSpace: "nowrap",
      transition: "background 0.15s, color 0.15s",
    },
    sendBtn: {
      padding: "6px 14px",
      border: "none",
      background: "var(--accent)",
      cursor: "pointer",
      fontFamily: '"Fredoka", sans-serif',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: "0.03em",
      textTransform: "uppercase",
      color: "#fff",
      borderLeft: "3px solid var(--line)",
      display: "flex",
      alignItems: "center",
      gap: 4,
      whiteSpace: "nowrap",
    },
  };

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <span>Boba Agent</span>
        <button style={s.closeBtn} onClick={onClose}>✕</button>
      </div>
      <div ref={chatRef} style={s.chat}>
        {messages.length === 0 && (
          <p style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, fontStyle: "italic", textAlign: "center", margin: "auto 0" }}>
            Ask me anything about your notes!
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={m.role === "user" ? s.userMsg : s.agentMsg}>
            {m.text}
          </div>
        ))}
        {loading && (
          <div style={{ ...s.agentMsg, opacity: 0.6 }}>thinking...</div>
        )}
      </div>
      <div style={s.inputArea}>
        <div style={s.inputRow}>
          <input
            style={s.textInput}
            placeholder="Ask about your notes..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button
            onClick={toggleMic}
            style={{
              ...s.chipBtn,
              background: listening ? "#E85D75" : "transparent",
              color: listening ? "#fff" : "var(--muted)",
              animation: listening ? "mic-pulse 1s ease-in-out infinite" : "none",
            }}
          >
            <span style={{ fontSize: 13, lineHeight: 1 }}>&#9679;</span>
            {listening ? "listening" : "voice"}
          </button>
          <button
            onClick={() => setVoiceOn((v) => !v)}
            style={{
              ...s.chipBtn,
              color: voiceOn ? "var(--accent)" : "var(--muted)",
            }}
          >
            {voiceOn ? "sound on" : "muted"}
          </button>
          <button
            onClick={() => send()}
            disabled={loading || !input.trim()}
            style={{
              ...s.sendBtn,
              opacity: (loading || !input.trim()) ? 0.4 : 1,
            }}
          >
            send
          </button>
        </div>
      </div>
    </div>
  );
}
