export interface TestReport {
  // 1. Alkuosat / Front Matter
  title: string;
  author: string;
  date: string;
  abstract: string; // Tiivistelmä / Abstract

  // 2. Johdanto ja tausta / Introduction & Background
  introduction: string; 
  testObjectives: string; // Testin tavoitteet / Objectives
  theoreticalFramework: string; // Teoreettinen viitekehys / Theoretical Framework

  // 3. Menetelmät / Methodology
  testMaterial: string; // Testimateriaali / Materials
  methodology: string; // Testausmenetelmät / Methods

  // 4. Tulokset ja pohdinta / Results & Discussion
  results: string[]; 
  discussion: string; 

  // 5. Loppuosat / End Matter
  conclusion: string; // Johtopäätökset / Conclusion
  references: string[]; // Lähdeluettelo / References
}

export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export interface AudioVisualizerData {
  userVolume: number;
  aiVolume: number;
}

export type Language = 'fi' | 'en';