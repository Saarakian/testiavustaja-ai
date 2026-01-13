import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { ConnectionStatus, TestReport, Language } from './types';
import { Visualizer } from './components/Visualizer';
import { createPcmBlob, base64ToUint8Array, convertPCMToAudioBuffer, blobToBase64 } from './utils/audioUtils';

declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}

// --- LOCALIZATION & CONSTANTS ---

const TRANSLATIONS = {
  fi: {
    appTitle: 'TestiAI',
    status: { live: 'Live', error: 'Virhe', offline: 'Offline' },
    placeholder: 'Mitä haluat testata tänään?',
    uploadBtn: 'Tai lataa valmis testisuunnitelma (.txt, .md)',
    changeFileBtn: 'Vaihda testisuunnitelma (.txt, .md)',
    planReady: 'Testisuunnitelma valmis. Sano "Aloitetaan testi" kun yhdistät.',
    startBtn: 'Aloita Äänitys',
    connectBtn: 'Yhdistä ja sano "Aloita"',
    retryBtn: 'Yritä Uudelleen',
    muteOn: 'Avaa Mikki',
    muteOff: 'Mykistä',
    stopBtn: 'Lopeta',
    cameraOn: 'Sulje Kamera',
    cameraOff: 'Avaa Kamera',
    analyzing: 'Kirjataan raporttia...',
    listening: 'Kuunnellaan havaintoja...',
    mutedMsg: 'Mikrofoni mykistetty.',
    readyMsg: 'Valmiina testiin',
    cameraError: 'Kameran käynnistys epäonnistui.',
    micError: 'Mikrofonin käyttö estettiin tai sitä ei löydy.',
    connError: 'Yhteys katkesi',
    saveReport: 'Tallenna Raportti',
    sendBtn: 'Lähetä',
    sections: {
      1: '1. Alkuosat',
      2: '2. Johdanto & Tausta',
      3: '3. Menetelmät',
      4: '4. Tulokset & Pohdinta',
      5: '5. Loppuosat',
      abstract: 'Tiivistelmä',
      intro: 'Johdanto',
      objectives: 'Testin tavoitteet',
      theory: 'Teoreettinen viitekehys',
      material: 'Testimateriaali',
      methods: 'Testausmenetelmät',
      results: 'Testitulokset',
      discussion: 'Pohdinta',
      conclusion: 'Johtopäätökset',
      references: 'Lähdeluettelo',
      noData: 'Ei kirjattua tietoa.',
      observations: 'havaintoa'
    }
  },
  en: {
    appTitle: 'TestAI',
    status: { live: 'Live', error: 'Error', offline: 'Offline' },
    placeholder: 'What do you want to test today?',
    uploadBtn: 'Or upload a test plan (.txt, .md)',
    changeFileBtn: 'Change test plan (.txt, .md)',
    planReady: 'Test plan ready. Say "Start test" when connected.',
    startBtn: 'Start Recording',
    connectBtn: 'Connect & Say "Start"',
    retryBtn: 'Try Again',
    muteOn: 'Unmute',
    muteOff: 'Mute',
    stopBtn: 'End Session',
    cameraOn: 'Close Camera',
    cameraOff: 'Open Camera',
    analyzing: 'Writing report...',
    listening: 'Listening for observations...',
    mutedMsg: 'Microphone muted.',
    readyMsg: 'Ready for test',
    cameraError: 'Failed to start camera.',
    micError: 'Microphone permission denied or not found.',
    connError: 'Connection lost',
    saveReport: 'Save Report',
    sendBtn: 'Send',
    sections: {
      1: '1. Front Matter',
      2: '2. Introduction & Background',
      3: '3. Methodology',
      4: '4. Results & Discussion',
      5: '5. End Matter',
      abstract: 'Abstract',
      intro: 'Introduction',
      objectives: 'Test Objectives',
      theory: 'Theoretical Framework',
      material: 'Test Materials',
      methods: 'Test Methods',
      results: 'Test Results',
      discussion: 'Discussion',
      conclusion: 'Conclusion',
      references: 'References',
      noData: 'No data recorded.',
      observations: 'observations'
    }
  }
};

// Helper to render HTML content safely with simple markdown parsing
const parseMarkdown = (text: string) => {
  if (!text) return '';
  // Don't mess with HTML tags if they exist (like img)
  if (text.trim().startsWith('<')) return text;

  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^\s*-\s+(.*)$/gm, '• $1');
};

const HtmlContent: React.FC<{ html: string, className?: string }> = ({ html, className }) => (
  <div className={className} dangerouslySetInnerHTML={{ __html: parseMarkdown(html) }} />
);

