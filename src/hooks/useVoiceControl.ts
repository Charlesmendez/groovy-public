"use client";

import { useCallback, useRef, useState, useEffect } from "react";

// Command types that can be triggered by voice
export interface VoiceCommand {
  type: "open_agent" | "close_agent" | "type_text" | "send_message" | "clear_input";
  flag?: string;
  agentName?: string;
  agentId?: string;
  text?: string;
}

interface UseVoiceControlOptions {
  onCommand: (command: VoiceCommand) => void;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
}

interface UseVoiceControlReturn {
  isListening: boolean;
  isConnected: boolean;
  isProcessing: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  toggleListening: () => void;
}

type MediaTrackConstraintsWithVoiceIsolation = MediaTrackConstraints & {
  voiceIsolation?: boolean;
};

export function useVoiceControl({
  onCommand,
  onTranscript,
  onError,
}: UseVoiceControlOptions): UseVoiceControlReturn {
  const [isListening, setIsListening] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingResponseRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const onCommandRef = useRef(onCommand);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  
  useEffect(() => {
    onCommandRef.current = onCommand;
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onCommand, onTranscript, onError]);

  const handleFunctionCall = useCallback((name: string, args: Record<string, unknown>) => {
    console.log("Voice function call:", name, args);
    
    let command: VoiceCommand | null = null;

    switch (name) {
      case "open_agent":
        command = {
          type: "open_agent",
          flag: args.flag as string | undefined,
          agentName: args.agent_name as string | undefined,
          agentId: args.agent_id as string | undefined,
        };
        break;
      case "close_agent":
        command = { type: "close_agent" };
        break;
      case "type_text":
        command = { type: "type_text", text: args.text as string };
        break;
      case "send_message":
        command = { type: "send_message" };
        break;
      case "clear_input":
        command = { type: "clear_input" };
        break;
    }

    if (command) {
      onCommandRef.current(command);
    }
  }, []);

  const connect = useCallback(async () => {
    try {
      setIsProcessing(true);

      // Get ephemeral token from server
      const response = await fetch("/api/realtime/session", { method: "POST" });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create session");
      }
      
      const { client_secret } = await response.json();
      
      if (!client_secret?.value) {
        throw new Error("Invalid session response - check OPENAI_API_KEY in .env");
      }

      // Connect to OpenAI Realtime API with ephemeral token
      const ws = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
        ["realtime", `openai-insecure-api-key.${client_secret.value}`]
      );

      wsRef.current = ws;

      ws.onopen = async () => {
        console.log("WebSocket connected to OpenAI Realtime API");
        
        // Configure the session after connection (GA format)
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: `You are Flow, a voice command interface. Your ONLY job is to execute commands by calling functions. DO NOT have conversations. DO NOT explain things. JUST call the appropriate function.

ALWAYS call a function for every user input:
- "open X" / "X agent" / "show X" → call open_agent
- any dictated text after opening an agent → call type_text  
- "send" / "submit" / "go" / "done" → call send_message
- "clear" → call clear_input
- "close" / "cancel" / "nevermind" → call close_agent

Match agent names loosely: "Claude" matches "Claude Code", "Legal" matches "Legal Review", etc.

NEVER respond with just text. ALWAYS use a function call.`,
            tool_choice: "required",
            tools: [
              {
                type: "function",
                name: "open_agent",
                description: "Opens an agent card by its name",
                parameters: {
                  type: "object",
                  properties: {
                    agent_name: {
                      type: "string",
                      description: "The agent's name or partial name",
                    },
                  },
                  required: ["agent_name"],
                },
              },
              {
                type: "function",
                name: "close_agent",
                description: "Closes the currently open agent panel",
                parameters: { type: "object", properties: {} },
              },
              {
                type: "function",
                name: "type_text",
                description: "Types text into the active agent's input field",
                parameters: {
                  type: "object",
                  properties: {
                    text: { type: "string", description: "The text to type" },
                  },
                  required: ["text"],
                },
              },
              {
                type: "function",
                name: "send_message",
                description: "Sends/submits the current message",
                parameters: { type: "object", properties: {} },
              },
              {
                type: "function",
                name: "clear_input",
                description: "Clears the current input field",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        }));

        setIsConnected(true);
        setIsProcessing(false);
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        
        // Log ALL events
        console.log("[Realtime]", message.type, message);
        
        switch (message.type) {
          case "session.created":
          case "session.updated":
            console.log("[Realtime] Session ready:", message.type);
            break;

          case "conversation.item.input_audio_transcription.completed":
            onTranscriptRef.current?.(message.transcript || "", true);
            break;

          // GA event names
          case "response.output_audio_transcript.delta":
          case "response.audio_transcript.delta": // fallback for beta
            // AI is speaking - could show this
            break;

          case "input_audio_buffer.speech_started":
            // server VAD detected speech start; we keep isListening as "mic is on"
            break;

          case "input_audio_buffer.speech_stopped":
            // server VAD detected end of utterance → request model response.
            console.log("[Realtime] Speech stopped, pendingResponse:", pendingResponseRef.current);
            // Don't create response here - let server VAD handle it automatically
            setIsProcessing(true);
            break;

          case "response.function_call_arguments.done":
            console.log("[Realtime] Function call:", message.name, message.arguments);
            try {
              const args = JSON.parse(message.arguments || "{}");
              handleFunctionCall(message.name, args);
              
              // Acknowledge the function call
              console.log("[Realtime] Sending function output for call_id:", message.call_id);
              ws.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: message.call_id,
                  output: JSON.stringify({ success: true }),
                },
              }));
            } catch (e) {
              console.error("[Realtime] Error parsing function args:", e);
            }
            break;

          case "response.created":
            console.log("[Realtime] Response started:", message.response?.id);
            pendingResponseRef.current = true;
            setIsProcessing(true);
            break;

          case "response.done":
            console.log("[Realtime] Response done:", message.response?.id);
            pendingResponseRef.current = false;
            setIsProcessing(false);
            break;

          case "error":
            console.error("[Realtime] Error:", message.error);
            onErrorRef.current?.(message.error?.message || "Unknown error");
            pendingResponseRef.current = false;
            break;

          default:
            // Already logged above
            break;
        }
      };

      ws.onerror = (event) => {
        console.error("WebSocket error:", event);
        onErrorRef.current?.("Connection error");
        setIsProcessing(false);
      };

      ws.onclose = () => {
        console.log("WebSocket closed");
        setIsConnected(false);
        setIsListening(false);
        setIsProcessing(false);
      };

    } catch (err) {
      console.error("Error connecting:", err);
      onErrorRef.current?.(err instanceof Error ? err.message : "Unknown error");
      setIsProcessing(false);
    }
  }, [handleFunctionCall]);

  const startAudio = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    try {
      const supportedConstraints =
        navigator.mediaDevices.getSupportedConstraints?.() || {};
      const baseAudioConstraints: MediaTrackConstraintsWithVoiceIsolation = {
        sampleRate: 24000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      const audioConstraints: MediaTrackConstraintsWithVoiceIsolation = (
        supportedConstraints as MediaTrackSupportedConstraints & {
          voiceIsolation?: boolean;
        }
      ).voiceIsolation
        ? { ...baseAudioConstraints, voiceIsolation: true }
        : baseAudioConstraints;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
      } catch (err) {
        if (!audioConstraints.voiceIsolation) throw err;
        console.warn(
          "voiceIsolation getUserMedia failed, retrying without it",
          err
        );
        stream = await navigator.mediaDevices.getUserMedia({
          audio: baseAudioConstraints,
        });
      }
      mediaStreamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;
      
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const base64Audio = btoa(
          String.fromCharCode(...new Uint8Array(pcm16.buffer))
        );

        wsRef.current.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio,
        }));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      
      setIsListening(true);
    } catch (err) {
      console.error("Error starting audio:", err);
      onErrorRef.current?.("Microphone access denied");
    }
  }, []);

  const stopAudio = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    setIsListening(false);
  }, []);

  const cleanup = useCallback(() => {
    stopAudio();
  }, [stopAudio]);

  const disconnect = useCallback(() => {
    cleanup();
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    setIsConnected(false);
  }, [cleanup]);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopAudio();
    } else {
      startAudio();
    }
  }, [isListening, startAudio, stopAudio]);

  // Auto-start audio when connected (deferred to avoid cascading renders)
  useEffect(() => {
    if (isConnected && !isListening && !mediaStreamRef.current) {
      const timer = setTimeout(() => {
        startAudio();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isConnected, isListening, startAudio]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    isListening,
    isConnected,
    isProcessing,
    connect,
    disconnect,
    toggleListening,
  };
}
