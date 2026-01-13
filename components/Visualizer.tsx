import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  isAiSpeaking: boolean;
  isVideoMode: boolean; // New prop to handle video overlay
  userVolume: number; // 0 to 1 normalized
  aiVolume: number; // 0 to 1 normalized
}

export const Visualizer: React.FC<VisualizerProps> = ({ isActive, isAiSpeaking, isVideoMode, userVolume, aiVolume }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let time = 0;

    const draw = () => {
      if (!ctx || !canvas) return;
      
      const width = canvas.width;
      const height = canvas.height;
      const centerX = width / 2;
      const centerY = height / 2;

      ctx.clearRect(0, 0, width, height);

      // Base circle radius
      const baseRadius = 80;
      
      // Determine active volume and color
      const activeVolume = isAiSpeaking ? aiVolume : userVolume;
      const intensity = isActive ? Math.max(0.1, activeVolume) : 0.05;
      
      // Setup colors based on state
      let strokeColor = '#94a3b8'; // Default Gray
      if (isActive) {
        if (isAiSpeaking) {
           strokeColor = '#22d3ee'; // Cyan (AI)
        } else {
           strokeColor = '#34d399'; // Emerald (User)
        }
      }

      // If NOT in video mode, draw the center fill/glow. 
      // If in video mode, leave center transparent for the video element.
      if (!isVideoMode) {
        const gradient = ctx.createRadialGradient(centerX, centerY, baseRadius * 0.5, centerX, centerY, baseRadius * 3);
        if (isActive) {
          if (isAiSpeaking) {
            gradient.addColorStop(0, 'rgba(34, 211, 238, 0.4)');
            gradient.addColorStop(0.5, 'rgba(14, 165, 233, 0.1)');
            gradient.addColorStop(1, 'rgba(14, 165, 233, 0)');
          } else {
            gradient.addColorStop(0, 'rgba(52, 211, 153, 0.4)');
            gradient.addColorStop(0.5, 'rgba(16, 185, 129, 0.1)');
            gradient.addColorStop(1, 'rgba(16, 185, 129, 0)');
          }
        } else {
          gradient.addColorStop(0, 'rgba(148, 163, 184, 0.2)');
          gradient.addColorStop(1, 'rgba(148, 163, 184, 0)');
        }
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius * 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw Dynamic Waveform Circles (The "Rings" around the center)
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 4;
      
      // Draw 2 rings for cooler effect
      for (let j = 0; j < 2; j++) {
        ctx.beginPath();
        const numPoints = 100;
        const ringOffset = j * 10;
        
        for (let i = 0; i <= numPoints; i++) {
          const angle = (i / numPoints) * Math.PI * 2;
          
          // Wave calculations
          const wave = Math.sin(angle * 6 + time + j) * 10 * intensity;
          const wave2 = Math.cos(angle * 3 - time * 2) * 10 * intensity;
          
          // Expansion based on volume
          const expansion = intensity * (50 + ringOffset); 
          
          // If video mode, ensure radius is large enough to frame the video
          const effectiveBaseRadius = isVideoMode ? baseRadius + 40 : baseRadius; 

          const r = effectiveBaseRadius + wave + wave2 + expansion;
          const x = centerX + Math.cos(angle) * r;
          const y = centerY + Math.sin(angle) * r;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.closePath();
        ctx.stroke();
      }

      time += 0.05;
      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [isActive, isAiSpeaking, isVideoMode, userVolume, aiVolume]);

  return (
    <canvas 
      ref={canvasRef} 
      width={500} // Increased resolution for larger rings
      height={500} 
      className="w-full h-full pointer-events-none" // Ensure clicks pass through if needed
    />
  );
};