const getToolDefinitions = (lang: Language): FunctionDeclaration[] => {
  const isFi = lang === 'fi';
  return [
    {
      name: 'updateReport',
      description: isFi 
        ? 'TÄRKEÄ: Käytä tätä AINA kun käyttäjä kertoo uutta tietoa tai kun luet tietoa testisuunnitelmasta. Päivittää raportin tekstisisältöä.' 
        : 'IMPORTANT: Use this ALWAYS when user provides new info or when reading from test plan. Updates text content of the test report.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          section: {
            type: Type.STRING,
            enum: [
              'title', 'author', 'abstract', 
              'introduction', 'testObjectives', 'theoreticalFramework',
              'testMaterial', 'methodology',
              'results', 'discussion', 'conclusion', 'references'
            ],
            description: "Section key to update.",
          },
          content: {
            type: Type.STRING,
            description: isFi 
              ? "Kirjattava sisältö. Muunna puhekieli selkeäksi asiatekstiksi." 
              : "Content to write. Convert speech to formal text.",
          },
        },
        required: ['section', 'content'],
      },
    },
    {
      name: 'addImageToReport',
      description: isFi 
        ? 'Liittää viimeisimmän otetun valokuvan raportin valittuun osioon.' 
        : 'Attaches the last taken snapshot to the selected report section.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          section: {
            type: Type.STRING,
            enum: [
              'introduction', 'testObjectives', 'theoreticalFramework',
              'testMaterial', 'methodology',
              'results', 'discussion', 'conclusion'
            ],
            description: "Section key.",
          },
          caption: {
            type: Type.STRING,
            description: isFi ? "Kuvan kuvateksti." : "Image caption.",
          }
        },
        required: ['section'],
      },
    }
  ];
};

const initialReport: TestReport = {
  title: '',
  author: 'Tester',
  date: new Date().toLocaleDateString(),
  abstract: '',
  introduction: '',
  testObjectives: '',
  theoreticalFramework: '',
  testMaterial: '',
  methodology: '',
  results: [],
  discussion: '',
  conclusion: '',
  references: [],
};

