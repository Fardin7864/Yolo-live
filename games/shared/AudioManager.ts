export class AudioManager {
  private context: AudioContext | null = null;
  private enabled = true;
  private volume = 0.8;

  configure(enabled: boolean, volume: number) {
    this.enabled = enabled;
    this.volume = Math.max(0, Math.min(1, volume));
    if (!enabled) void this.context?.suspend();
  }

  toggle() {
    this.configure(!this.enabled, this.volume);
    if (this.enabled) this.resume();
    return this.enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  resume() {
    if (this.enabled) void this.context?.resume();
  }

  pause() {
    void this.context?.suspend();
  }

  play(kind: 'bet' | 'tick' | 'card' | 'win' | 'lock') {
    if (!this.enabled) return;
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;
    this.context ||= new AudioContextCtor();
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    const frequencies = { bet: 420, tick: 610, card: 280, win: 760, lock: 820 };
    oscillator.frequency.setValueAtTime(frequencies[kind], now);
    if (kind === 'win') oscillator.frequency.exponentialRampToValueAtTime(1180, now + 0.24);
    if (kind === 'lock') oscillator.frequency.exponentialRampToValueAtTime(310, now + 0.28);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, this.volume * 0.12), now + 0.012);
    const duration = kind === 'win' ? 0.32 : kind === 'lock' ? 0.34 : 0.1;
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  destroy() {
    void this.context?.close();
    this.context = null;
  }
}
