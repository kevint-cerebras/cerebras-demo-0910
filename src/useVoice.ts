import { useEffect, useRef, useState } from "react";
import type { BrowserSnapshot } from "../shared/types";
interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  results: { length: number; [index: number]: RecognitionResult };
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionConstructor = new () => Recognition;
export function useVoice(
  onTranscript: (text: string) => void,
  onPreview: (shots: BrowserSnapshot[]) => void,
  onSubmit: (text: string, session?: string) => void,
  onGeneralPreview?: (page: {
    image: string;
    url: string;
    title: string;
    label: string;
  }) => void,
) {
  const Speech =
    (
      window as unknown as {
        SpeechRecognition?: RecognitionConstructor;
        webkitSpeechRecognition?: RecognitionConstructor;
      }
    ).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: RecognitionConstructor })
      .webkitSpeechRecognition;
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const [previewActions, setPreviewActions] = useState(0);
  const recognition = useRef<Recognition | null>(null);
  const session = useRef<string | undefined>(undefined);
  const sessionPromise = useRef<Promise<string | undefined> | null>(null);
  const transcript = useRef("");
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(false);
  const submitOnEnd = useRef(false);
  const previewAbort = useRef<AbortController | null>(null);
  const dispose = async () => {
    if (session.current)
      await fetch(`/api/voice/${session.current}`, { method: "DELETE" }).catch(
        () => {},
      );
    session.current = undefined;
  };
  useEffect(
    () => () => {
      active.current = false;
      recognition.current?.abort();
      if (previewTimer.current) clearTimeout(previewTimer.current);
      previewAbort.current?.abort();
      void dispose();
    },
    [],
  );
  const start = async () => {
    if (!Speech) {
      setVoiceError(
        "Voice recognition is unavailable in this browser. Open Dash in Chrome, or type your request.",
      );
      return;
    }
    if (active.current) return;
    setVoiceError(null);
    setPreviewLabel("Opening the browser while you speak");
    setPreviewActions(0);
    transcript.current = "";
    active.current = true;
    submitOnEnd.current = false;
    const rec = new Speech();
    recognition.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (event) => {
      const parts: string[] = [];
      for (let i = 0; i < event.results.length; i++)
        parts.push(event.results[i][0].transcript);
      transcript.current = parts.join(" ").trim();
      onTranscript(transcript.current);
      if (previewTimer.current) clearTimeout(previewTimer.current);
      previewTimer.current = setTimeout(async () => {
        const id = await sessionPromise.current;
        if (!id || !active.current || !transcript.current) return;
        previewAbort.current?.abort();
        const controller = new AbortController();
        previewAbort.current = controller;
        try {
          const res = await fetch(`/api/voice/${id}/preview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transcript: transcript.current }),
            signal: controller.signal,
          });
          if (!res.ok || !active.current) return;
          const data = await res.json();
          if (!active.current) return;
          onPreview(data.snapshots);
          setPreviewActions(data.actions);
          if (data.general) {
            onGeneralPreview?.(data.general);
            setPreviewLabel(data.general.label);
          }
          if (data.snapshots.length) setPreviewLabel(data.snapshots[0].label);
        } catch {
          /* A newer transcript supersedes in-flight previews. */
        }
      }, 220);
    };
    rec.onerror = (e) => {
      submitOnEnd.current = false;
      const messages: Record<string, string> = {
        "not-allowed":
          "Microphone permission was declined. Allow it in browser settings or type your request.",
        "service-not-allowed":
          "This browser cannot access its speech service. Try Chrome or type your request.",
        network:
          "The browser speech service could not connect. Try Chrome or type your request.",
        "audio-capture":
          "No microphone is available. Type your request instead.",
        "no-speech": "I didn’t catch that. Try again, or type your request.",
      };
      if (e.error !== "aborted")
        setVoiceError(
          messages[e.error] ||
            `Voice recognition stopped (${e.error}). You can still type your request.`,
        );
    };
    rec.onend = async () => {
      active.current = false;
      setListening(false);
      if (previewTimer.current) clearTimeout(previewTimer.current);
      await sessionPromise.current;
      if (submitOnEnd.current && transcript.current.trim().length >= 3) {
        const id = session.current;
        session.current = undefined;
        onSubmit(transcript.current, id);
      } else await dispose();
    };
    try {
      rec.start();
      setListening(true);
      sessionPromise.current = fetch("/api/voice/prepare", { method: "POST" })
        .then(async (res) => {
          if (!res.ok) return undefined;
          const data = await res.json();
          session.current = data.id;
          if (active.current && data.snapshot) onPreview([data.snapshot]);
          return data.id as string;
        })
        .catch(() => undefined);
    } catch {
      active.current = false;
      setListening(false);
      setVoiceError("Voice could not start. Try Chrome or type your request.");
    }
  };
  const finish = () => {
    if (!active.current) return;
    submitOnEnd.current = true;
    recognition.current?.stop();
  };
  const cancel = () => {
    submitOnEnd.current = false;
    active.current = false;
    recognition.current?.abort();
    setListening(false);
    if (previewTimer.current) clearTimeout(previewTimer.current);
    void dispose();
  };
  return {
    supported: Boolean(Speech),
    listening,
    voiceError,
    previewLabel,
    previewActions,
    start,
    finish,
    cancel,
  };
}