const App: React.FC = () => {
  const [language, setLanguage] = useState<Language>('fi');
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [report, setReport] = useState<TestReport>(initialReport);
  const [testTopic, setTestTopic] = useState('');
  const [testPlan, setTestPlan] = useState<string | null>(null);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  
  // Use refs for volumes to avoid re-rendering entire App on every audio frame
  const userVolumeRef = useRef(0);
  const aiVolumeRef = useRef(0);
  // Also keep state for the Visualizer component which needs to re-render
  const [visualizerState, setVisualizerState] = useState({ userVolume: 0, aiVolume: 0 });

  const [isCameraOn, setIsCameraOn] = useState(false);
  
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);
  const isUserInitiatedDisconnect = useRef(false);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Audio Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  
  // Connection Refs
  const sessionRef = useRef<any>(null);
  const isConnectedRef = useRef<boolean>(false);
  
  // UI Refs
  const topicInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const reportContainerRef = useRef<HTMLDivElement>(null);

  // Image Capture Refs
  const pendingPhotoRef = useRef<string | null>(null);

  // Initialize AI client
  const ai = useRef(new GoogleGenAI({ apiKey: process.env.API_KEY })).current;

  // --- LOGIC ---
  
  // Auto-scroll to bottom of report when updated
  useEffect(() => {
    if (reportContainerRef.current) {
        // Smooth scroll to bottom
        reportContainerRef.current.scrollTo({
            top: reportContainerRef.current.scrollHeight,
            behavior: 'smooth'
        });
    }
  }, [report.results.length, report.methodology, report.discussion, report.conclusion]);

  // Visualizer loop to sync state without blocking
  useEffect(() => {
    let animId: number;
    const syncVisualizer = () => {
        if (status === ConnectionStatus.CONNECTED) {
            setVisualizerState({ 
                userVolume: userVolumeRef.current, 
                aiVolume: aiVolumeRef.current 
            });
        }
        animId = requestAnimationFrame(syncVisualizer);
    };
    if (status === ConnectionStatus.CONNECTED) {
        syncVisualizer();
    } else {
        setVisualizerState({ userVolume: 0, aiVolume: 0 });
    }
    return () => cancelAnimationFrame(animId);
  }, [status]);

  const getSystemInstruction = (lang: Language, plan: string | null, currentReport: TestReport) => {
    const isFi = lang === 'fi';
    
    let base = isFi 
      ? `ROOLI: Olet AKTIIVINEN KIRJURI ja TESTAUSJOHTAJA.
      
      PROSESSI JA TÄRKEÄT SÄÄNNÖT:
      
      1. ALKUANALYYSI (TÄRKEÄ): Jos alla on annettu TESTISUUNNITELMA, analysoi se HETI istunnon alussa. Sinun TÄYTYY kutsua 'updateReport'-työkalua useita kertoja täyttääksesi raportin pohjatiedot (Otsikko, Johdanto, Tavoitteet, Välineet, Menetelmät) suunnitelman perusteella. Älä odota käyttäjän käskyä, vaan tee tämä heti taustalla.

      2. TESTIN AIKANA: Ohjaa käyttäjää suunnitelman läpi vaihe vaiheelta. Kun käyttäjä suorittaa vaiheen tai kertoo havainnon, kirjaa se VÄLITTÖMÄSTI 'results'-osioon. 
      
      3. REAALIAIKAINEN KIRJAUS: Käytä työkaluja aggressiivisesti. Heti kun kuulet relevanttia tietoa, kirjaa se. Älä kerää tietoa muistiin, vaan vie se heti raporttiin.
      
      4. PUHE: Pidä puhe lyhyenä ja ytimekkäänä. Kerro käyttäjälle mitä olet kirjannut ("Kirjasin tuloksen.", "Päivitin menetelmät.").`
      
      : `ROLE: You are an ACTIVE SCRIBE and TEST DIRECTOR.
      
      PROCESS AND RULES:
      
      1. INITIAL ANALYSIS (CRITICAL): If a TEST PLAN is provided below, analyze it IMMEDIATELY at the start. You MUST call 'updateReport' multiple times to pre-fill the report (Title, Intro, Objectives, Materials, Methods) based on the plan. Do not wait for user input, do this immediately.
      
      2. DURING TEST: Guide the user through the plan step-by-step. When the user completes a step or reports an observation, log it IMMEDIATELY to 'results'.
      
      3. REAL-TIME LOGGING: Use tools aggressively. As soon as you hear relevant info, log it. Do not buffer info.
      
      4. SPEECH: Keep speech short. Confirm actions ("Logged result.", "Updated methods.").`;

    base += isFi
      ? `\nKAMERA: Kun saat kuvan, kysy mihin osioon se liitetään ja käytä 'addImageToReport'.`
      : `\nCAMERA: When you receive an image, ask where to attach it and use 'addImageToReport'.`;

    if (plan) {
      base += isFi
        ? `\n\n--- TESTISUUNNITELMA (LÄHDE) ---\n"""${plan}"""\n\nTEHTÄVÄ: Analysoi yllä oleva suunnitelma NYT. Kutsu 'updateReport'-työkalua ERIKSEEN jokaiselle osiolle, jonka voit täyttää tämän tekstin perusteella (Otsikko, Johdanto, Tavoitteet, Välineet, Menetelmät). TEE TÄMÄ ENNEN KUIN PUHUT KÄYTTÄJÄLLE.`
        : `\n\n--- TEST PLAN (SOURCE) ---\n"""${plan}"""\n\nTASK: Analyze the plan above NOW. Call 'updateReport' SEPARATELY for every section you can fill based on this text (Title, Intro, Objectives, Materials, Methods). DO THIS BEFORE SPEAKING TO THE USER.`;
    }

    const hasContent = Object.values(currentReport).some((val: any) => 
       Array.isArray(val) ? val.length > 0 : (val && val.length > 0 && val !== 'Testaaja' && val !== 'Tester')
    );
    if (hasContent) {
      base += `\n\n--- EXISTING REPORT STATE (JSON) ---\n${JSON.stringify(currentReport, null, 2)}\nResume from here.`;
    }

    return base;
  };

  const updateReportState = useCallback((section: string, content: string) => {
    setReport((prev) => {
      const newReport = { ...prev };
      if (section === 'results') {
        newReport.results = [...prev.results, content];
      } else if (section === 'references') {
         if (!prev.references.includes(content)) {
            newReport.references = [...prev.references, content];
         }
      } else if (['methodology', 'testMaterial', 'theoreticalFramework', 'discussion', 'introduction', 'abstract', 'conclusion', 'testObjectives'].includes(section)) {
         const key = section as 'methodology' | 'testMaterial' | 'theoreticalFramework' | 'discussion' | 'introduction' | 'abstract' | 'conclusion' | 'testObjectives';
         newReport[key] = prev[key] ? `${prev[key]}\n\n${content}` : content;
      } else {
         (newReport as any)[section] = content;
      }
      return newReport;
    });
  }, []);

  const addImageToReport = useCallback((section: string, caption?: string) => {
     if (!pendingPhotoRef.current) return;
     const base64Image = pendingPhotoRef.current;
     const imgHtml = `
       <div class="my-4">
         <img src="data:image/jpeg;base64,${base64Image}" alt="${caption || 'Snapshot'}" style="max-width: 100%; border-radius: 8px; border: 1px solid #ddd;" />
         ${caption ? `<p class="text-sm text-gray-500 mt-1 italic">${caption}</p>` : ''}
       </div>
     `;
     setReport((prev) => {
       const newReport = { ...prev };
       if (section === 'results') {
          newReport.results = [...prev.results, imgHtml];
       } else if (['methodology', 'testMaterial', 'theoreticalFramework', 'discussion', 'introduction', 'testObjectives', 'conclusion'].includes(section)) {
          const key = section as keyof TestReport;
          if (typeof newReport[key] === 'string') {
             (newReport as any)[key] = newReport[key] + imgHtml;
          }
       }
       return newReport;
     });
     pendingPhotoRef.current = null;
  }, []);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        let text = e.target?.result as string;
        if (text.length > 20000) {
            text = text.substring(0, 20000) + "\n\n[...TRUNCATED...]";
        }
        setTestPlan(text);
        setTestTopic(file.name.replace(/\.[^/.]+$/, ""));
      };
      reader.readAsText(file);
    }
  };

  const toggleMute = () => {
    const newState = !isMuted;
    setIsMuted(newState);
    isMutedRef.current = newState;
  };

  const takePhoto = async () => {
    if (!videoRef.current || !videoCanvasRef.current || !sessionRef.current || !isConnectedRef.current) return;
    const video = videoRef.current;
    const canvas = videoCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (ctx && video.videoWidth > 0) {
       canvas.width = video.videoWidth;
       canvas.height = video.videoHeight;
       ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
       canvas.toBlob(async (blob) => {
          if (blob) {
             const base64 = await blobToBase64(blob);
             pendingPhotoRef.current = base64;
             sessionRef.current.then((session: any) => {
                 if (isConnectedRef.current) {
                     try {
                        session.sendRealtimeInput({
                           media: {
                              mimeType: 'image/jpeg',
                              data: base64
                           }
                        });
                     } catch(e) {
                        console.error("Photo send failed", e);
                     }
                 }
             });
          }
       }, 'image/jpeg', 0.8);
    }
  };

  const safeCloseContext = async (ctx: AudioContext | null) => {
    if (ctx && ctx.state !== 'closed') {
        try {
            await Promise.race([
                ctx.close(),
                new Promise(resolve => setTimeout(resolve, 500))
            ]);
        } catch (e) {
            console.warn("Context close error", e);
        }
    }
  };

  const stopSession = useCallback(async () => {
    isUserInitiatedDisconnect.current = true;
    isConnectedRef.current = false;
    
    stopCameraStream();

    if (sessionRef.current) {
       try { 
         const s = await sessionRef.current; 
         // Some versions of the SDK/session might not have a close method or it might throw
         if(s && typeof s.close === 'function') s.close(); 
       } catch(e) { console.warn("Session close warn", e); }
       sessionRef.current = null;
    }
    
    if (processorRef.current) { 
      try { processorRef.current.disconnect(); } catch(e) {}
      processorRef.current = null; 
    }
    if (inputSourceRef.current) { 
      try { inputSourceRef.current.disconnect(); } catch(e) {}
      inputSourceRef.current = null; 
    }
    
    await safeCloseContext(inputAudioContextRef.current);
    inputAudioContextRef.current = null;
    
    await safeCloseContext(outputAudioContextRef.current);
    outputAudioContextRef.current = null;

    activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    activeSourcesRef.current.clear();
    
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsAiSpeaking(false);
    userVolumeRef.current = 0;
    aiVolumeRef.current = 0;
    setIsMuted(false);
    isMutedRef.current = false;
    pendingPhotoRef.current = null;
  }, []);

  const startSession = async () => {
    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED) return;
    
    await stopSession();
    isUserInitiatedDisconnect.current = false;
    // Small buffer time to ensure cleanup is processed
    await new Promise(resolve => setTimeout(resolve, 300));
    setErrorMessage(null);

    try {
      setStatus(ConnectionStatus.CONNECTING);
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
            audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } 
        });
      } catch (err: any) {
        throw new Error(TRANSLATIONS[language].micError);
      }
      
      const inputCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      inputAudioContextRef.current = inputCtx;
      
      const source = inputCtx.createMediaStreamSource(stream);
      inputSourceRef.current = source;
      
      const outputCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      outputAudioContextRef.current = outputCtx;
      
      const outputGain = outputCtx.createGain();
      outputGain.connect(outputCtx.destination);
      outputNodeRef.current = outputGain;

      const systemText = getSystemInstruction(language, testPlan, report);
      const tools = getToolDefinitions(language);

      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-12-2025', 
        callbacks: {
          onopen: async () => {
            console.log('Gemini Live Connected');
            setStatus(ConnectionStatus.CONNECTED);
            setErrorMessage(null);
            isConnectedRef.current = true;
            
            // Resume contexts after connection is established to ensure flow
            try { if (inputCtx.state === 'suspended') await inputCtx.resume(); } catch(e) {}
            try { if (outputCtx.state === 'suspended') await outputCtx.resume(); } catch(e) {}

            const bufferSize = 4096; // Increased buffer size for stability
            const scriptProcessor = inputCtx.createScriptProcessor(bufferSize, 1, 1);
            processorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
              if (!sessionRef.current || !isConnectedRef.current) return;
              const inputData = e.inputBuffer.getChannelData(0);
              
              if (isMutedRef.current) {
                 inputData.fill(0);
                 userVolumeRef.current = 0;
              }

              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              const NOISE_THRESHOLD = 0.01; // Slightly lowered threshold
              
              let pcmBlob;
              if (rms < NOISE_THRESHOLD && !isMutedRef.current) {
                 // Send silence to keep connection alive if needed, or just skip
                 // For Gemini Live, sending silence is often safer than sending nothing
                 const silence = new Float32Array(inputData.length);
                 pcmBlob = createPcmBlob(silence);
                 userVolumeRef.current = 0;
              } else {
                 pcmBlob = createPcmBlob(inputData);
                 if (!isMutedRef.current) userVolumeRef.current = Math.min(1, rms * 5); 
              }

              sessionPromise.then((session) => {
                 try { 
                    if (isConnectedRef.current) {
                        session.sendRealtimeInput({ media: pcmBlob });
                    }
                 } catch (e) {
                    console.error("Send error", e);
                 }
              }).catch(() => {});
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
             if (!isConnectedRef.current) return;
             try {
               if (message.toolCall) {
                  const responses = [];
                  for (const fc of message.toolCall.functionCalls) {
                     if (fc.name === 'updateReport') {
                        const { section, content } = fc.args as any;
                        updateReportState(section, content);
                        responses.push({ id: fc.id, name: fc.name, response: { result: 'OK' } });
                     } else if (fc.name === 'addImageToReport') {
                        const { section, caption } = fc.args as any;
                        addImageToReport(section, caption);
                        responses.push({ id: fc.id, name: fc.name, response: { result: 'OK' } });
                     }
                  }
                  if (responses.length > 0) {
                     sessionPromise.then(session => {
                        if (isConnectedRef.current) session.sendToolResponse({ functionResponses: responses });
                     });
                  }
               }
               const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
               if (base64Audio) {
                  if (outputCtx.state === 'suspended') await outputCtx.resume();
                  setIsAiSpeaking(true);
                  aiVolumeRef.current = Math.random() * 0.5 + 0.3; // Simulating volume for visualizer
                  
                  nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
                  const audioBytes = base64ToUint8Array(base64Audio);
                  const audioBuffer = await convertPCMToAudioBuffer(audioBytes, outputCtx, 24000, 1);
                  
                  if (!isConnectedRef.current) return;
                  const sourceNode = outputCtx.createBufferSource();
                  sourceNode.buffer = audioBuffer;
                  sourceNode.connect(outputGain);
                  sourceNode.addEventListener('ended', () => {
                     activeSourcesRef.current.delete(sourceNode);
                     if (activeSourcesRef.current.size === 0) {
                        setIsAiSpeaking(false);
                        aiVolumeRef.current = 0;
                     }
                  });
                  sourceNode.start(nextStartTimeRef.current);
                  nextStartTimeRef.current += audioBuffer.duration;
                  activeSourcesRef.current.add(sourceNode);
               }
               if (message.serverContent?.interrupted) {
                  activeSourcesRef.current.forEach(s => s.stop());
                  activeSourcesRef.current.clear();
                  nextStartTimeRef.current = 0;
                  setIsAiSpeaking(false);
                  aiVolumeRef.current = 0;
               }
             } catch (err) { console.error(err); }
          },
          onclose: () => {
             isConnectedRef.current = false;
             setStatus(ConnectionStatus.DISCONNECTED);
             if (!isUserInitiatedDisconnect.current) {
                setErrorMessage(language === 'fi' ? "Yhteys katkesi odottamatta." : "Connection lost unexpectedly.");
                setStatus(ConnectionStatus.ERROR);
             }
          },
          onerror: (err: any) => {
             isConnectedRef.current = false;
             setStatus(ConnectionStatus.ERROR);
             setErrorMessage(TRANSLATIONS[language].connError);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' } 
            }
          },
          systemInstruction: systemText, 
          tools: [{ functionDeclarations: tools }],
        }
      };

      const sessionPromise = ai.live.connect(config);
      sessionRef.current = sessionPromise;

    } catch (error: any) {
      console.error("Connection failed", error);
      setStatus(ConnectionStatus.ERROR);
      setErrorMessage(error.message || TRANSLATIONS[language].connError);
      stopSession();
    }
  };

  const toggleCamera = async () => {
    if (status === ConnectionStatus.CONNECTING) return;
    setErrorMessage(null);
    if (status !== ConnectionStatus.CONNECTED) {
       await startSession();
       if (sessionRef.current) setTimeout(() => startCameraStream(), 1000); 
    } else {
       if (isCameraOn) stopCameraStream(); else startCameraStream();
    }
  };

  const startCameraStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      videoStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setIsCameraOn(true);
      if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = window.setInterval(async () => {
        if (videoRef.current && videoCanvasRef.current && sessionRef.current && isConnectedRef.current) {
          const canvas = videoCanvasRef.current;
          const video = videoRef.current;
          const ctx = canvas.getContext('2d');
          if (ctx && video.videoWidth > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(async (blob) => {
              if (blob) {
                const base64 = await blobToBase64(blob);
                sessionRef.current.then((session: any) => {
                  try { if(isConnectedRef.current) session.sendRealtimeInput({ media: { mimeType: 'image/jpeg', data: base64 } }); } catch (e) {}
                });
              }
            }, 'image/jpeg', 0.6);
          }
        }
      }, 1000);
    } catch (err: any) {
      setErrorMessage(TRANSLATIONS[language].cameraError);
    }
  };

  const stopCameraStream = () => {
    if (frameIntervalRef.current) { clearInterval(frameIntervalRef.current); frameIntervalRef.current = null; }
    if (videoStreamRef.current) { videoStreamRef.current.getTracks().forEach(track => track.stop()); videoStreamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsCameraOn(false);
  };

  const downloadReport = () => {
    const filename = `${report.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'report'}.html`;
    const t = TRANSLATIONS[language].sections;
    
    const htmlContent = `
      <!DOCTYPE html>
      <html lang="${language}">
      <head>
        <meta charset="UTF-8">
        <title>${report.title}</title>
        <style>
          body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 4rem 2rem; line-height: 1.6; color: #1a1a1a; background: #f9fafb; }
          .container { background: white; padding: 3rem; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); border-radius: 8px; }
          h1 { border-bottom: 2px solid #eee; padding-bottom: 0.5rem; color: #111; margin-bottom: 0.5rem; }
          h2 { margin-top: 2.5rem; color: #2563eb; border-bottom: 1px solid #eee; padding-bottom: 0.25rem; }
          h3 { margin-top: 1.5rem; color: #4b5563; font-size: 1.1em; }
          .meta { color: #666; font-style: italic; margin-bottom: 3rem; }
          .section { margin-bottom: 1.5rem; }
          ul { padding-left: 1.5rem; }
          li { margin-bottom: 0.5rem; }
          .empty { color: #9ca3af; font-style: italic; }
          img { max-width: 100%; height: auto; display: block; margin: 1rem 0; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>${report.title || 'Untitled Test'}</h1>
          <div class="meta">
            <p><strong>${report.author}</strong> | ${report.date}</p>
          </div>
          <div class="section"><h2>${t.abstract}</h2><div>${report.abstract || '<span class="empty">-</span>'}</div></div>
          <div class="section">
            <h2>${t[2]}</h2>
            <h3>${t.intro}</h3><div>${report.introduction || '<span class="empty">-</span>'}</div>
            <h3>${t.objectives}</h3><div>${report.testObjectives || '<span class="empty">-</span>'}</div>
            ${report.theoreticalFramework ? `<h3>${t.theory}</h3><div>${report.theoreticalFramework}</div>` : ''}
          </div>
          <div class="section">
            <h2>${t[3]}</h2>
            ${report.testMaterial ? `<h3>${t.material}</h3><div>${report.testMaterial}</div>` : ''}
            <h3>${t.methods}</h3><div>${report.methodology || '<span class="empty">-</span>'}</div>
          </div>
          <div class="section">
            <h2>${t[4]}</h2>
            <h3>${t.results}</h3>
            ${report.results.length > 0 ? `<ul>${report.results.map(r => `<li>${r}</li>`).join('')}</ul>` : '<p class="empty">-</p>'}
            ${report.discussion ? `<h3>${t.discussion}</h3><div>${report.discussion}</div>` : ''}
          </div>
          <div class="section">
            <h2>${t[5]}</h2>
            <h3>${t.conclusion}</h3><div>${report.conclusion || '<span class="empty">-</span>'}</div>
            ${report.references.length > 0 ? `<h3>${t.references}</h3><ul>${report.references.map(r => `<li>${r}</li>`).join('')}</ul>` : ''}
          </div>
        </div>
      </body>
      </html>
    `;
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const t = TRANSLATIONS[language];

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col md:flex-row overflow-hidden">
      <canvas ref={videoCanvasRef} className="hidden" />
      <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".txt,.md" className="hidden" />

      {/* LEFT PANEL: Interaction Area */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 relative">
        <div className="absolute top-6 left-6 z-10">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-teal-400 to-blue-500 bg-clip-text text-transparent">{t.appTitle}</h1>
        </div>

        {/* TOP RIGHT: Status & Language */}
        <div className="absolute top-6 right-6 flex items-center gap-4 z-50">
           {/* Language Selector */}
           <div className="bg-slate-800 rounded-lg p-1 border border-slate-700 flex">
             <button onClick={() => setLanguage('fi')} className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${language === 'fi' ? 'bg-teal-500 text-white' : 'text-slate-400 hover:text-white'}`}>FI</button>
             <button onClick={() => setLanguage('en')} className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${language === 'en' ? 'bg-teal-500 text-white' : 'text-slate-400 hover:text-white'}`}>EN</button>
           </div>
           
           <div className="flex items-center gap-2">
            <div className={`h-3 w-3 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : status === ConnectionStatus.ERROR ? 'bg-red-500' : 'bg-slate-600'}`} />
            <span className="text-xs font-mono text-slate-400 uppercase">
                {status === ConnectionStatus.CONNECTED ? t.status.live : status === ConnectionStatus.ERROR ? t.status.error : t.status.offline}
            </span>
           </div>
        </div>

        <div className="w-full max-w-lg flex flex-col items-center gap-10 z-0">
          <div className="relative w-[300px] h-[300px] md:w-[350px] md:h-[350px] flex items-center justify-center">
             <div className={`absolute inset-4 rounded-full overflow-hidden z-10 bg-black transition-opacity duration-500 ${isCameraOn ? 'opacity-100' : 'opacity-0'}`}>
                <video ref={videoRef} className="w-full h-full object-cover transform scale-x-[-1]" muted playsInline />
                {isCameraOn && status === ConnectionStatus.CONNECTED && (
                  <div className="absolute bottom-4 left-0 right-0 flex justify-center z-20">
                     <button onClick={takePhoto} className="bg-white/20 hover:bg-white/40 border-2 border-white text-white p-3 rounded-full backdrop-blur-sm transition-all transform hover:scale-105 active:scale-95 shadow-lg">
                       <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="size-6">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
                        </svg>
                     </button>
                  </div>
                )}
             </div>
             <div className="absolute inset-0 z-20 pointer-events-none">
                <Visualizer isActive={status === ConnectionStatus.CONNECTED} isAiSpeaking={isAiSpeaking} isVideoMode={isCameraOn} userVolume={visualizerState.userVolume} aiVolume={visualizerState.aiVolume} />
             </div>
             {status === ConnectionStatus.DISCONNECTED && !errorMessage && (
               <div className="absolute z-30 text-slate-600">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor" className="size-24 opacity-20"><path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" /></svg>
               </div>
             )}
          </div>

          <div className="w-full flex flex-col gap-6">
             {errorMessage && (
                 <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl text-center text-sm animate-fade-in">{errorMessage}</div>
             )}
             
             {testPlan && status === ConnectionStatus.DISCONNECTED && (
                <div className="bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 px-4 py-2 rounded-xl text-sm text-center flex items-center justify-center gap-2 animate-fade-in">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-4"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
                    <span>{t.planReady}</span>
                </div>
             )}

             {status === ConnectionStatus.DISCONNECTED && (
               <div className="animate-fade-in-up w-full flex flex-col gap-3">
                   <div className="flex gap-2">
                     <input ref={topicInputRef} type="text" placeholder={t.placeholder} className="flex-1 bg-slate-800/80 border border-slate-700 rounded-xl px-5 py-4 text-white text-center focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all placeholder-slate-500" value={testTopic} onChange={(e) => setTestTopic(e.target.value)} />
                   </div>
                   <button onClick={() => fileInputRef.current?.click()} className="text-xs text-slate-400 hover:text-white underline underline-offset-4 decoration-slate-600 hover:decoration-white transition-all text-center">
                      {testPlan ? t.changeFileBtn : t.uploadBtn}
                   </button>
               </div>
             )}
             
             <div className="flex flex-row gap-4 justify-center w-full">
                {status === ConnectionStatus.DISCONNECTED || status === ConnectionStatus.ERROR ? (
                  <button onClick={startSession} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 px-6 rounded-2xl shadow-lg shadow-blue-900/30 transition-all flex items-center justify-center gap-3">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="size-6"><path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" /></svg>
                    <span>{status === ConnectionStatus.ERROR ? t.retryBtn : (testPlan ? t.connectBtn : t.startBtn)}</span>
                  </button>
                ) : (
                  <>
                     <button onClick={toggleMute} className={`flex-1 font-bold py-4 px-6 rounded-2xl shadow-lg transition-all flex flex-col items-center justify-center gap-1 ${isMuted ? 'bg-amber-500/20 text-amber-500 border border-amber-500/50' : 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700'}`}>
                        {isMuted ? ( <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="size-6"><path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" /></svg> ) : ( <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="size-6"><path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" /></svg> )}
                        <span className="text-sm">{isMuted ? t.muteOn : t.muteOff}</span>
                     </button>
                     <button onClick={stopSession} className="bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/30 font-semibold py-4 px-6 rounded-2xl transition-all flex flex-col items-center justify-center gap-1 min-w-[100px]">
                        <div className="h-4 w-4 bg-red-500 rounded-sm mb-1" />
                        <span className="text-xs uppercase tracking-wide">{t.stopBtn}</span>
                     </button>
                  </>
                )}
                <button onClick={toggleCamera} className={`flex-1 font-bold py-4 px-6 rounded-2xl shadow-lg transition-all flex flex-col items-center justify-center gap-1 ${isCameraOn ? 'bg-white text-slate-900 shadow-white/10' : 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700'}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" fill={isCameraOn ? "currentColor" : "none"} viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="size-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M12 18.75H4.5a2.25 2.25 0 0 1-2.25-2.25V9m12.841 9.091L16.5 19.5m-1.409-1.409c.407-.407.659-.97.659-1.591v-9a2.25 2.25 0 0 0-2.25-2.25h-9c-.621 0-1.184.252-1.591.659m12.182 12.182L2.909 5.909" /></svg>
                  <span className="text-sm">{isCameraOn ? t.cameraOn : t.cameraOff}</span>
                </button>
             </div>

             <p className="text-slate-500 text-xs text-center">{isAiSpeaking ? t.analyzing : status === ConnectionStatus.CONNECTED ? (isMuted ? t.mutedMsg : (testPlan ? t.planReady : t.listening)) : errorMessage ? errorMessage : (testPlan ? t.planReady : t.readyMsg)}</p>
          </div>
        </div>
      </div>

      {/* RIGHT PANEL: Structured Report */}
      <div ref={reportContainerRef} className="w-full md:w-[500px] bg-slate-900 border-l border-slate-800 flex flex-col h-[40vh] md:h-screen overflow-hidden">
         <div className="p-4 border-b border-slate-800 bg-slate-900/90 backdrop-blur flex items-center justify-between sticky top-0 z-20">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-5 text-teal-400"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
              {language === 'fi' ? 'Testiraportti' : 'Test Report'}
            </h2>
            <div className="flex items-center gap-2">
              <button onClick={downloadReport} className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors border border-slate-700">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                {t.saveReport}
              </button>
            </div>
         </div>

         <div className="flex-1 overflow-y-auto p-6 scrollbar-thin space-y-8">
            <div className="space-y-4">
               <div className="text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-800 pb-1 mb-3">{t.sections[1]}</div>
               <div className="text-center py-4 bg-slate-800/30 rounded-xl border border-slate-800">
                  <div className="text-xl font-bold text-white mb-1">{report.title || (language === 'fi' ? 'Nimetön Testi' : 'Untitled Test')}</div>
                  <div className="text-sm text-slate-400">{report.author} • {report.date}</div>
               </div>
               <div>
                 <label className="text-xs text-slate-400 font-semibold mb-1 block">{t.sections.abstract}</label>
                 <div className="bg-slate-800/50 p-3 rounded-lg text-slate-300 text-xs leading-relaxed italic border border-slate-800 whitespace-pre-wrap"><HtmlContent html={report.abstract || t.sections.noData} /></div>
               </div>
            </div>

            <div className="space-y-4">
               <div className="text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-800 pb-1 mb-3">{t.sections[2]}</div>
               <div><h3 className="text-sm font-semibold text-teal-400 mb-1">{t.sections.intro}</h3><div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap"><HtmlContent html={report.introduction || t.sections.noData} /></div></div>
               <div><h3 className="text-sm font-semibold text-teal-400 mb-1">{t.sections.objectives}</h3><div className="text-sm text-slate-300 leading-relaxed bg-teal-900/10 p-2 rounded border-l-2 border-teal-500 whitespace-pre-wrap"><HtmlContent html={report.testObjectives || t.sections.noData} /></div></div>
               {report.theoreticalFramework && (<div><h3 className="text-sm font-semibold text-teal-400 mb-1">{t.sections.theory}</h3><div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap"><HtmlContent html={report.theoreticalFramework} /></div></div>)}
            </div>

            <div className="space-y-4">
               <div className="text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-800 pb-1 mb-3">{t.sections[3]}</div>
               {report.testMaterial && (<div><h3 className="text-sm font-semibold text-indigo-400 mb-1">{t.sections.material}</h3><div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap"><HtmlContent html={report.testMaterial} /></div></div>)}
               <div><h3 className="text-sm font-semibold text-indigo-400 mb-1">{t.sections.methods}</h3><div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap"><HtmlContent html={report.methodology || t.sections.noData} /></div></div>
            </div>

            <div className="space-y-4">
               <div className="text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-800 pb-1 mb-3">{t.sections[4]}</div>
               <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-emerald-400">{t.sections.results}</h3>
                    <span className="text-[10px] bg-slate-800 px-2 rounded-full text-slate-400">{report.results.length} {t.sections.observations}</span>
                  </div>
                  <div className="space-y-2">
                    {report.results.length === 0 ? <p className="text-sm text-slate-500 italic">{t.sections.noData}</p> : 
                      report.results.map((res, i) => <div key={i} className="bg-slate-800 p-2 rounded text-sm text-slate-200 border-l-2 border-emerald-500 whitespace-pre-wrap"><HtmlContent html={res} /></div>)
                    }
                  </div>
               </div>
               {report.discussion && (<div className="mt-4"><h3 className="text-sm font-semibold text-emerald-400 mb-1">{t.sections.discussion}</h3><div className="text-sm text-slate-300 leading-relaxed bg-emerald-900/10 p-3 rounded whitespace-pre-wrap"><HtmlContent html={report.discussion} /></div></div>)}
            </div>

            <div className="space-y-4 pb-10">
               <div className="text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-800 pb-1 mb-3">{t.sections[5]}</div>
               <div><h3 className="text-sm font-semibold text-blue-400 mb-1">{t.sections.conclusion}</h3><div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap"><HtmlContent html={report.conclusion || t.sections.noData} /></div></div>
               {report.references.length > 0 && (<div><h3 className="text-sm font-semibold text-blue-400 mb-1">{t.sections.references}</h3><ul className="list-disc list-inside text-sm text-slate-300 pl-2 whitespace-pre-wrap">{report.references.map((ref, i) => <li key={i}><HtmlContent html={ref} /></li>)}</ul></div>)}
            </div>

         </div>
      </div>
    </div>
  );
};

export default App;