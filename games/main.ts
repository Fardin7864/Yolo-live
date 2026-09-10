import Phaser from 'phaser';
import { greedyLionScenes } from './greedy-lion/main';
import { greedyProScenes } from './greedy-pro/main';
import { teenPattiScenes } from './teen-patti/main';
import { luckyDiceScenes } from './lucky-dice/main';
import { crashScenes } from './crash/main';
import type { GameId } from './shared/types';
import { PerformanceManager } from './shared/PerformanceManager';
import { sdk, waitForBootstrap } from './shared/GameSDK';

let game: Phaser.Game | null = null;
let performanceManager: PerformanceManager | null = null;
let appActive = true;
let screenFocused = true;
let awaitingFreshState = false;

const pauseGame = () => {
  game?.sound.pauseAll();
  game?.loop.sleep();
};

const synchronizeBeforeResume = (reason: string) => {
  if (!appActive || !screenFocused) return;
  awaitingFreshState = true;
  sdk.requestRefresh(reason);
};

sdk.onMessage('APP_BACKGROUND', () => {
  appActive = false;
  pauseGame();
});
sdk.onMessage('SCREEN_BLUR', () => {
  screenFocused = false;
  pauseGame();
});
sdk.onMessage('APP_ACTIVE', () => {
  appActive = true;
  synchronizeBeforeResume('app-foreground');
});
sdk.onMessage('SCREEN_FOCUS', () => {
  screenFocused = true;
  synchronizeBeforeResume('screen-focus');
});
sdk.onMessage('ROUND_STATE', () => {
  if (!awaitingFreshState || !appActive || !screenFocused || !game) return;
  awaitingFreshState = false;
  game.loop.wake();
  game.sound.resumeAll();
});
sdk.onMessage('CRASH_STATE', () => {
  if (!awaitingFreshState || !appActive || !screenFocused || !game) return;
  awaitingFreshState = false;
  game.loop.wake();
  game.sound.resumeAll();
});
sdk.onMessage('EXIT_GAME', () => {
  performanceManager?.destroy();
  game?.destroy(true, false);
  game = null;
  sdk.destroy();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseGame();
  else synchronizeBeforeResume('document-visible');
});

void waitForBootstrap().then((bootstrap) => {
  const sceneRegistry: Record<GameId, Phaser.Types.Scenes.SceneType[]> = {
    greedy_lion: greedyLionScenes,
    greedy_pro: greedyProScenes,
    tin_patti_pro: teenPattiScenes,
    lucky_dice: luckyDiceScenes,
    crash: crashScenes,
  };
  const scenes = sceneRegistry[bootstrap.gameId];
  const embedded = window.__GAME_EMBEDDED__ === true;
  // Embedded games are full-width inside a live sheet. Below 620 logical
  // pixels the circular Greedy King layout and the vertical chip rail cannot
  // fit without clipping or overlap (most visibly on tablets). FIT will
  // letterbox unusually short viewports instead of deforming the scene.
  const gameHeight = embedded
    ? Phaser.Math.Clamp(Math.round(540 * window.innerHeight / Math.max(1, window.innerWidth)), 620, 900)
    : 960;
  const gameWidth = bootstrap.gameId === 'crash' && embedded
    ? Phaser.Math.Clamp(Math.round(gameHeight * window.innerWidth / Math.max(1, window.innerHeight)), 540, 1100)
    : 540;
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-root',
    backgroundColor: '#090B18',
    width: gameWidth,
    height: gameHeight,
    fps: {
      target: bootstrap.targetFps,
      min: 20,
      smoothStep: true,
    },
    render: {
      antialias: true,
      pixelArt: false,
      roundPixels: true,
      powerPreference: 'low-power',
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: gameWidth,
      height: gameHeight,
    },
    audio: { disableWebAudio: true, noAudio: false },
    scene: scenes,
    banner: false,
  });
  performanceManager = new PerformanceManager(game, sdk, bootstrap.debug);
  const canvas = game.canvas;
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    sdk.send('ERROR', { code: 'WEBGL_CONTEXT_LOST', message: 'Graphics context was lost.', fatal: false });
  });
  canvas.addEventListener('webglcontextrestored', () => sdk.requestRefresh('webgl-context-restored'));
}).catch((error) => {
  sdk.send('ERROR', {
    code: 'GAME_INITIALIZATION',
    message: error instanceof Error ? error.message : 'Could not initialize game.',
    fatal: true,
  });
});
