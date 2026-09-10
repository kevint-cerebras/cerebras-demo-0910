import { useEffect, useRef, useState } from "react";

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export function useVoice(onTranscript: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  const Speech =
    (
      window as unknown as {
        SpeechRecognition?: new () => Recognition;
        webkitSpeechRecognition?: new () => Recognition;
      }
    ).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: new () => Recognition })
      .webkitSpeechRecognition;
  useEffect(() => () => recognition.current?.abort(), []);
  const start = () => {
    if (!Speech) {
      setVoiceError("Use Chrome for dictation, or type your request.");
      return;
    }
    if (listening) return;
    setVoiceError(null);
    const rec = new Speech();
    recognition.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (event) =>
      callback.current(
        Array.from(event.results)
          .map((result) => result[0].transcript)
          .join(" "),
      );
    rec.onerror = (event) => {
      if (event.error !== "aborted")
        setVoiceError(
          "Dictation stopped. You can edit the text and submit it.",
        );
    };
    rec.onend = () => setListening(false);
    try {
      rec.start();
      setListening(true);
      callback.current("");
    } catch {
      setVoiceError("Could not start dictation. Type your request instead.");
    }
  };
  return {
    listening,
    voiceError,
    supported: Boolean(Speech),
    start,
    finish: () => recognition.current?.stop(),
    cancel: () => recognition.current?.abort(),
  };
}
