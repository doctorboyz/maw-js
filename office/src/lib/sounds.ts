// Sound effects for Oracle Office

const sounds = [
  "/office/saiyan.mp3",
  "/office/saiyan-aura.mp3",
  "/office/saiyan-rose.mp3",
  "/office/saiyan-2.mp3",
];

const MAX_PLAY = 3; // seconds before fade-out starts
const FADE_MS = 1500; // fade-out duration

// Audio context — unlocked by user interaction
let audioCtx: AudioContext | null = null;
let unlocked = false;

/** Generate a short tick sound via Web Audio API */
function playTick() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 1200;
  osc.type = "sine";
  gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.08);
}

/** Unlock audio on first user click/tap — plays a small tick so human knows sound is on */
export function unlockAudio() {
  if (unlocked) return;
  try {
    audioCtx = new AudioContext();
    // Resume if suspended (browser autoplay policy)
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    playTick();
    unlocked = true;
  } catch {}
}

/** Check if audio has been unlocked */
export function isAudioUnlocked() {
  return unlocked;
}

/** Play a random super saiyan sound with auto fade-out */
export function playSaiyanSound() {
  if (!unlocked) return; // don't attempt before user interaction
  try {
    const src = sounds[Math.floor(Math.random() * sounds.length)];
    const audio = new Audio(src);
    audio.volume = 0.3;
    audio.play().catch(() => {});

    // Start fade-out after MAX_PLAY seconds
    setTimeout(() => {
      const startVol = audio.volume;
      const steps = 30;
      const stepMs = FADE_MS / steps;
      let step = 0;
      const fade = setInterval(() => {
        step++;
        audio.volume = Math.max(0, startVol * (1 - step / steps));
        if (step >= steps) {
          clearInterval(fade);
          audio.pause();
        }
      }, stepMs);
    }, MAX_PLAY * 1000);
  } catch {}
}
