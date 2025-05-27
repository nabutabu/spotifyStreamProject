import React, { useRef, useState } from "react";

export default function AudioStreamer() {
  const [isStreaming, setIsStreaming] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startStreaming = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: false,
      });

      streamRef.current = stream;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const workletNode = new AudioWorkletNode(audioContext, "recorder-processor");
      workletNodeRef.current = workletNode;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(workletNode);
      workletNode.connect(audioContext.destination); // Optional for local playback

      const ws = new WebSocket("ws://localhost:3001"); // Change to your backend URL
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      // Handle audio chunks
      workletNode.port.onmessage = (event) => {
        const float32 = event.data as Float32Array;
        const int16Buffer = floatTo16BitPCM(float32);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(int16Buffer);
        }
      };

      setIsStreaming(true);
    } catch (err) {
      console.error("Error starting stream:", err);
      alert("Could not start streaming: " + err);
    }
  };

  const stopStreaming = () => {
    workletNodeRef.current?.disconnect();
    audioContextRef.current?.close();
    wsRef.current?.close();
    streamRef.current?.getTracks().forEach(track => track.stop());

    workletNodeRef.current = null;
    audioContextRef.current = null;
    wsRef.current = null;
    streamRef.current = null;

    setIsStreaming(false);
  };

  const floatTo16BitPCM = (input: Float32Array): ArrayBuffer => {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output.buffer;
  };

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">Audio Streamer</h2>
      <button
        onClick={isStreaming ? stopStreaming : startStreaming}
        className={`px-4 py-2 rounded text-white ${
          isStreaming ? "bg-red-600" : "bg-blue-600"
        }`}
      >
        {isStreaming ? "Stop Streaming" : "Start Streaming"}
      </button>
    </div>
  );
}
