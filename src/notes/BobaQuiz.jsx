import { useState, useEffect, useRef, useCallback } from "react";
import { generateQuiz } from "../shared/gemini";

export default function BobaQuiz({ phase, sectionEl, editorEl, sheetEl, onSelectSection, getSectionText, onPhaseChange, onComplete, onClose }) {
  const [questions, setQuestions] = useState(null);
  const [currentQ, setCurrentQ] = useState(0);
  const [score, setScore] = useState(0);
  const [answered, setAnswered] = useState(null); // index of clicked option
  const [dots, setDots] = useState([]);
  const [overlay, setOverlay] = useState(null);
  const [bubbles, setBubbles] = useState([]);

  // Compute dot positions for all sections
  useEffect(() => {
    if (phase !== "selecting" || !editorEl || !sheetEl) { setDots([]); return; }
    const sections = editorEl.querySelectorAll(".note-section");
    const sheetRect = sheetEl.getBoundingClientRect();
    const d = [];
    sections.forEach((sec) => {
      const r = sec.getBoundingClientRect();
      d.push({
        el: sec,
        top: r.top - sheetRect.top + 8,
        left: r.right - sheetRect.left - 30,
      });
    });
    setDots(d);
  }, [phase, editorEl, sheetEl]);

  // Compute overlay rect
  useEffect(() => {
    if (!sectionEl || !sheetEl) { setOverlay(null); return; }
    if (phase !== "loading" && phase !== "animating" && phase !== "quizzing" && phase !== "scoring") { setOverlay(null); return; }
    const update = () => {
      const r = sectionEl.getBoundingClientRect();
      const s = sheetEl.getBoundingClientRect();
      setOverlay({ top: r.top - s.top, left: r.left - s.left, width: r.width, height: r.height });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [phase, sectionEl, sheetEl]);

  // Loading phase: call Gemini
  useEffect(() => {
    if (phase !== "loading" || !sectionEl) return;
    let cancelled = false;
    (async () => {
      try {
        const text = getSectionText(sectionEl);
        if (text.split(/\s+/).length < 20) { alert("Need more notes for a quiz!"); onClose(); return; }
        const result = await generateQuiz(text);
        if (cancelled) return;
        setQuestions(result.questions);
        setCurrentQ(0);
        setScore(0);
        setAnswered(null);
        onPhaseChange("animating");
      } catch (err) {
        if (!cancelled) { alert("Quiz error: " + err.message); onClose(); }
      }
    })();
    return () => { cancelled = true; };
  }, [phase, sectionEl, getSectionText, onPhaseChange, onClose]);

  // Animating phase: add quiz-active class, spawn bubbles, advance after 2s
  useEffect(() => {
    if (phase !== "animating" || !sectionEl || !sheetEl) return;
    sectionEl.classList.add("quiz-active");
    // Spawn bubbles around the section
    const r = sectionEl.getBoundingClientRect();
    const s = sheetEl.getBoundingClientRect();
    const b = [];
    const perimeter = 2 * (r.width + r.height);
    for (let i = 0; i < 12; i++) {
      const dist = (perimeter / 12) * i;
      let bx, by;
      if (dist < r.width) { bx = dist; by = 0; }
      else if (dist < r.width + r.height) { bx = r.width; by = dist - r.width; }
      else if (dist < 2 * r.width + r.height) { bx = r.width - (dist - r.width - r.height); by = r.height; }
      else { bx = 0; by = r.height - (dist - 2 * r.width - r.height); }
      b.push({
        top: r.top - s.top + by - 6,
        left: r.left - s.left + bx - 6,
        delay: i * 0.12,
      });
    }
    setBubbles(b);
    const timer = setTimeout(() => { setBubbles([]); onPhaseChange("quizzing"); }, 2000);
    return () => { clearTimeout(timer); };
  }, [phase, sectionEl, sheetEl, onPhaseChange]);

  // Clean up quiz-active class when leaving quiz phases or unmounting
  useEffect(() => {
    if ((phase === "restoring" || phase === "idle") && sectionEl) {
      sectionEl.classList.remove("quiz-active");
    }
  }, [phase, sectionEl]);

  // Safety: always remove quiz-active on unmount
  useEffect(() => {
    return () => {
      document.querySelectorAll(".note-section.quiz-active").forEach((s) => s.classList.remove("quiz-active"));
    };
  }, []);

  const handleAnswer = useCallback((idx) => {
    if (answered !== null) return;
    setAnswered(idx);
    const correct = questions[currentQ].correct;
    if (idx === correct) setScore((s) => s + 1);
  }, [answered, questions, currentQ]);

  const handleNext = useCallback(() => {
    setAnswered(null);
    if (currentQ < 9) {
      setCurrentQ((q) => q + 1);
    } else {
      onPhaseChange("scoring");
    }
  }, [currentQ, onPhaseChange]);

  if (phase === "idle") return null;

  return (
    <>
      {/* Corner dots */}
      {phase === "selecting" && dots.map((d, i) => (
        <div
          key={i}
          className="quiz-dot"
          style={{ position: "absolute", top: d.top, left: d.left }}
          onClick={() => {
            const text = getSectionText(d.el);
            if (text.split(/\s+/).length < 20) {
              alert("Need more notes for a quiz!");
              return;
            }
            onSelectSection(d.el);
          }}
        />
      ))}

      {/* Boba bubbles */}
      {bubbles.map((b, i) => (
        <div
          key={i}
          className="boba-bubble"
          style={{ position: "absolute", top: b.top, left: b.left, animationDelay: `${b.delay}s` }}
        />
      ))}

      {/* Loading overlay */}
      {phase === "loading" && overlay && (
        <div className="quiz-loading" style={{ top: overlay.top, left: overlay.left, width: overlay.width, height: overlay.height }}>
          Brewing questions...
        </div>
      )}

      {/* Quiz questions */}
      {phase === "quizzing" && overlay && questions && (
        <div className="quiz-overlay" style={{ top: overlay.top, left: overlay.left, width: overlay.width, minHeight: overlay.height }}>
          <div className="quiz-question-num">Q{currentQ + 1} / 10</div>
          <div className="quiz-question-text">{questions[currentQ].question}</div>
          {questions[currentQ].options.map((opt, i) => {
            let cls = "quiz-option";
            if (answered !== null) {
              if (i === questions[currentQ].correct) cls += " correct";
              else if (i === answered) cls += " wrong";
              else cls += " faded";
              cls += " disabled";
            }
            return (
              <button key={i} className={cls} onClick={() => handleAnswer(i)}>
                {opt}
              </button>
            );
          })}
          {answered !== null && (
            <button className="quiz-next-btn" onClick={handleNext} aria-label="Next question">
              &#x279C;
            </button>
          )}
        </div>
      )}

      {/* Score */}
      {phase === "scoring" && overlay && (
        <div className="quiz-overlay" style={{ top: overlay.top, left: overlay.left, width: overlay.width, minHeight: overlay.height }}>
          <div className="quiz-score">
            <div className="quiz-score-number">{score} / 10</div>
            <div className="quiz-score-label">
              {score === 10 ? "Perfect!" : score >= 7 ? "Nice work!" : score >= 4 ? "Not bad!" : "Keep studying!"}
            </div>
            <button className="quiz-done-btn" onClick={onComplete}>Done</button>
          </div>
        </div>
      )}
    </>
  );
}
