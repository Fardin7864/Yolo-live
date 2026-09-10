import { AppState, type AppStateStatus } from 'react-native';
import type { NativeGameBridge } from './GameBridge';

export class GameLifecycle {
  private active = AppState.currentState === 'active';
  private focused = false;
  private subscription: ReturnType<typeof AppState.addEventListener> | null = null;

  constructor(
    private readonly bridge: NativeGameBridge,
    private readonly onResume: (reason: string) => void,
    private readonly onPause: () => void,
  ) {}

  start() {
    this.subscription = AppState.addEventListener('change', this.handleAppState);
  }

  stop() {
    this.subscription?.remove();
    this.subscription = null;
  }

  setFocused(focused: boolean) {
    if (this.focused === focused) return;
    this.focused = focused;
    this.bridge.send(focused ? 'SCREEN_FOCUS' : 'SCREEN_BLUR', {});
    if (focused && this.active) this.onResume('screen-focus');
    else this.onPause();
  }

  private handleAppState = (status: AppStateStatus) => {
    const active = status === 'active';
    if (active === this.active) return;
    this.active = active;
    this.bridge.send(active ? 'APP_ACTIVE' : 'APP_BACKGROUND', {});
    if (active && this.focused) this.onResume('app-foreground');
    else this.onPause();
  };
}
